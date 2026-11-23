// P10.4 independent adversarial suite (Agent C/D), root half: lineage policy on the node:sqlite store, the server-only
// API client and the internal-demo gate. Temp SQLite files and a stubbed global fetch only; no network, no RPC.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { errorBody, health, VIEWER_HEADER } from '../src/api-contract.ts';
import { AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { readAuthoritativeInvoice, type CanonicalBlockObservation, type ObservedTransaction } from '../src/authoritative-invoice.ts';
import { authorizationMessage } from '../src/authorization.ts';
import { attest } from '../src/evidence-attestation.ts';
import { cngn, commit, usdt, type Invoice } from '../src/invoice-core.ts';
import { authenticateViewerToken, projectionSources, type Repositories } from '../src/repositories.ts';
import { NonceWindow, sha256Hex, verifyRequest } from '../src/service-auth.ts';
import { getAuthoritativeInvoice } from '../apps/web/lib/daidai-api.ts';
import { appEnabled } from '../apps/web/lib/app-gate.ts';

// ───────────────────────────── 5. Lineage policy (node store) ─────────────────────────────
const D1 = 'ab'.repeat(32), D2 = 'cd'.repeat(32);
const env = envelopeOf({ chainId: 42220, to: cngn, data: '0x34', value: '0' });
const claim = (id: string, patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: id, tenantId: 'tenant-a', invoiceId: 'invoice-a', digest: D1, recordedRevision: 2, operation: 'payout', createdAtMs: 1_000_000,
  authorization: { digest: patch.digest ?? D1, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 },
  envelope: env, ...patch,
});
function setup(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-p104-adv-'));
  const file = join(dir, 'l.db');
  const store = new AttemptLineageStore(file);
  const raw = new DatabaseSync(file);
  t.after(() => { raw.close(); store.close_db(); rmSync(dir, { recursive: true, force: true }); });
  return { store, raw };
}
function evidence(store: AttemptLineageStore, attemptId: string, tp: Partial<ObservedTransaction> = {}, cp: Partial<CanonicalBlockObservation> = {}) {
  const r = store.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown>;
  const blockHash = '0x' + 'b1'.repeat(32);
  const txBase = {
    source: 'transaction-verifier' as const, tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id), digest: String(r.digest),
    revision: Number(r.recorded_revision), operation: r.operation as 'payout', attemptId, hash: String(r.hash), chainId: 42220,
    buyToken: '0x' + '0c'.repeat(20), sellToken: '0x' + '0d'.repeat(20), sender: '0x' + '33'.repeat(20), recipient: '0x' + '22'.repeat(20),
    amountAtomic: '1', debitAtomic: '0', blockNumber: '100', blockHash, success: true, observedAtMs: 1, ...tp,
  };
  const canBase = { source: 'canonical-chain-reader' as const, chainId: 42220, blockNumber: '100', blockHash, blockTimestampMs: 1,
    finalizedBlockNumber: '120', finalizedBlockHash: '0x' + 'f1'.repeat(32), observedAtMs: 1, ...cp };
  return { tx: attest<ObservedTransaction>(txBase as ObservedTransaction), canonical: attest<CanonicalBlockObservation>(canBase), txBase, canBase };
}
const H1 = '0x' + '11'.repeat(32), H2 = '0x' + '12'.repeat(32);
const count = (raw: DatabaseSync, sql: string, ...a: string[]) => Number((raw.prepare(sql).get(...a) as { c: number }).c);

