// Worker tests over Miniflare (workerd) with a fresh in-memory D1. A4, A2, C1, C2 (HTTP level), C4.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, responseHeaders, VIEWER_HEADER } from '../../../src/api-contract.ts';
import { SERVICE_HEADERS } from '../../../src/service-auth.ts';
import { randomNonce, randomToken, seed, serviceKey, signedHeaders, startWorker, type Seeded } from './fixtures.ts';

const k = serviceKey();
let mf: Awaited<ReturnType<typeof startWorker>>['mf'];
let s: Seeded;
let logs: string[];
const BASE = 'http://api.local';
const invoicePath = (id: string) => `/v1/invoices/${id}/authoritative`;
const UNAUTH = '{"apiVersion":"v1","kind":"error","error":"unauthenticated-service"}';
const NOT_FOUND = '{"apiVersion":"v1","kind":"error","error":"not-found-or-forbidden"}';

before(async () => {
  const w = await startWorker({ keys: { [k.keyId]: k.secret } });
  mf = w.mf;
  logs = w.logs;
  s = await seed(w.db);
});
after(async () => { await mf.dispose(); });

async function get(path: string, headers: Record<string, string>, init: RequestInit = {}) {
  const r = await mf.dispatchFetch(BASE + path, { headers, ...init } as never);
  return { status: r.status, headers: r.headers as unknown as HeaderBag, text: await r.text() };
}
const asViewer = async (id: string, token: string, extra: Partial<Parameters<typeof signedHeaders>[0]> = {}) =>
  get(invoicePath(id), await signedHeaders({ ...k, path: invoicePath(id), viewerToken: token, ...extra }));

type HeaderBag = { get(name: string): string | null; forEach(cb: (value: string, name: string) => void): void };
function assertPrivateHeaders(h: HeaderBag) {
  for (const [name, value] of Object.entries(responseHeaders)) assert.equal(h.get(name), value, name);
  h.forEach((_, name) => assert.ok(!name.startsWith('access-control-'), `no CORS header: ${name}`));
}

describe('A4 read-only Worker', () => {
  test('health requires service auth and returns the health body', async () => {
    const r = await get('/v1/health', await signedHeaders({ ...k, path: '/v1/health' }));
    assert.equal(r.status, 200);
    assert.deepEqual(parseResponse(JSON.parse(r.text)), { apiVersion: 'v1', kind: 'health', status: 'ok', readOnly: true, execution: 'disabled' });
    assertPrivateHeaders(r.headers);
    const unsigned = await get('/v1/health', {});
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.text, UNAUTH);
  });

  test('a valid signed request returns a schema-v2 projection, never settled without a chain reader', async () => {
    for (const id of ['inv-a1', 'inv-a2', 'inv-a3']) {
      const r = await asViewer(id, s.tokens.demo);
      assert.equal(r.status, 200, id);
      assertPrivateHeaders(r.headers);
      const body = parseResponse(JSON.parse(r.text));
      assert.ok(body && body.kind === 'authoritative-invoice', id);
      const inv = body.invoice;
      assert.equal(inv.schemaVersion, 2);
      assert.equal(inv.id, id);
      assert.equal(inv.digest, s.invoices[id as 'inv-a1'].digest);
      assert.equal(inv.execution, 'disabled');
      assert.notEqual(inv.settlement, 'settled');
      assert.equal(inv.approval.state, 'verified');
      assert.equal(inv.consent.state, 'verified');
    }
  });

  test('attempt scenarios project as unverified, unknown/missing-hash and lineage-unresolved', async () => {
    const proj = async (id: string) => (parseResponse(JSON.parse((await asViewer(id, s.tokens.demo)).text)) as { invoice: any }).invoice;
    const a1 = await proj('inv-a1');
    assert.deepEqual(a1.payout, { state: 'unverified', reason: 'missing' });
    assert.equal(a1.settlement, 'unverified');
    const a2 = await proj('inv-a2');
    assert.deepEqual(a2.payout, { state: 'unknown', reason: 'missing-hash', attemptId: 'att-a2-payout', recordedRevision: 1 });
    assert.equal(a2.settlement, 'reconciliation-required');
    const a3 = await proj('inv-a3');
    assert.deepEqual(a3.payout, { state: 'reconciliation-required', reason: 'lineage-unresolved', attemptId: 'legacy-a3-payout' });
    assert.equal(a3.settlement, 'reconciliation-required');
  });
});

