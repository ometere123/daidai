// P10.4 internal authoritative demo: one `next build`, then `next start` with different runtime env against a fake,
// signature-verifying contract server. No wallet, no RPC, no network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chain, cngn, commit, usdt } from '../../../src/invoice.ts';
import { attest } from '../../../src/evidence-attestation.ts';
import { readAuthoritativeInvoice } from '../../../src/authoritative-invoice.ts';
import { parseResponse, errorBody, VIEWER_HEADER, responseHeaders } from '../../../src/api-contract.ts';
import { verifyRequest, NonceWindow } from '../../../src/service-auth.ts';
import { internalDemoEnabled } from '../lib/internal-demo.ts';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const KEY_ID = 'p104-test';
const KEY = 'test-only-service-key-' + 'x'.repeat(24);
const TOKEN = 'viewer_' + 'a'.repeat(40);
const BAD_TOKEN = 'viewer_' + 'b'.repeat(40);
const ID = 'invoice-a';
const TAMPERED_ID = 'invoice-tampered';

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
    observeTransaction: async () => null, // no chain reader configured
    observeCanonicalBlock: async () => null,
  };
  const p = await readAuthoritativeInvoice({ viewer: 'v', invoiceId: ID }, ports,
    { nowMs, maxObservationAgeMs: 600_000, expectedAudience: 'https://daidai.example' });
  assert(p, 'projection built');
  return JSON.parse(JSON.stringify(p));
}