test('ADV-5 new digest is refused while open and after final; other tenant / other invoice are unaffected', t => {
  const { store } = setup(t);
  store.recordAttempt(claim('a1'));
  assert.throws(() => store.recordAttempt(claim('a2', { digest: D2 })), /already open/);
  store.recordHash('a1', H1, 1_000_100);
  const e = evidence(store, 'a1');
  store.recordVerifiedFinal('a1', e.tx, e.canonical, 1_000_200);
  store.close('a1', 'verified-final', 1_000_300, 'ops');
  assert.throws(() => store.recordAttempt(claim('a3', { digest: D2 })), /already finalized/);
  assert.throws(() => store.recordAttempt(claim('a4')), /already finalized/);
  // Same invoice id in another tenant, and another invoice in the same tenant, can proceed.
  assert.equal(store.recordAttempt(claim('b1', { tenantId: 'tenant-b' })), 'created');
  assert.equal(store.recordAttempt(claim('c1', { invoiceId: 'invoice-c', digest: D2 })), 'created');
  // The conversion operation of the same invoice is a separate operation.
  assert.equal(store.recordAttempt(claim('a-conv', { operation: 'conversion', envelope: envelopeOf({ chainId: 42220, to: usdt, data: '0x12', value: '0' }) })), 'created');
});

test('ADV-5 recordVerifiedFinal: non-attested look-alikes and every binding mismatch are refused, no event written', t => {
  const { store, raw } = setup(t);
  store.recordAttempt(claim('a1'));
  store.recordHash('a1', H1, 1_000_100);
  const good = evidence(store, 'a1');
  const before = count(raw, "SELECT count(*) AS c FROM attempt_events WHERE kind = 'verification'");
  assert.throws(() => store.recordVerifiedFinal('a1', { ...good.txBase } as ObservedTransaction, good.canonical, 1), /requires attested evidence/);
  assert.throws(() => store.recordVerifiedFinal('a1', good.tx, { ...good.canBase }, 1), /requires attested evidence/);
  assert.throws(() => store.recordVerifiedFinal('a1', JSON.parse(JSON.stringify(good.tx)), good.canonical, 1), /requires attested evidence/);
  const mismatches: Partial<ObservedTransaction>[] = [
    { attemptId: 'other' }, { hash: H2 }, { revision: 3 }, { digest: D2 }, { operation: 'conversion' }, { tenantId: 'tenant-b' },
    { invoiceId: 'invoice-z' }, { success: false }, { source: 'fixture' as never },
  ];
  for (const m of mismatches) {
    const e = evidence(store, 'a1', m);
    assert.throws(() => store.recordVerifiedFinal('a1', e.tx, e.canonical, 1), /does not belong to this attempt/, JSON.stringify(m));
  }
  for (const cp of [{ finalizedBlockNumber: '99' }, { blockHash: '0x' + 'b2'.repeat(32) }, { chainId: 1 }, { blockNumber: '101' }, { source: 'fixture' as never }]) {
    const e = evidence(store, 'a1', {}, cp);
    assert.throws(() => store.recordVerifiedFinal('a1', e.tx, e.canonical, 1), /not canonical and finalized/, JSON.stringify(cp));
  }
  assert.equal(count(raw, "SELECT count(*) AS c FROM attempt_events WHERE kind = 'verification'"), before);
});

test('ADV-5 appendVerification refuses verified-final (any verifier name); a later negative verdict blocks closure', t => {
  const { store, raw } = setup(t);
  store.recordAttempt(claim('a1'));
  store.recordHash('a1', H1, 1_000_100);
  for (const v of ['attested-evidence', 'transaction-verifier', 'ops']) {
    assert.throws(() => store.appendVerification('a1', 1_000_110, 'verified-final' as never, v), /only be recorded from attested evidence/);
  }
  const e = evidence(store, 'a1');
  store.recordVerifiedFinal('a1', e.tx, e.canonical, 1_000_200);
  store.appendVerification('a1', 1_000_210, 'mismatch', 'auditor');
  assert.throws(() => store.close('a1', 'verified-final', 1_000_220, 'ops'), /latest verdict, for the recorded hash/);
  // Raw SQL closure is refused by the trigger too.
  assert.throws(() => raw.prepare("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'a1'").run(), /latest independent verdict/);
  assert.equal(count(raw, "SELECT count(*) AS c FROM attempt_events WHERE kind = 'closed'"), 0);
});