describe('C1 service authentication', () => {
  const path = invoicePath('inv-a1');
  const cases: [string, () => Promise<Record<string, string>>][] = [
    ['wrong key', () => signedHeaders({ keyId: k.keyId, secret: 'f'.repeat(64), path, viewerToken: s.tokens.demo })],
    ['unknown key id', () => signedHeaders({ keyId: 'other-key', secret: k.secret, path, viewerToken: s.tokens.demo })],
    ['skew > 60 s (past)', () => signedHeaders({ ...k, path, viewerToken: s.tokens.demo, nowMs: Date.now() - 61_000 })],
    ['skew > 60 s (future)', () => signedHeaders({ ...k, path, viewerToken: s.tokens.demo, nowMs: Date.now() + 61_000 })],
    ['tampered path', async () => ({ ...await signedHeaders({ ...k, path: invoicePath('inv-a2'), viewerToken: s.tokens.demo }) })],
    ['tampered viewer token', async () => ({ ...await signedHeaders({ ...k, path, viewerToken: s.tokens.demo }), [VIEWER_HEADER]: s.tokens.viewerB })],
    ['tampered signature', async () => { const h = await signedHeaders({ ...k, path, viewerToken: s.tokens.demo });
      return { ...h, [SERVICE_HEADERS.signature]: h[SERVICE_HEADERS.signature].replace(/^./, c => c === '0' ? '1' : '0') }; }],
    ['missing headers', async () => ({ [VIEWER_HEADER]: s.tokens.demo })],
    ...Object.values(SERVICE_HEADERS).map(name => [`missing ${name}`, async () => {
      const h = await signedHeaders({ ...k, path, viewerToken: s.tokens.demo }); delete h[name]; return h; }] as [string, () => Promise<Record<string, string>>]),
    ['Origin header present on a validly signed request', async () => ({ ...await signedHeaders({ ...k, path, viewerToken: s.tokens.demo }), origin: 'http://127.0.0.1:3000' })],
  ];
  for (const [name, headers] of cases) {
    test(`${name} → 401 uniform`, async () => {
      const r = await get(path, await headers());
      assert.equal(r.status, 401);
      assert.equal(r.text, UNAUTH);
      assertPrivateHeaders(r.headers);
    });
  }
  test('replayed nonce → 401 (first use succeeds)', async () => {
    const h = await signedHeaders({ ...k, path, viewerToken: s.tokens.demo, nonce: randomNonce() });
    assert.equal((await get(path, h)).status, 200);
    const replay = await get(path, h);
    assert.equal(replay.status, 401);
    assert.equal(replay.text, UNAUTH);
  });
  test('Origin header on health and on OPTIONS preflight → 401, no CORS', async () => {
    const r = await get('/v1/health', { ...await signedHeaders({ ...k, path: '/v1/health' }), origin: 'https://evil.example' });
    assert.equal(r.status, 401);
    const pre = await get('/v1/health', { origin: 'https://evil.example', 'access-control-request-method': 'GET' }, { method: 'OPTIONS' });
    assert.equal(pre.status, 401);
    assertPrivateHeaders(pre.headers);
  });
});

describe('C2 viewer access (uniform 404)', () => {
  test('unknown, expired, no-permission, cross-tenant, nonexistent and malformed tokens are indistinguishable', async () => {
    const results = [
      await asViewer('inv-a1', randomToken()),          // unknown token
      await asViewer('inv-a1', s.tokens.expired),       // expired session
      await asViewer('inv-a1', s.tokens.noPermission),  // same tenant, no permission
      await asViewer('inv-a4', s.tokens.demo),          // exists in tenant, no permission for this invoice
      await asViewer('inv-a1', s.tokens.viewerB),       // cross-tenant
      await asViewer('inv-b1', s.tokens.demo),          // cross-tenant, other direction
      await asViewer('inv-zz', s.tokens.demo),          // nonexistent invoice
      await asViewer('inv-a1', 'short'),                // malformed token (still needs valid service auth)
    ];
    for (const r of results) {
      assert.equal(r.status, 404);
      assert.equal(r.text, NOT_FOUND);
      assertPrivateHeaders(r.headers);
    }
    // The legitimate owner of inv-b1 can read it, so the 404 above was a denial, not a missing row.
    assert.equal((await asViewer('inv-b1', s.tokens.viewerB)).status, 200);
  });
});

