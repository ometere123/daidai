// P10.5 S1 (invitation exchange), S2 (session lifecycle), the permitted invoice list and the optional chain hook.
// Runs the Worker's exact handler over a local Miniflare D1 with a controllable clock, plus the real Worker for S1.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BODY_BYTES, MAX_LIST, VIEWER_HEADER, parseSessionOrListResponse } from '../../../src/api-contract.ts';
import { NonceWindow, sha256Hex, signRequest } from '../../../src/service-auth.ts';
import { chainFromEnv, chainRpcUrl } from '../src/chain-config.ts';
import { createInvitation, revokeViewerSessions, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../src/d1-auth.ts';
import { d1Repositories } from '../src/d1-repositories.ts';
import { RateLimiter, handle, parseServiceKeys } from '../src/handler.ts';
import { AUDIENCE, randomNonce, randomToken, seed, serviceKey, signedInvoice, startWorker, type Seeded } from './fixtures.ts';

const BASE = 'http://api.local';
const INVALID = '{"apiVersion":"v1","kind":"error","error":"invalid-credentials"}';
const BAD = '{"apiVersion":"v1","kind":"error","error":"invalid-request"}';
const UNAUTH = '{"apiVersion":"v1","kind":"error","error":"unauthenticated-service"}';
const NOT_FOUND = '{"apiVersion":"v1","kind":"error","error":"not-found-or-forbidden"}';
const REVOKED = '{"apiVersion":"v1","kind":"revoked"}';
const T0 = Date.now();

const k = serviceKey();
let w: Awaited<ReturnType<typeof startWorker>>;
let s: Seeded;
before(async () => { w = await startWorker({ keys: { [k.keyId]: k.secret } }); s = await seed(w.db, T0); });
after(async () => { await w.mf.dispose(); });

let clock = T0;
const deps = () => ({
  repos: () => d1Repositories(w.db), db: () => w.db, keys: () => parseServiceKeys(JSON.stringify({ [k.keyId]: k.secret })),
  audience: AUDIENCE, nonces: new NonceWindow(), limiter: new RateLimiter(1000, 1000), sessionLimiter: new RateLimiter(1000, 1000),
  now: () => clock, log: () => {}, random: () => 1,
});

async function req(method: string, path: string, o: { body?: string; token?: string; contentType?: string; signBody?: string } = {}) {
  const h: Record<string, string> = await signRequest({ keyId: k.keyId, secret: k.secret, method, path, body: o.signBody ?? o.body ?? '',
    viewerToken: o.token ?? '', nowMs: clock, nonce: randomNonce() });
  if (o.token !== undefined) h[VIEWER_HEADER] = o.token;
  if (o.body !== undefined) h['content-type'] = o.contentType ?? 'application/json';
  const r = await handle(new Request(BASE + path, { method, headers: h, ...(o.body !== undefined ? { body: o.body } : {}) }), deps());
  return { status: r.status, text: await r.text() };
}
const exchange = (code: string) => req('POST', '/v1/sessions', { body: JSON.stringify({ invitation: code }) });
const invite = (tenantId: string, viewerId: string, ttlMs?: number) => createInvitation(w.db, { tenantId, viewerId, nowMs: clock, ...(ttlMs ? { ttlMs } : {}) });
const read = (id: string, token: string) => req('GET', `/v1/invoices/${id}/authoritative`, { token });
async function login(tenant = 'tenant-a', viewer = 'demo-viewer') {
  const { code } = await invite(tenant, viewer);
  const r = await exchange(code);
  assert.equal(r.status, 200, r.text);
  const body = JSON.parse(r.text);
  assert.ok(parseSessionOrListResponse(body));
  return body as { token: string; expiresAtMs: number; idleTimeoutMs: number };
}

describe('S1 invitation exchange', () => {
  test('a valid invitation yields a session (12 h absolute, 30 min idle) whose token is stored only hashed', async () => {
    clock = T0;
    const sess = await login();
    assert.equal(sess.expiresAtMs, clock + SESSION_ABSOLUTE_MS);
    assert.equal(sess.idleTimeoutMs, SESSION_IDLE_MS);
    assert.match(sess.token, /^[A-Za-z0-9_-]{43}$/);
    const row = await w.db.prepare('SELECT * FROM viewer_sessions WHERE token_sha256 = ?').bind(await sha256Hex(sess.token)).first<Record<string, unknown>>();
    assert.equal(row!.tenant_id, 'tenant-a'); assert.equal(row!.viewer_id, 'demo-viewer');
    assert.match(String(row!.created_from), /^[a-f0-9]{64}$/);
    const raw = JSON.stringify(await w.db.prepare('SELECT * FROM viewer_sessions').all());
    assert.ok(!raw.includes(sess.token));
  });
  test('single use: the second exchange of the same code → 403 invalid-credentials, no second session', async () => {
    const { code } = await invite('tenant-a', 'demo-viewer');
    assert.equal((await exchange(code)).status, 200);
    const before = (await w.db.prepare('SELECT count(*) c FROM viewer_sessions').first<{ c: number }>())!.c;
    const again = await exchange(code);
    assert.equal(again.status, 403); assert.equal(again.text, INVALID);
    assert.equal((await w.db.prepare('SELECT count(*) c FROM viewer_sessions').first<{ c: number }>())!.c, before);
    assert.match(String((await w.db.prepare('SELECT code_sha256 FROM viewer_invitations WHERE code_sha256 = ?').bind(await sha256Hex(code)).first<Record<string, unknown>>())!.code_sha256), /^[a-f0-9]{64}$/);
  });
  test('concurrent exchanges of one code: exactly one session', async () => {
    const { code } = await invite('tenant-a', 'demo-viewer');
    const rs = await Promise.all(Array.from({ length: 6 }, () => exchange(code)));
    assert.equal(rs.filter(r => r.status === 200).length, 1);
    for (const r of rs.filter(r => r.status !== 200)) { assert.equal(r.status, 403); assert.equal(r.text, INVALID); }
  });
  test('expired (at and after expiry) and unknown invitations → identical 403', async () => {
    const { code, expiresAtMs } = await invite('tenant-a', 'demo-viewer', 60_000);
    const saved = clock;
    clock = expiresAtMs;
    const r1 = await exchange(code);
    assert.equal(r1.status, 403); assert.equal(r1.text, INVALID);
    clock = saved;
    const r2 = await exchange(randomToken());
    assert.equal(r2.status, 403); assert.equal(r2.text, INVALID);
    // The expired code was not consumed by the failed attempt, but it can never become valid again.
    assert.equal((await w.db.prepare('SELECT used_at_ms FROM viewer_invitations WHERE code_sha256 = ?').bind(await sha256Hex(code)).first<Record<string, unknown>>())!.used_at_ms, null);
  });
  test('malformed bodies → 400 invalid-request', async () => {
    for (const body of ['', 'not json', '[]', '{}', '{"invitation":"short"}', JSON.stringify({ invitation: randomToken(), extra: 1 }),
      JSON.stringify({ invitation: 'x'.repeat(40) + '!' })]) {
      const r = await req('POST', '/v1/sessions', { body });
      assert.equal(r.status, 400, body); assert.equal(r.text, BAD);
    }
  });
  test('body larger than MAX_BODY_BYTES → 400 (declared or streamed); invalid UTF-8 → 400', async () => {
    const big = JSON.stringify({ invitation: randomToken(), pad: 'x'.repeat(MAX_BODY_BYTES) });
    const r = await req('POST', '/v1/sessions', { body: big });
    assert.equal(r.status, 400); assert.equal(r.text, BAD);
    const h = await signRequest({ keyId: k.keyId, secret: k.secret, method: 'POST', path: '/v1/sessions', body: '', nowMs: clock, nonce: randomNonce() });
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_BODY_BYTES)); c.enqueue(new Uint8Array(10)); c.close(); } });
    const r2 = await handle(new Request(BASE + '/v1/sessions', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit), deps());
    assert.equal(r2.status, 400); assert.equal(await r2.text(), BAD);
    const r3 = await handle(new Request(BASE + '/v1/sessions', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: new Uint8Array([0xff, 0xfe]) }), deps());
    assert.equal(r3.status, 400); assert.equal(await r3.text(), BAD);
  });
  test('wrong content type → 400; wrong method → 405 with allow: POST', async () => {
    const { code } = await invite('tenant-a', 'demo-viewer');
    const r = await req('POST', '/v1/sessions', { body: JSON.stringify({ invitation: code }), contentType: 'text/plain' });
    assert.equal(r.status, 400); assert.equal(r.text, BAD);
    const g = await handle(new Request(BASE + '/v1/sessions'), deps());
    assert.equal(g.status, 405); assert.equal(g.headers.get('allow'), 'POST');
    assert.equal((await exchange(code)).status, 200, 'the code was not consumed by the rejected requests');
  });
  test('a body tampered after signing → 401, invitation not consumed', async () => {
    const { code } = await invite('tenant-a', 'demo-viewer');
    const r = await req('POST', '/v1/sessions', { body: JSON.stringify({ invitation: code }), signBody: JSON.stringify({ invitation: randomToken() }) });
    assert.equal(r.status, 401); assert.equal(r.text, UNAUTH);
    assert.equal((await exchange(code)).status, 200);
  });
  test('the created session works for its own tenant only', async () => {
    const a = await login('tenant-a', 'demo-viewer');
    assert.equal((await read('inv-a1', a.token)).status, 200);
    for (const id of ['inv-b1', 'inv-a4']) { const r = await read(id, a.token); assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND); }
    const b = await login('tenant-b', 'viewer-b');
    assert.equal((await read('inv-b1', b.token)).status, 200);
    const r = await read('inv-a1', b.token);
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
  });
  test('invitation rows are single-use and immutable at the database (triggers)', async () => {
    const { code } = await invite('tenant-a', 'demo-viewer');
    assert.equal((await exchange(code)).status, 200);
    const h = await sha256Hex(code);
    await assert.rejects(w.db.prepare('UPDATE viewer_invitations SET used_at_ms = NULL, session_sha256 = NULL WHERE code_sha256 = ?').bind(h).run(), /invitation already used/);
    await assert.rejects(w.db.prepare("UPDATE viewer_invitations SET tenant_id = 'tenant-b' WHERE code_sha256 = ?").bind(h).run(), /immutable/);
  });
  test('invitation exchange is rate limited per key id (stricter bucket) → 429', async () => {
    const d = { ...deps(), sessionLimiter: new RateLimiter(2, 0) };
    const codes = [await invite('tenant-a', 'demo-viewer'), await invite('tenant-a', 'demo-viewer'), await invite('tenant-a', 'demo-viewer')];
    const statuses = [];
    for (const { code } of codes) {
      const body = JSON.stringify({ invitation: code });
      const h = await signRequest({ keyId: k.keyId, secret: k.secret, method: 'POST', path: '/v1/sessions', body, nowMs: clock, nonce: randomNonce() });
      statuses.push((await handle(new Request(BASE + '/v1/sessions', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body }), d)).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });
});