let fake, fakeUrl, wire, browser, requests = [];
const nonces = new NonceWindow();
function startFake() {
  return new Promise(resolve => {
    fake = createServer(async (req, res) => {
      const send = (status, body) => { res.writeHead(status, responseHeaders); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
      const headers = new Headers(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const path = req.url;
      const viewerToken = headers.get(VIEWER_HEADER) ?? '';
      requests.push({ path, origin: headers.get('origin'), cookie: headers.get('cookie') });
      const ok = await verifyRequest({ keys: { [KEY_ID]: KEY }, headers, method: req.method, path, body: '', viewerToken, nowMs: Date.now(), nonces });
      if (!ok || headers.get('origin')) return send(401, errorBody('unauthenticated-service'));
      if (viewerToken !== TOKEN) return send(404, errorBody('not-found-or-forbidden'));
      if (path === '/v1/invoices/' + ID + '/authoritative') return send(200, { apiVersion: 'v1', kind: 'authoritative-invoice', invoice: wire });
      if (path === '/v1/invoices/' + TAMPERED_ID + '/authoritative') {
        return send(200, { apiVersion: 'v1', kind: 'authoritative-invoice', invoice: { ...wire, id: TAMPERED_ID, settlement: 'settled', targetAtomic: '01' } });
      }
      return send(404, errorBody('not-found-or-forbidden'));
    }).listen(0, '127.0.0.1', () => { fakeUrl = 'http://127.0.0.1:' + fake.address().port; resolve(); });
  });
}

const nextBin = join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
async function startNext(env) {
  const port = await new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAIDAI_') && k !== 'VERCEL_ENV'));
  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: webRoot, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/manifest.webmanifest'); return { base, stop: () => child.kill(), log: () => log }; } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  child.kill(); throw Error('next start did not come up: ' + log);
}
const onEnv = (extra = {}) => ({ DAIDAI_INTERNAL_DEMO: '1', DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD: '1', DAIDAI_API_BASE_URL: fakeUrl,
  DAIDAI_SERVICE_KEY_ID: KEY_ID, DAIDAI_SERVICE_KEY: KEY, DAIDAI_DEMO_VIEWER_TOKEN: TOKEN, ...extra });

before(async () => {
  wire = await projection();
  assert(parseResponse({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice: wire }), 'fake projection is contract-valid');
  assert.notEqual(wire.settlement, 'settled');
  await startFake();
  if (process.env.DAIDAI_P104_SKIP_BUILD !== '1') {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAIDAI_') && !k.startsWith('NEXT_PUBLIC_')));
    const r = spawnSync(process.execPath, [nextBin, 'build'], { cwd: webRoot, env: clean, encoding: 'utf8' });
    assert.equal(r.status, 0, 'next build failed:\n' + r.stdout + r.stderr);
  }
  browser = await chromium.launch({ executablePath: process.env.DAIDAI_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); fake?.close(); });

const spy = () => { window.walletCalls = []; window.ethereum = { request(args) { window.walletCalls.push(args); throw Error('Unexpected wallet path'); } }; };
async function visit(base, path) {
  const page = await browser.newPage();
  await page.addInitScript(spy);
  const response = await page.goto(base + path);
  const text = await page.evaluate(() => document.body.innerText);
  const html = await page.content();
  const walletCalls = await page.evaluate(() => window.walletCalls.length);
  await page.close();
  return { status: response.status(), headers: response.headers(), text, html, walletCalls };
}
const noInvoiceData = (r, label) => {
  assert(!r.text.includes(wire.digest), label + ': digest leaked');
  assert(!r.text.includes('Commitment digest'), label + ': invoice terms rendered');
  assert(!/\bSettled\b/.test(r.text), label + ': Settled rendered');
};

test('gate is read from env: off by default, off in Vercel production, prod NODE_ENV needs explicit local flag', () => {
  assert.equal(internalDemoEnabled({}), false);
  assert.equal(internalDemoEnabled({ DAIDAI_INTERNAL_DEMO: '1' }), true);
  assert.equal(internalDemoEnabled({ DAIDAI_INTERNAL_DEMO: 'true' }), false);
  assert.equal(internalDemoEnabled({ DAIDAI_INTERNAL_DEMO: '1', VERCEL_ENV: 'production' }), false);
  assert.equal(internalDemoEnabled({ DAIDAI_INTERNAL_DEMO: '1', VERCEL_ENV: 'production', DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD: '1' }), false);
  assert.equal(internalDemoEnabled({ DAIDAI_INTERNAL_DEMO: '1', NODE_ENV: 'production' }), false);
  assert.equal(internalDemoEnabled({ DAIDAI_INTERNAL_DEMO: '1', NODE_ENV: 'production', DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD: '1' }), true);
});

test('browser chunks contain no service key name, signature header or API client', () => {
  const dir = join(webRoot, '.next', 'static');
  const files = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  assert(files.length > 0);
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const needle of ['DAIDAI_SERVICE_KEY', 'DAIDAI_DEMO_VIEWER_TOKEN', 'DAIDAI_API_BASE_URL', 'x-daidai-signature', 'x-daidai-viewer', KEY, TOKEN]) {
      assert(!s.includes(needle), f + ' contains ' + needle);
    }
  }
});

test('gate off: internal route is 404 even with API env present; fixture demo unchanged', async () => {
  const off = await startNext({ ...onEnv(), DAIDAI_INTERNAL_DEMO: '0' });
  try {
    const r = await visit(off.base, '/internal/authoritative/' + ID);
    assert.equal(r.status, 404); noInvoiceData(r, 'off');
    const home = await visit(off.base, '/');
    assert.equal(home.status, 200);
    assert(home.text.includes('Demo workspace'), 'fixture demo strip missing');
    assert(!home.text.includes('Authoritative · Internal'));
    assert.equal(home.walletCalls, 0);
  } finally { off.stop(); }
  const prod = await startNext(onEnv({ VERCEL_ENV: 'production' }));
  try { assert.equal((await visit(prod.base, '/internal/authoritative/' + ID)).status, 404); } finally { prod.stop(); }
});

test('gate on: authoritative facts render, no settlement, no wallet, not cached', async () => {
  requests = [];
  const on = await startNext(onEnv());
  try {
    const r = await visit(on.base, '/internal/authoritative/' + ID);
    assert.equal(r.status, 200, on.log());
    assert.match(r.headers['cache-control'] ?? '', /no-store|private/);
    assert.match(r.html, /<meta name="robots" content="[^"]*noindex/);
    for (const s of ['Authoritative · Internal read-only demonstration', 'No chain reader is configured', wire.digest, 'Revision', String(wire.revision),
      'Exact target', '1,500', 'Maximum all-in debit', '1.20', 'Invoice approval', 'Recipient consent', 'Verified', 'Conversion', 'Recipient payout',
      'Outcome unknown']) assert(r.text.includes(s), 'missing: ' + s);
    assert(/Settlement unverified|Reconciliation required/.test(r.text), 'settlement state missing');
    assert(!/\bSettled\b/.test(r.text), 'Settled rendered');
    assert(!r.text.includes('Nothing here happened onchain'), 'demo strip rendered on authoritative page');
    assert(!r.html.includes(TOKEN) && !r.html.includes(KEY), 'secret in HTML');
    assert.equal(r.walletCalls, 0);
    assert(requests.length > 0 && requests.every(q => !q.origin && !q.cookie), 'server call must not forward browser origin or cookies');

    const tampered = await visit(on.base, '/internal/authoritative/' + TAMPERED_ID);
    assert(tampered.text.includes('This invoice is not available.')); noInvoiceData(tampered, 'tampered');
    const missing = await visit(on.base, '/internal/authoritative/nope');
    assert(missing.text.includes('This invoice is not available.')); noInvoiceData(missing, 'missing');
    assert.equal(missing.text, tampered.text.replace(TAMPERED_ID, 'nope'), 'uniform failure page');
    const bogus = await visit(on.base, '/internal/authoritative/' + encodeURIComponent('../v1/health'));
    noInvoiceData(bogus, 'bogus id');
  } finally { on.stop(); }

  const bad = await startNext(onEnv({ DAIDAI_DEMO_VIEWER_TOKEN: BAD_TOKEN }));
  try {
    const r = await visit(bad.base, '/internal/authoritative/' + ID);
    assert(r.text.includes('This invoice is not available.')); noInvoiceData(r, 'bad token');
  } finally { bad.stop(); }

  const wrongKey = await startNext(onEnv({ DAIDAI_SERVICE_KEY: 'wrong-key-' + 'y'.repeat(30) }));
  try {
    const r = await visit(wrongKey.base, '/internal/authoritative/' + ID);
    assert(r.text.includes('This invoice is not available.')); noInvoiceData(r, 'wrong key');
    assert(!wrongKey.log().includes('wrong-key-'), 'key logged');
  } finally { wrongKey.stop(); }
});