describe('A2 malformed requests', () => {
  const bad = ['/v1/invoices/inv-a1/authoritative?x=1', '/v1/invoices/inv-a1/authoritative/extra', '/v1/invoices/%2e%2e/authoritative',
    '/v1/invoices/-bad/authoritative', '/v1/invoices/' + 'a'.repeat(129) + '/authoritative', '/v1/invoices//authoritative',
    '/v2/health', '/v1/health/', '/', '/v1/invoices/inv%ZZ/authoritative'];
  for (const path of bad) {
    test(`${path.slice(0, 60)} → 400`, async () => {
      const r = await get(path, await signedHeaders({ ...k, path: new URL(BASE + path).pathname, viewerToken: s.tokens.demo }));
      assert.equal(r.status, 400);
      assert.equal(r.text, '{"apiVersion":"v1","kind":"error","error":"invalid-request"}');
      assertPrivateHeaders(r.headers);
    });
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    test(`${method} → 405`, async () => {
      const path = invoicePath('inv-a1');
      const r = await get(path, await signedHeaders({ ...k, path, viewerToken: s.tokens.demo }), { method, ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { body: '{}' } : {}) });
      assert.equal(r.status, 405);
      assert.equal(r.headers.get('allow'), 'GET');
      assert.equal(r.text, '{"apiVersion":"v1","kind":"error","error":"method-not-allowed"}');
    });
  }
});

describe('C4 misconfiguration fails closed', () => {
  test('no service keys configured → 503 unavailable, no data', async () => {
    const w = await startWorker({ keys: {} });
    try {
      const r = await w.mf.dispatchFetch(BASE + '/v1/health', { headers: await signedHeaders({ ...k, path: '/v1/health' }) });
      assert.equal(r.status, 503);
      assert.equal(await r.text(), '{"apiVersion":"v1","kind":"error","error":"unavailable"}');
    } finally { await w.mf.dispose(); }
  });
  test('D1 without schema (storage failure during session lookup) → uniform 404, message not leaked', async () => {
    const w = await startWorker({ keys: { [k.keyId]: k.secret } });
    try {
      const path = invoicePath('inv-a1');
      // authenticateViewer() treats a throwing session store as "no viewer", so this fails closed as a denial.
      const r = await w.mf.dispatchFetch(BASE + path, { headers: await signedHeaders({ ...k, path, viewerToken: randomToken() }) });
      assert.equal(r.status, 404);
      assert.equal(await r.text(), NOT_FOUND);
    } finally { await w.mf.dispose(); }
  });
});

describe('C4 log redaction', () => {
  test('Worker logs carry only rid, route, status and key id: no tokens, signatures, nonces or invoice data', async () => {
    const path = invoicePath('inv-a1');
    const h = await signedHeaders({ ...k, path, viewerToken: s.tokens.demo });
    assert.equal((await get(path, h)).status, 200);
    await new Promise(r => setTimeout(r, 200));
    assert.ok(logs.length > 10, 'logs captured');
    const secrets = [k.secret, ...Object.values(s.tokens), h[SERVICE_HEADERS.signature], h[SERVICE_HEADERS.nonce],
      ...Object.values(s.invoices).flatMap(i => [i.digest, i.approval, i.consent, i.invoice.recipient, i.invoice.taker])];
    for (const line of logs) {
      for (const secret of secrets) assert.ok(!line.includes(secret), 'log line leaks a secret or invoice datum');
      const parsed = JSON.parse(line);
      assert.ok(Object.keys(parsed).every(key => ['rid', 'route', 'status', 'keyId'].includes(key)), line);
      assert.match(parsed.rid, /^[0-9a-f]{8}$/);
    }
  });
});