describe('S1 through the real Worker (Miniflare)', () => {
  test('exchange, use, reuse refused', async () => {
    const { code } = await createInvitation(w.db, { tenantId: 'tenant-a', viewerId: 'demo-viewer', nowMs: Date.now() });
    const body = JSON.stringify({ invitation: code });
    const post = async () => w.mf.dispatchFetch(BASE + '/v1/sessions', { method: 'POST', body, headers: { 'content-type': 'application/json',
      ...await signRequest({ keyId: k.keyId, secret: k.secret, method: 'POST', path: '/v1/sessions', body, nowMs: Date.now(), nonce: randomNonce() }) } });
    const r = await post();
    assert.equal(r.status, 200);
    const sess = await r.json() as { token: string };
    const path = '/v1/invoices/inv-a1/authoritative';
    const g = await w.mf.dispatchFetch(BASE + path, { headers: { [VIEWER_HEADER]: sess.token,
      ...await signRequest({ keyId: k.keyId, secret: k.secret, method: 'GET', path, viewerToken: sess.token, nowMs: Date.now(), nonce: randomNonce() }) } });
    assert.equal(g.status, 200);
    const again = await post();
    assert.equal(again.status, 403); assert.equal(await again.text(), INVALID);
  });
});

describe('S2 session lifecycle', () => {
  test('idle timeout: unused for 30 min → 404', async () => {
    clock = T0 + 3600_000;
    const sess = await login();
    clock += SESSION_IDLE_MS;
    const r = await read('inv-a1', sess.token);
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
  });
  test('sliding refresh: use every 29 min keeps it alive, but never past the absolute expiry', async () => {
    clock = T0 + 2 * 3600_000;
    const sess = await login();
    let uses = 0;
    while (clock + 29 * 60_000 < sess.expiresAtMs) {
      clock += 29 * 60_000;
      assert.equal((await read('inv-a1', sess.token)).status, 200, `use at +${clock - sess.expiresAtMs + SESSION_ABSOLUTE_MS}`);
      uses++;
    }
    assert.ok(uses >= 24);
    const row = await w.db.prepare('SELECT idle_expires_at_ms, expires_at_ms FROM viewer_sessions WHERE token_sha256 = ?').bind(await sha256Hex(sess.token)).first<Record<string, number>>();
    assert.ok(row!.idle_expires_at_ms <= row!.expires_at_ms);
    clock = sess.expiresAtMs;
    const r = await read('inv-a1', sess.token);
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
    await assert.rejects(w.db.prepare('UPDATE viewer_sessions SET idle_expires_at_ms = expires_at_ms + 1 WHERE token_sha256 = ?').bind(await sha256Hex(sess.token)).run(), /idle expiry beyond absolute/);
  });
  test('absolute expiry: a session used continuously still dies at 12 h', async () => {
    clock = T0 + 20 * 3600_000;
    const sess = await login();
    let last = clock;
    for (let t = clock + 20 * 60_000; t < sess.expiresAtMs; t += 20 * 60_000) { clock = t; last = t; assert.equal((await read('inv-a1', sess.token)).status, 200); }
    assert.ok(sess.expiresAtMs - last <= 20 * 60_000, 'idle window still open at expiry, so only the absolute limit applies');
    clock = sess.expiresAtMs;
    assert.equal((await read('inv-a1', sess.token)).status, 404);
    clock = sess.expiresAtMs + 1;
    assert.equal((await read('inv-a1', sess.token)).status, 404);
  });
  test('revoke then use → 404; revoke is idempotent; revocation cannot be undone', async () => {
    clock = T0 + 40 * 3600_000;
    const sess = await login();
    assert.equal((await read('inv-a1', sess.token)).status, 200);
    const r1 = await req('DELETE', '/v1/sessions/current', { token: sess.token });
    assert.equal(r1.status, 200); assert.equal(r1.text, REVOKED);
    const r = await read('inv-a1', sess.token);
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
    const list = await req('GET', '/v1/invoices', { token: sess.token });
    assert.equal(list.status, 404); assert.equal(list.text, NOT_FOUND);
    const r2 = await req('DELETE', '/v1/sessions/current', { token: sess.token });
    assert.equal(r2.status, 200); assert.equal(r2.text, REVOKED);
    await assert.rejects(w.db.prepare('UPDATE viewer_sessions SET revoked_at_ms = NULL WHERE token_sha256 = ?').bind(await sha256Hex(sess.token)).run(), /revocation is final/);
  });
  test('unknown-token revoke → revoked (no oracle); malformed token → 404', async () => {
    const r = await req('DELETE', '/v1/sessions/current', { token: randomToken() });
    assert.equal(r.status, 200); assert.equal(r.text, REVOKED);
    const m = await req('DELETE', '/v1/sessions/current', { token: 'short' });
    assert.equal(m.status, 404); assert.equal(m.text, NOT_FOUND);
  });
  test('operator revoke of a viewer kills all its sessions, not other viewers\'', async () => {
    clock = T0 + 50 * 3600_000;
    const a1 = await login(), a2 = await login(), b = await login('tenant-b', 'viewer-b');
    assert.ok(await revokeViewerSessions(w.db, 'tenant-a', 'demo-viewer', clock) >= 2);
    for (const t of [a1.token, a2.token]) assert.equal((await read('inv-a1', t)).status, 404);
    assert.equal((await read('inv-b1', b.token)).status, 200);
  });
});

