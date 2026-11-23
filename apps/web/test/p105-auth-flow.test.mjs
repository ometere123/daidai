// P10.5 authenticated read-only flow (S2, S3, S4, U1, U2): one `next build`, then `next start` with env variants against a
// fake, signature-verifying contract server (invitations, sessions, list, authoritative detail). Only 127.0.0.1; no wallet, no RPC.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chain, cngn, commit, usdt } from '../../../src/invoice.ts';
import { attest } from '../../../src/evidence-attestation.ts';
import { readAuthoritativeInvoice } from '../../../src/authoritative-invoice.ts';
import { parseResponse, parseSessionBody, parseSessionOrListResponse, errorBody, VIEWER_HEADER, responseHeaders } from '../../../src/api-contract.ts';
import { verifyRequest, NonceWindow } from '../../../src/service-auth.ts';
import { appEnabled } from '../lib/app-gate.ts';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const KEY_ID = 'p105-test';
const KEY = 'test-only-service-key-' + 'z'.repeat(24);
const COOKIE = '__Host-daidai_session';
const ID = 'invoice-a';
const code = () => randomBytes(32).toString('base64url');

async function projection() {
  const nowMs = Date.now();
  const recipient = '0x' + '22'.repeat(20), taker = '0x' + '33'.repeat(20), approver = '0x' + '44'.repeat(20);
  const invoice = { id: ID, version: 1, source: 'invoice-source', nonce: '12'.repeat(16), chain, sell: usdt, sellDecimals: 6, buy: cngn,
    buyDecimals: 6, buyAmount: '1500000000', recipient, maxSell: '1200000', approver, taker, expires: nowMs + 3_600_000 };
  const digest = commit(invoice).digest;
  const c = { tenantId: 'tenant-a', invoiceId: ID, digest };
  const fp = { digest, approvalSigner: approver, consentSigner: recipient, expiresAtMs: invoice.expires };
  const ports = {
    authorize: async () => ({ tenantId: c.tenantId, invoiceId: ID }),
    readInvoice: async () => attest({ source: 'invoice-store', tenantId: c.tenantId, invoice, digest, revision: 7, observedAtMs: nowMs }),
    observeAuthorization: async (_, purpose) => attest({ source: 'authorization-verifier', ...c, purpose,
      signer: purpose === 'invoice approval' ? approver : recipient, audience: 'https://daidai.example', expiresAtMs: invoice.expires, observedAtMs: nowMs }),
    readAttempts: async (_, operation) => [attest({ source: 'attempt-store', ...c, operation, id: operation + '-a', lineage: 'recorded',
      recordedRevision: 7, authorization: fp, envelope: { chainId: chain, to: cngn, dataSha256: 'ab'.repeat(32), value: '0' },
      hash: '0x' + (operation === 'conversion' ? '55' : '66').repeat(32), dispatch: 'hash-recorded', closed: null, createdAtMs: nowMs - 100, history: [] })],
    observeTransaction: async () => null,
    observeCanonicalBlock: async () => null,
  };
  const p = await readAuthoritativeInvoice({ viewer: 'v', invoiceId: ID }, ports, { nowMs, maxObservationAgeMs: 600_000, expectedAudience: 'https://daidai.example' });
  assert(p, 'projection built');
  return JSON.parse(JSON.stringify(p));
}

// ---- fake Worker ----
let fake, fakeUrl, wire, browser;
const nonces = new NonceWindow();
const invitations = new Map(); // code -> used
const sessions = new Map(); // token -> { expiresAtMs, lastMs, idleMs, revoked }
const log = [];
const issueInvitation = () => { const c = code(); invitations.set(c, false); return c; };
const liveSession = t => { const s = sessions.get(t); const now = Date.now();
  if (!s || s.revoked || now >= s.expiresAtMs || now - s.lastMs > s.idleMs) return false; s.lastMs = now; return true; };