test('ADV-5 OBSERVATION: a raw writer can forge an attested-evidence verdict and close (inside the trust boundary; documented)', t => {
  const { store, raw } = setup(t);
  store.recordAttempt(claim('a1'));
  store.recordHash('a1', H1, 1_000_100);
  raw.prepare("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('a1', 'verification', 1, ?)")
    .run(JSON.stringify({ result: 'verified-final', verifier: 'attested-evidence', hash: H1 }));
  raw.prepare("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'a1'").run();
  assert.equal((raw.prepare("SELECT closed FROM attempts WHERE attempt_id = 'a1'").get() as { closed: string }).closed, 'verified-final');
  // It can only block: a new digest is still refused afterwards.
  assert.throws(() => store.recordAttempt(claim('a2', { digest: D2 })), /already finalized/);
});

test('FIXED (P10.4 adversarial finding): node store close() on an already verified-final attempt succeeds again and appends a second "closed" event', t => {
  const { store, raw } = setup(t);
  store.recordAttempt(claim('a1'));
  store.recordHash('a1', H1, 1_000_100);
  const e = evidence(store, 'a1');
  store.recordVerifiedFinal('a1', e.tx, e.canonical, 1_000_200);
  store.close('a1', 'verified-final', 1_000_300, 'ops-alice');
  // Expected: refused. Actual: same-value UPDATE passes attempt_close_once and close() has no `closed IS NULL` check.
  assert.throws(() => store.close('a1', 'verified-final', 1_000_400, 'ops-mallory'), /closure is final|already closed/);
  assert.equal(count(raw, "SELECT count(*) AS c FROM attempt_events WHERE kind = 'closed'"), 1);
});

// ───────────────────────────── 6. Frontend server client and gate ─────────────────────────────
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});
const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const TOKEN = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
function configure(base: string) {
  process.env.DAIDAI_API_BASE_URL = base;
  process.env.DAIDAI_SERVICE_KEY_ID = 'vercel-1';
  process.env.DAIDAI_SERVICE_KEY = SECRET;
}
type Captured = { url: string; init: RequestInit };
function stubFetch(respond: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: URL | string, init: RequestInit) => { const c = { url: String(url), init }; calls.push(c); return respond(c); }) as typeof fetch;
  return calls;
}
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

test('ADV-6 base URL validation: only https, or http on exact loopback names; userinfo/query/fragment refused; no fetch on misconfig', async () => {
  const bad = ['http://evil.example', 'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://localhost.', 'http://127.0.0.2',
    'https://user:pw@api.example', 'https://api.example/?x=1', 'https://api.example/#f', 'ftp://api.example', 'javascript:alert(1)', '',
    'http://[::ffff:127.0.0.1]', 'api.example'];
  for (const base of bad) {
    configure(base);
    const calls = stubFetch(() => json(health()));
    assert.deepEqual(await getAuthoritativeInvoice('inv-a1', TOKEN), { kind: 'misconfigured' }, base);
    assert.equal(calls.length, 0, base);
  }
  // WHATWG URL normalizes numeric IPv4 forms to 127.0.0.1, which really is loopback.
  for (const base of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'http://0x7f000001:8787', 'http://127.1:8787', 'https://api.example']) {
    configure(base);
    const calls = stubFetch(() => json(errorBody('not-found-or-forbidden')));
    assert.deepEqual(await getAuthoritativeInvoice('inv-a1', TOKEN), { kind: 'not-found-or-forbidden' }, base);
    assert.equal(calls.length, 1, base);
  }
  // Short key / bad key id.
  configure('https://api.example'); process.env.DAIDAI_SERVICE_KEY = 'short';
  assert.deepEqual(await getAuthoritativeInvoice('inv-a1', TOKEN), { kind: 'misconfigured' });
  configure('https://api.example'); process.env.DAIDAI_SERVICE_KEY_ID = 'bad id';
  assert.deepEqual(await getAuthoritativeInvoice('inv-a1', TOKEN), { kind: 'misconfigured' });
});