describe('GET /v1/invoices (permitted list)', () => {
  test('only permitted invoices of the viewer\'s own tenant; cross-tenant never listed', async () => {
    clock = T0 + 60 * 3600_000;
    const a = await login();
    const r = await req('GET', '/v1/invoices', { token: a.token });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.ok(parseSessionOrListResponse(body));
    assert.deepEqual(body.invoices.map((i: { id: string }) => i.id), ['inv-a1', 'inv-a2', 'inv-a3']);
    const a1 = s.invoices['inv-a1'].invoice;
    assert.deepEqual(body.invoices[0], { id: 'inv-a1', revision: 1, targetAtomic: a1.buyAmount, maxDebitAtomic: a1.maxSell });
    // A permission row pointing at another tenant's invoice is never listed (tenant directory + invoice tenant join).
    await w.db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-a', 'demo-viewer', 'inv-b1', 'invoice:read')").run();
    const r2 = JSON.parse((await req('GET', '/v1/invoices', { token: a.token })).text);
    assert.ok(!r2.invoices.some((i: { id: string }) => i.id === 'inv-b1'));
    const none = await login('tenant-a', 'viewer-a-none');
    assert.equal((await req('GET', '/v1/invoices', { token: none.token })).text, '{"apiVersion":"v1","kind":"invoice-list","invoices":[]}');
    const bad = await req('GET', '/v1/invoices', { token: randomToken() });
    assert.equal(bad.status, 404); assert.equal(bad.text, NOT_FOUND);
  });
  test('a tampered row is skipped; the list is capped at MAX_LIST', async () => {
    clock = T0 + 70 * 3600_000;
    const stmts = [];
    for (let i = 0; i < MAX_LIST + 5; i++) {
      const id = `inv-l${String(i).padStart(3, '0')}`;
      const si = await signedInvoice(id, T0);
      stmts.push(w.db.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, 1)').bind('tenant-l', id, JSON.stringify(si.invoice), si.digest));
      stmts.push(w.db.prepare('INSERT INTO tenant_directory VALUES (?, ?)').bind(id, 'tenant-l'));
      stmts.push(w.db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-l', 'lister', ?, 'invoice:read')").bind(id));
    }
    await w.db.batch(stmts);
    await w.db.prepare("UPDATE invoices SET body = json_set(body, '$.buyAmount', '1') WHERE invoice_id = 'inv-l000'").run();
    const t = await login('tenant-l', 'lister');
    const body = JSON.parse((await req('GET', '/v1/invoices', { token: t.token })).text);
    assert.equal(body.kind, 'invoice-list');
    assert.ok(body.invoices.length <= MAX_LIST && body.invoices.length >= MAX_LIST - 1);
    assert.ok(!body.invoices.some((i: { id: string }) => i.id === 'inv-l000'));
  });
});

describe('optional chain hook', () => {
  test('unset by default: no chain reader', () => {
    assert.equal(chainFromEnv({}), undefined);
    assert.equal(chainFromEnv({ DAIDAI_ATTRIBUTION_CODE: 'x' }), undefined);
  });
  test('https and loopback http accepted; anything else rejected; attribution code required', () => {
    assert.equal(chainRpcUrl('https://forno.celo.org'), 'https://forno.celo.org/');
    assert.equal(chainRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545/');
    for (const bad of ['http://forno.celo.org', 'http://localhost:8545', 'ftp://x', 'https://u:p@x.org', 'not a url', 'file:///etc/passwd']) assert.equal(chainRpcUrl(bad), undefined, bad);
    const urls: string[] = [];
    const fake = ((o: { url: string }) => { urls.push(o.url); return async () => null; }) as unknown as Parameters<typeof chainFromEnv>[1];
    assert.equal(chainFromEnv({ DAIDAI_CHAIN_RPC_URL: 'http://127.0.0.1:8545' }, fake), undefined);
    const c = chainFromEnv({ DAIDAI_CHAIN_RPC_URL: 'http://127.0.0.1:8545', DAIDAI_ATTRIBUTION_CODE: 'daidai' }, fake);
    assert.equal(c?.attributionCode, 'daidai'); assert.deepEqual(urls, ['http://127.0.0.1:8545/']);
    assert.equal(chainFromEnv({ DAIDAI_CHAIN_RPC_URL: 'http://10.0.0.1', DAIDAI_ATTRIBUTION_CODE: 'daidai' }, fake), undefined);
    assert.equal(typeof chainFromEnv({ DAIDAI_CHAIN_RPC_URL: 'http://127.0.0.1:1', DAIDAI_ATTRIBUTION_CODE: 'd' })?.rpc, 'function', 'real createCeloRpc wired');
  });
});

test('rotation consumes a valid invite atomically and revokes only the prior browser session', async () => {
  clock = T0 + 200;
  const prior = await login();
  const other = await login();
  const secondInvite = await invite('tenant-a', 'demo-viewer');
  const response = await req('POST', '/v1/sessions', { token: prior.token, body: JSON.stringify({ invitation: secondInvite.code }) });
  assert.equal(response.status, 200);
  const replacement = JSON.parse(response.text) as { token: string };
  assert.notEqual(replacement.token, prior.token);
  assert.equal((await read('inv-a1', replacement.token)).status, 200);
  assert.equal((await read('inv-a1', prior.token)).status, 404);
  assert.equal((await read('inv-a1', other.token)).status, 200);
  const row = await w.db.prepare('SELECT rotated_from FROM viewer_sessions WHERE token_sha256 = ?')
    .bind(await sha256Hex(replacement.token)).first<{ rotated_from: string }>();
  assert.equal(row?.rotated_from, await sha256Hex(prior.token));
  const reuse = await req('POST', '/v1/sessions', { token: other.token, body: JSON.stringify({ invitation: secondInvite.code }) });
  assert.equal(reuse.status, 403);
  assert.equal((await read('inv-a1', other.token)).status, 200);
});