function startFake() {
  return new Promise(resolve => {
    fake = createServer(async (req, res) => {
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (status, b) => { res.writeHead(status, responseHeaders); res.end(JSON.stringify(b)); };
      const headers = new Headers(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const viewerToken = headers.get(VIEWER_HEADER) ?? '';
      log.push({ method: req.method, path: req.url, origin: headers.get('origin'), cookie: headers.get('cookie') });
      const ok = await verifyRequest({ keys: { [KEY_ID]: KEY }, headers, method: req.method, path: req.url, body, viewerToken, nowMs: Date.now(), nonces });
      if (!ok || headers.get('origin')) return send(401, errorBody('unauthenticated-service'));
      if (req.method === 'POST' && req.url === '/v1/sessions') {
        const parsed = parseSessionBody(body);
        if (!parsed || invitations.get(parsed.invitation) !== false) return send(403, errorBody('invalid-credentials'));
        invitations.set(parsed.invitation, true);
        const token = code(); const now = Date.now();
        sessions.set(token, { expiresAtMs: now + 12 * 3600_000, lastMs: now, idleMs: 30 * 60_000, revoked: false });
        return send(200, { apiVersion: 'v1', kind: 'session', token, expiresAtMs: now + 12 * 3600_000, idleTimeoutMs: 30 * 60_000 });
      }
      if (!liveSession(viewerToken)) return send(404, errorBody('not-found-or-forbidden'));
      if (req.method === 'DELETE' && req.url === '/v1/sessions/current') { sessions.get(viewerToken).revoked = true; return send(200, { apiVersion: 'v1', kind: 'revoked' }); }
      if (req.method === 'GET' && req.url === '/v1/invoices') {
        return send(200, { apiVersion: 'v1', kind: 'invoice-list', invoices: [{ id: ID, revision: wire.revision, targetAtomic: wire.targetAtomic, maxDebitAtomic: wire.maxDebitAtomic }] });
      }
      if (req.method === 'GET' && req.url === '/v1/invoices/' + ID + '/authoritative') return send(200, { apiVersion: 'v1', kind: 'authoritative-invoice', invoice: wire });
      return send(404, errorBody('not-found-or-forbidden'));
    }).listen(0, '127.0.0.1', () => { fakeUrl = 'http://127.0.0.1:' + fake.address().port; resolve(); });
  });
}

// ---- next ----
const nextBin = join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const freePort = () => new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startNext(env) {
  const port = await freePort();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAIDAI_') && k !== 'VERCEL_ENV' && k !== 'NODE_ENV'));
  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: webRoot,
    env: { ...clean, DAIDAI_API_BASE_URL: fakeUrl, DAIDAI_SERVICE_KEY_ID: KEY_ID, DAIDAI_SERVICE_KEY: KEY, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/manifest.webmanifest'); return { base, stop: () => child.kill(), log: () => out }; } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  child.kill(); throw Error('next start did not come up: ' + out);
}
const ENABLED = { DAIDAI_APP_ENABLED: '1' };
const PRIVATE = ['/invoices', '/invoices/' + ID, '/invoices/nope'];

before(async () => {
  wire = await projection();
  assert(parseResponse({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice: wire }), 'fake projection is contract-valid');
  assert.notEqual(wire.settlement, 'settled');
  assert(parseSessionOrListResponse({ apiVersion: 'v1', kind: 'invoice-list', invoices: [{ id: ID, revision: 7, targetAtomic: wire.targetAtomic, maxDebitAtomic: wire.maxDebitAtomic }] }));
  await startFake();
  if (process.env.DAIDAI_P105_SKIP_BUILD !== '1') {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAIDAI_') && !k.startsWith('NEXT_PUBLIC_')));
    const r = spawnSync(process.execPath, [nextBin, 'build'], { cwd: webRoot, env: clean, encoding: 'utf8' });
    assert.equal(r.status, 0, 'next build failed:\n' + r.stdout + r.stderr);
  }
  browser = await chromium.launch({ executablePath: process.env.DAIDAI_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); fake?.close(); });

const spy = () => { window.walletCalls = []; window.ethereum = { request(args) { window.walletCalls.push(args); throw Error('Unexpected wallet path'); } }; };
async function newContext() { const ctx = await browser.newContext(); await ctx.addInitScript(spy); return ctx; }
async function visit(ctx, url) {
  const page = await ctx.newPage();
  const response = await page.goto(url);
  const r = { status: response.status(), headers: response.headers(), url: page.url(), text: await page.evaluate(() => document.body.innerText),
    html: await page.content(), walletCalls: await page.evaluate(() => window.walletCalls.length), page };
  return r;
}
const sessionCookie = async ctx => (await ctx.cookies()).find(c => c.name === COOKIE);
async function login(ctx, base, invitation) {
  const page = await ctx.newPage();
  await page.goto(base + '/login');
  await page.fill('#invitation', invitation);
  await Promise.all([page.waitForLoadState('load'), page.waitForURL(u => !u.pathname.startsWith('/api/')), page.click('button[type=submit]')]);
  return page;
}
const noInvoiceData = (r, label) => {
  assert(!r.text.includes(wire.digest), label + ': digest leaked');
  assert(!r.text.includes('Commitment digest'), label + ': invoice terms rendered');
  assert(!/\bSettled\b/.test(r.text), label + ': Settled rendered');
};
async function injectSession(ctx, base, token) {
  await ctx.addCookies([{ name: COOKIE, value: token, domain: new URL(base).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Strict' }]);
}
function liveToken() { const t = code(); const now = Date.now(); sessions.set(t, { expiresAtMs: now + 3600_000, lastMs: now, idleMs: 1800_000, revoked: false }); return t; }

test('gate: preview needs DAIDAI_PREVIEW_ACCESS, production needs DAIDAI_APP_ENABLED, local needs the flag', () => {
  assert.equal(appEnabled({}), false);
  assert.equal(appEnabled({ DAIDAI_APP_ENABLED: '1' }), true);
  assert.equal(appEnabled({ DAIDAI_APP_ENABLED: 'true' }), false);
  assert.equal(appEnabled({ NODE_ENV: 'development' }), true);
  assert.equal(appEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(appEnabled({ VERCEL_ENV: 'production' }), false);
  assert.equal(appEnabled({ VERCEL_ENV: ' Production ', DAIDAI_APP_ENABLED: '1' }), true);
  assert.equal(appEnabled({ VERCEL_ENV: 'production', DAIDAI_PREVIEW_ACCESS: '1', NODE_ENV: 'development' }), false);
  assert.equal(appEnabled({ VERCEL_ENV: 'PREVIEW', DAIDAI_APP_ENABLED: '1' }), false);
  assert.equal(appEnabled({ VERCEL_ENV: 'preview', DAIDAI_APP_ENABLED: '1', NODE_ENV: 'development' }), false);
  assert.equal(appEnabled({ VERCEL_ENV: 'Preview', DAIDAI_PREVIEW_ACCESS: '1' }), true);
});

test('browser chunks contain no service key name, signature header, viewer header or session cookie name', () => {
  const files = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(join(webRoot, '.next', 'static'));
  assert(files.length > 0);
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const needle of ['DAIDAI_SERVICE_KEY', 'DAIDAI_API_BASE_URL', 'DAIDAI_DEMO_VIEWER_TOKEN', 'x-daidai-signature', 'x-daidai-viewer', 'daidai_session', KEY]) {
      assert(!s.includes(needle), f + ' contains ' + needle);
    }
  }
});

test('S4: environment gating — 404 without the flag even with a valid session; no session → /login', async () => {
  const variants = [
    { name: 'local without flag', env: {} },
    { name: 'preview without access', env: { VERCEL_ENV: 'Preview', DAIDAI_APP_ENABLED: '1' } },
    { name: 'production without flag', env: { VERCEL_ENV: 'production', DAIDAI_PREVIEW_ACCESS: '1' } },
  ];
  for (const v of variants) {
    const s = await startNext(v.env);
    try {
      const ctx = await newContext();
      await injectSession(ctx, s.base, liveToken());
      for (const p of [...PRIVATE, '/login', '/logout']) {
        const r = await visit(ctx, s.base + p);
        assert.equal(r.status, 404, v.name + ' ' + p); noInvoiceData(r, v.name + ' ' + p);
      }
      const post = await fetch(s.base + '/api/session', { method: 'POST', redirect: 'manual', headers: { origin: s.base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'invitation=' + issueInvitation() });
      assert.equal(post.status, 404, v.name + ' login handler');
      const home = await visit(ctx, s.base + '/');
      assert.equal(home.status, 200); assert(home.text.includes('Demo workspace'));
      await ctx.close();
    } finally { s.stop(); }
  }
  // Preview with explicit access still requires a session.
  const pv = await startNext({ VERCEL_ENV: 'preview', DAIDAI_PREVIEW_ACCESS: '1' });
  try {
    const ctx = await newContext();
    for (const p of PRIVATE) {
      const r = await visit(ctx, pv.base + p);
      assert.equal(new URL(r.url).pathname, '/login', 'no session must land on /login: ' + p); noInvoiceData(r, 'preview no session ' + p);
    }
    const bogus = await newContext(); await injectSession(bogus, pv.base, code());
    const r = await visit(bogus, pv.base + '/invoices');
    assert.equal(new URL(r.url).pathname, '/login'); noInvoiceData(r, 'unknown token');
    await injectSession(bogus, pv.base, liveToken());
    const ok = await visit(bogus, pv.base + '/invoices');
    assert.equal(ok.status, 200); assert(ok.text.includes(ID), 'preview with access and session lists invoices');
    await ctx.close(); await bogus.close();
  } finally { pv.stop(); }
});

test('S2, S3, U1, U2: login → list → detail → logout, cookie flags, CSRF, expiry/revocation', async () => {
  const s = await startNext(ENABLED);
  try {
    const ctx = await newContext();
    // U2: fixture demo unchanged.
    const home = await visit(ctx, s.base + '/');
    assert(home.text.includes('Demo workspace'), 'fixture demo strip missing');
    assert(!home.text.includes('Authoritative · read-only'));

    const loginPage = await visit(ctx, s.base + '/login');
    assert.equal(loginPage.status, 200);
    assert.match(loginPage.html, /<meta name="robots" content="[^"]*noindex/);
    assert.match(loginPage.headers['cache-control'] ?? '', /no-store/);
    assert.equal(await loginPage.page.getAttribute('#invitation', 'type'), 'password');
    assert.equal(await loginPage.page.getAttribute('#invitation', 'autocomplete'), 'off');

    // S3: cross-origin and origin-less login POSTs are refused and set nothing.
    const inv = issueInvitation();
    for (const origin of ['http://evil.example', 'null', undefined, s.base.replace('127.0.0.1', 'localhost')]) {
      const headers = { 'content-type': 'application/x-www-form-urlencoded' }; if (origin) headers.origin = origin;
      const r = await fetch(s.base + '/api/session', { method: 'POST', redirect: 'manual', headers, body: 'invitation=' + inv });
      assert.equal(r.status, 403, 'origin ' + origin); assert.equal(r.headers.get('set-cookie'), null);
    }
    assert.equal(invitations.get(inv), false, 'refused POST must not consume the invitation');
    assert.equal((await fetch(s.base + '/api/session', { redirect: 'manual' })).status, 405);

    // U1: valid login.
    const page = await login(ctx, s.base, inv);
    assert.equal(new URL(page.url()).pathname, '/invoices');
    const cookie = await sessionCookie(ctx);
    assert(cookie, 'session cookie set (Chromium accepts Secure/__Host- on http://127.0.0.1)');
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Strict'); assert.equal(cookie.path, '/');
    assert(!cookie.domain.startsWith('.'), 'host-only cookie');
    assert(cookie.expires > Date.now() / 1000 && cookie.expires <= Date.now() / 1000 + 12 * 3600 + 5, 'Max-Age <= 12h');
    assert(!(await page.evaluate(() => document.cookie)).includes('daidai_session'), 'document.cookie can read the session');
    const listText = await page.evaluate(() => document.body.innerText);
    for (const t of ['Authoritative · read-only', ID, 'Revision 7', '1,500', 'cNGN', '1.20', 'USDt', 'Sign out']) assert(listText.includes(t), 'list missing ' + t + ': ' + listText);
    const listHtml = await page.content();
    assert(!listHtml.includes(cookie.value), 'token rendered in HTML');

    // detail
    await Promise.all([page.waitForURL('**/invoices/' + ID), page.click('a[href="/invoices/' + ID + '"]')]);
    await page.waitForSelector('article.receipt');
    const detail = await page.evaluate(() => document.body.innerText);
    for (const t of ['Authoritative · read-only', wire.digest, 'Revision', '7', 'Exact target', 'Maximum all-in debit', 'Invoice approval', 'Recipient consent',
      'Verified', 'Conversion', 'Recipient payout', 'No verified chain evidence is available']) assert(detail.includes(t), 'detail missing ' + t);
    assert(/Settlement unverified|Reconciliation required/.test(detail));
    assert(!/\bSettled\b/.test(detail), 'Settled rendered'); assert(!detail.includes('Demo workspace'));
    assert(!(await page.content()).includes(cookie.value), 'token in detail HTML');
    assert.equal(await page.evaluate(() => window.walletCalls.length), 0);
    const missing = await visit(ctx, s.base + '/invoices/nope');
    assert(missing.text.includes('This invoice is not available.')); noInvoiceData(missing, 'missing');
    const bogus = await visit(ctx, s.base + '/invoices/' + encodeURIComponent('../v1/health'));
    noInvoiceData(bogus, 'bogus id');
    assert(log.every(q => !q.origin && !q.cookie), 'server calls must not forward browser origin or cookies');

    // S3: GET /logout does not log out; cross-origin logout is refused.
    const getLogout = await visit(ctx, s.base + '/logout');
    assert.equal(getLogout.status, 200);
    assert.equal((await fetch(s.base + '/api/session/logout', { redirect: 'manual' })).status, 405);
    const evilPort = await freePort();
    const evil = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<form id=f method=post action="' + s.base + '/api/session/logout"></form><script>f.submit()</script>'); }).listen(evilPort, '127.0.0.2');
    const ep = await ctx.newPage();
    const navigated = ep.waitForURL(u => u.pathname === '/api/session/logout');
    await ep.goto('http://127.0.0.2:' + evilPort + '/'); await navigated.catch(() => {});
    evil.close();
    const xs = await fetch(s.base + '/api/session/logout', { method: 'POST', redirect: 'manual', headers: { origin: 'http://evil.example', cookie: COOKIE + '=' + cookie.value } });
    assert.equal(xs.status, 403); assert.equal(xs.headers.get('set-cookie'), null);
    assert.equal((await sessionCookie(ctx))?.value, cookie.value, 'cross-site/GET must not clear the cookie');
    assert.equal(sessions.get(cookie.value).revoked, false, 'cross-site/GET must not revoke');
    const still = await visit(ctx, s.base + '/invoices');
    assert.equal(new URL(still.url).pathname, '/invoices');

    // A cross-site GET to the expired handler with a valid session must not clear it.
    await visit(ctx, s.base + '/api/session/expired');
    assert.equal((await sessionCookie(ctx))?.value, cookie.value, 'expired handler cleared a valid session');

    // U1: logout.
    const lp = await visit(ctx, s.base + '/invoices');
    await Promise.all([lp.page.waitForURL('**/login'), lp.page.click('button:has-text("Sign out")')]);
    assert.equal(await sessionCookie(ctx), undefined, 'cookie cleared on logout');
    assert.equal(sessions.get(cookie.value).revoked, true, 'revoked at the Worker');
    for (const p of PRIVATE) { const r = await visit(ctx, s.base + p); assert.equal(new URL(r.url).pathname, '/login', p); noInvoiceData(r, 'after logout ' + p); }

    // Revoked token replayed → /login and cookie cleared.
    await injectSession(ctx, s.base, cookie.value);
    const rv = await visit(ctx, s.base + '/invoices/' + ID);
    assert.equal(new URL(rv.url).pathname, '/login'); noInvoiceData(rv, 'revoked');
    assert.equal(await sessionCookie(ctx), undefined, 'revoked cookie cleared');

    // Reused invitation → uniform failure, no cookie.
    const reuse = await login(ctx, s.base, inv);
    assert.equal(new URL(reuse.url()).pathname, '/login');
    const reuseText = await reuse.evaluate(() => document.body.innerText);
    assert(reuseText.includes('That invitation is not valid.'));
    assert.equal(await sessionCookie(ctx), undefined);
    const unknown = await login(ctx, s.base, code());
    assert.equal(await unknown.evaluate(() => document.body.innerText), reuseText, 'uniform failure for unknown vs reused');

    // Expired session (absolute) → /login, cookie cleared. Idle timeout likewise.
    for (const mutate of [x => { x.expiresAtMs = Date.now() - 1; }, x => { x.lastMs = Date.now() - x.idleMs - 1; }]) {
      const p2 = await login(ctx, s.base, issueInvitation());
      assert.equal(new URL(p2.url()).pathname, '/invoices');
      const t = (await sessionCookie(ctx)).value; mutate(sessions.get(t));
      const r = await visit(ctx, s.base + '/invoices');
      assert.equal(new URL(r.url).pathname, '/login'); noInvoiceData(r, 'expired');
      assert.equal(await sessionCookie(ctx), undefined, 'expired cookie cleared');
    }
    assert(!s.log().includes(cookie.value) && !s.log().includes(KEY) && !s.log().includes(inv), 'secret in server log');
    await ctx.close();
  } finally { s.stop(); }
});