test('ADV-6 request: redirect:error, no-store, signed path (with encoded ids) verifies at the Worker; invalid id/token never fetched', async () => {
  configure('https://api.example/prefix/');
  const calls = stubFetch(() => json(errorBody('not-found-or-forbidden')));
  await getAuthoritativeInvoice('inv:a1', TOKEN);
  const c = calls[0];
  assert.equal(c.init.redirect, 'error');
  assert.equal(c.init.cache, 'no-store');
  assert.equal(c.init.method, 'GET');
  const u = new URL(c.url);
  assert.equal(u.pathname, '/prefix/v1/invoices/inv%3Aa1/authoritative');
  const headers = new Headers(c.init.headers as Record<string, string>);
  assert.equal(headers.get(VIEWER_HEADER), TOKEN);
  assert.equal(await verifyRequest({ keys: { 'vercel-1': SECRET }, headers, method: 'GET', path: u.pathname, body: '', viewerToken: TOKEN,
    nowMs: Date.now(), nonces: new NonceWindow() }), true);
  for (const [id, tok] of [["inv'a1", TOKEN], ['../x', TOKEN], ['inv-a1', 'short'], ['inv-a1', TOKEN + ' ']]) {
    assert.deepEqual(await getAuthoritativeInvoice(id, tok), { kind: 'not-found-or-forbidden' });
  }
  assert.equal(calls.length, 1);
});

test('ADV-6 responses: redirect/network errors, invalid or oversized JSON, extra fields and unknown errors → unavailable; 401 → misconfigured', async () => {
  configure('https://api.example');
  const cases: [() => Response | Promise<Response>, string][] = [
    [() => { throw new TypeError('fetch failed: redirect mode is set to error'); }, 'unavailable'],
    [() => new Response('not json', { status: 200 }), 'unavailable'],
    [() => new Response('{"apiVersion":"v1","kind":"error","error":"not-found-or-forbidden"', { status: 200 }), 'unavailable'],
    [() => json({ ...errorBody('not-found-or-forbidden'), pad: 'x'.repeat(5_000_000) }), 'unavailable'],
    [() => json({ ...errorBody('not-found-or-forbidden'), __proto__: { x: 1 } }), 'not-found-or-forbidden'],
    [() => json(errorBody('rate-limited')), 'unavailable'],
    [() => json(errorBody('unavailable')), 'unavailable'],
    [() => json(errorBody('unauthenticated-service')), 'misconfigured'],
    [() => json(health()), 'unavailable'],
    [() => json({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice: { schemaVersion: 2 } }), 'unavailable'],
    [() => new Response(JSON.stringify(errorBody('not-found-or-forbidden')), { status: 500 }), 'not-found-or-forbidden'],
  ];
  for (const [respond, kind] of cases) {
    stubFetch(respond);
    assert.equal((await getAuthoritativeInvoice('inv-a1', TOKEN)).kind, kind);
  }
});

// A real, attested projection built through the composition layer over in-memory repositories (no network).
async function realProjection(id: string) {
  const now = Date.now();
  const p = () => { const key = generatePrivateKey(); return { key, address: privateKeyToAccount(key).address.toLowerCase() }; };
  const approver = p(), recipient = p(), taker = p();
  const { invoice, digest } = commit({ id, version: 1, source: 'adv', nonce: 'aa'.repeat(16), chain: 42220, sell: usdt, sellDecimals: 6, buy: cngn,
    buyDecimals: 6, buyAmount: '1500000000', recipient: recipient.address, maxSell: '1000000', approver: approver.address, taker: taker.address,
    expires: now + 3600_000 } as Invoice);
  const audience = 'http://127.0.0.1:3000';
  const approval = await privateKeyToAccount(approver.key).signTypedData(authorizationMessage(invoice, digest, 'invoice approval', audience));
  const consent = await privateKeyToAccount(recipient.key).signTypedData(authorizationMessage(invoice, digest, 'recipient consent', audience));
  const th = await sha256Hex(TOKEN);
  const repos: Repositories = {
    invoices: { read: async (t, i) => t === 'tenant-a' && i === id ? { tenantId: t, invoiceId: i, invoice, digest, revision: 1 } : null },
    signatures: { read: async b => b.digest === digest ? { approval, consent } : null },
    sessions: { findByTokenHash: async h => h === th ? { viewerId: 'v', tenantId: 'tenant-a', authenticatedAtMs: now - 1000, expiresAtMs: now + 60_000 } : null },
    permissions: { canReadInvoice: async (t, v, i) => t === 'tenant-a' && v === 'v' && i === id, tenantOfInvoice: async i => i === id ? 'tenant-a' : null },
    attempts: { attempts: async () => [] },
  };
  const viewer = await authenticateViewerToken(repos, TOKEN, now);
  assert.ok(viewer);
  const projection = await readAuthoritativeInvoice({ viewer, invoiceId: id }, projectionSources(repos, { audience, clock: () => now }),
    { nowMs: now, maxObservationAgeMs: 60_000, expectedAudience: audience });
  assert.ok(projection);
  return projection;
}

test('ADV-6 response id mismatch → unavailable; matching projection → invoice; projection never "settled" without a chain reader', async () => {
  configure('https://api.example');
  const projection = await realProjection('inv-a1');
  assert.notEqual(projection.settlement, 'settled');
  stubFetch(() => json({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice: projection }));
  const ok = await getAuthoritativeInvoice('inv-a1', TOKEN);
  assert.equal(ok.kind, 'invoice');
  assert.deepEqual(await getAuthoritativeInvoice('inv-a2', TOKEN), { kind: 'unavailable' });
  stubFetch(() => json({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice: { ...projection, settlement: 'settled', extra: 1 } }));
  assert.deepEqual(await getAuthoritativeInvoice('inv-a1', TOKEN), { kind: 'unavailable' });
});

test('ADV-6 (updated for P10.5) environment gate truth table; the P10.4 demo flags no longer enable anything', () => {
  const on = (e: Record<string, string>) => appEnabled(e as NodeJS.ProcessEnv);
  // Local: explicit flag or a development server only.
  assert.equal(on({ DAIDAI_APP_ENABLED: '1' }), true);
  assert.equal(on({ NODE_ENV: 'development' }), true);
  for (const v of ['1 ', ' 1', 'true', 'yes', 'on', 'TRUE', '01', '', '0']) assert.equal(on({ DAIDAI_APP_ENABLED: v, NODE_ENV: 'production' }), false, JSON.stringify(v));
  // Production: only DAIDAI_APP_ENABLED=1, never NODE_ENV=development or the preview flag.
  for (const v of ['production', 'Production', ' production', 'PRODUCTION']) {
    assert.equal(on({ VERCEL_ENV: v }), false, v);
    assert.equal(on({ VERCEL_ENV: v, NODE_ENV: 'development', DAIDAI_PREVIEW_ACCESS: '1' }), false, v);
    assert.equal(on({ VERCEL_ENV: v, DAIDAI_APP_ENABLED: '1' }), true, v);
  }
  // Preview: only DAIDAI_PREVIEW_ACCESS=1 (and a session is still required at the page).
  for (const v of ['preview', 'Preview']) {
    assert.equal(on({ VERCEL_ENV: v, DAIDAI_APP_ENABLED: '1', NODE_ENV: 'development' }), false, v);
    assert.equal(on({ VERCEL_ENV: v, DAIDAI_PREVIEW_ACCESS: 'true' }), false, v);
    assert.equal(on({ VERCEL_ENV: v, DAIDAI_PREVIEW_ACCESS: '1' }), true, v);
  }
  // The removed P10.4 flags have no effect.
  assert.equal(on({ DAIDAI_INTERNAL_DEMO: '1', DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD: '1', NODE_ENV: 'production' }), false);
});
