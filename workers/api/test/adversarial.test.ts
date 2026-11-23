// P10.4 independent adversarial suite (Agent C/D) against the Worker boundary, D1 repositories, projection integrity and
// the D1 lineage writer. Local Miniflare/workerd and node:sqlite temp files only. Every key, token and signature is
// generated at runtime; nothing touches a network. Each negative asserts the specific status/body/message.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWER_HEADER } from '../../../src/api-contract.ts';
import { AttemptLineageReader, AttemptLineageStore, type NewAttempt } from '../../../src/attempt-lineage.ts';
import type { CanonicalBlockObservation, ObservedTransaction } from '../../../src/authoritative-invoice.ts';
import { attest } from '../../../src/evidence-attestation.ts';
import { commit } from '../../../src/invoice-core.ts';
import { NonceWindow, SERVICE_HEADERS, sha256Hex, signRequest, verifyRequest } from '../../../src/service-auth.ts';
import { d1Attempts, d1Permissions, d1Repositories, d1Sessions } from '../src/d1-repositories.ts';
import { D1LineageWriter } from '../src/d1-lineage.ts';
import { applySchema, type D1Like, type D1Stmt } from '../src/d1-schema.ts';
import { RateLimiter, handle, parseServiceKeys, type LogLine } from '../src/handler.ts';
import { AUDIENCE, randomNonce, randomToken, seed, serviceKey, signedHeaders, signedInvoice, startWorker, type Seeded } from './fixtures.ts';

const k = serviceKey();
const BASE = 'http://api.local';
const UNAUTH = '{"apiVersion":"v1","kind":"error","error":"unauthenticated-service"}';
const NOT_FOUND = '{"apiVersion":"v1","kind":"error","error":"not-found-or-forbidden"}';
const INVALID = '{"apiVersion":"v1","kind":"error","error":"invalid-request"}';
const NOT_ALLOWED = '{"apiVersion":"v1","kind":"error","error":"method-not-allowed"}';
const ip = (id: string) => `/v1/invoices/${id}/authoritative`;

let w: Awaited<ReturnType<typeof startWorker>>;
let db: D1Like;
let s: Seeded;
const NOW = Date.now();

/** Extra tenant-a invoices readable by demo-viewer, each a target for one tampering. */
const extra = ['inv-t-body', 'inv-t-rev', 'inv-t-swap', 'inv-t-xtenant-sig', 'inv-t-forged-final', 'inv-t-xtenant-att', 'inv-t-badjson', 'inv-t-recommit'] as const;
type Extra = typeof extra[number];
const ex = {} as Record<Extra, Awaited<ReturnType<typeof signedInvoice>>>;

before(async () => {
  // An object-literal '__proto__' key would set the prototype; define it as an own property so JSON carries it.
  const keys: Record<string, string> = { [k.keyId]: k.secret };
  Object.defineProperty(keys, '__proto__', { value: 'p'.repeat(40), enumerable: true });
  w = await startWorker({ keys });
  db = w.db;
  s = await seed(db, NOW);
  const stmts: D1Stmt[] = [];
  for (const id of extra) {
    const inv = ex[id] = await signedInvoice(id, NOW);
    stmts.push(db.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, 1)').bind('tenant-a', id, JSON.stringify(inv.invoice), inv.digest));
    stmts.push(db.prepare('INSERT INTO tenant_directory VALUES (?, ?)').bind(id, 'tenant-a'));
    stmts.push(db.prepare('INSERT INTO signatures VALUES (?, ?, ?, ?, ?)').bind('tenant-a', id, inv.digest, inv.approval, inv.consent));
    stmts.push(db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-a', 'demo-viewer', ?, 'invoice:read')").bind(id));
  }
  await db.batch(stmts);
});
after(async () => { await w.mf.dispose(); });

type Res = { status: number; headers: [string, string][]; text: string };
async function send(path: string, headers: HeadersInit, init: RequestInit = {}): Promise<Res> {
  const r = await w.mf.dispatchFetch(BASE + path, { headers, ...init } as never);
  const hs: [string, string][] = [];
  r.headers.forEach((v: string, n: string) => hs.push([n, v]));
  return { status: r.status, headers: hs.sort(), text: await r.text() };
}
const asDemo = async (id: string, token = s.tokens.demo) => send(ip(id), await signedHeaders({ ...k, path: ip(id), viewerToken: token }));
const proj = async (id: string) => { const r = await asDemo(id); return { status: r.status, body: JSON.parse(r.text) }; };
function noCorsNoCookie(r: Res) {
  for (const [n] of r.headers) {
    assert.ok(!n.startsWith('access-control-'), `CORS header ${n}`);
    assert.notEqual(n, 'set-cookie');
  }
}

// ───────────────────────────── 1. HTTP boundary ─────────────────────────────
describe('ADV-1 Worker HTTP boundary', () => {
  test('percent-encoded alias: signature binds the RAW path; a signature for inv-a1 does not authorize inv%2Da1 and vice versa', async () => {
    const raw = '/v1/invoices/inv%2Da1/authoritative';
    // Signed over the raw spelling: accepted, and it reads exactly the decoded id (no other invoice).
    const okAlias = await send(raw, await signedHeaders({ ...k, path: raw, viewerToken: s.tokens.demo }));
    assert.equal(okAlias.status, 200);
    assert.equal(JSON.parse(okAlias.text).invoice.id, 'inv-a1');
    // Cross use in both directions fails authentication: no decoded-vs-raw confusion.
    const a = await send(raw, await signedHeaders({ ...k, path: ip('inv-a1'), viewerToken: s.tokens.demo }));
    assert.equal(a.status, 401); assert.equal(a.text, UNAUTH);
    const b = await send(ip('inv-a1'), await signedHeaders({ ...k, path: raw, viewerToken: s.tokens.demo }));
    assert.equal(b.status, 401); assert.equal(b.text, UNAUTH);
    // Lowercase hex escape is yet another raw spelling: still needs its own signature.
    const lower = '/v1/invoices/inv%2da1/authoritative';
    const c = await send(lower, await signedHeaders({ ...k, path: raw, viewerToken: s.tokens.demo }));
    assert.equal(c.status, 401);
  });

  test('dot segments are normalized before signing on both sides; a signature over the un-normalized path fails closed', async () => {
    const dotted = '/v1/invoices/inv-zz/../inv-a1/authoritative'; // URL normalizes to /v1/invoices/inv-a1/authoritative
    const r = await send(dotted, await signedHeaders({ ...k, path: dotted, viewerToken: s.tokens.demo }));
    assert.equal(r.status, 401); assert.equal(r.text, UNAUTH);
  });

  test('newline / CR / NUL injection in the path cannot reach the canonical string (decoded id is rejected → 400)', async () => {
    for (const enc of ['%0A', '%0D', '%00', '%0A1700000000000%0A']) {
      const p = `/v1/invoices/inv-a1${enc}/authoritative`;
      const r = await send(p, await signedHeaders({ ...k, path: p, viewerToken: s.tokens.demo }));
      assert.equal(r.status, 400, enc); assert.equal(r.text, INVALID);
    }
    // Raw newline in headers is refused by the Headers implementation itself.
    assert.throws(() => new Headers({ [SERVICE_HEADERS.nonce]: 'aaaaaaaaaaaaaaaa\nx' }));
  });

  test('canonical string: a path carrying the separator cannot collide with a different (path, timestamp, nonce) split', async () => {
    const secret = 'z'.repeat(40), keys = { kid: secret }, now = 1_800_000_000_000;
    const forgedPath = `/v1/health\n${now}\nnonce-aaaaaaaaaaaaaa`;
    const h = await signRequest({ keyId: 'kid', secret, method: 'GET', path: forgedPath, nowMs: now, nonce: 'nonce-bbbbbbbbbbbbbb' });
    // Re-splitting the same bytes as path=/v1/health, ts=now, nonce=nonce-aaaa… does not verify (hash fields fix arity).
    const ok = await verifyRequest({ keys, headers: new Headers({ ...h, [SERVICE_HEADERS.nonce]: 'nonce-aaaaaaaaaaaaaa' }), method: 'GET',
      path: '/v1/health', body: '', viewerToken: '', nowMs: now, nonces: new NonceWindow() });
    assert.equal(ok, false);
  });

  test('duplicated auth headers are joined by Headers (", ") and fail format checks → 401', async () => {
    const h = await signedHeaders({ ...k, path: '/v1/health' });
    for (const name of Object.values(SERVICE_HEADERS)) {
      const pairs: [string, string][] = Object.entries(h);
      pairs.push([name, h[name]]);
      const r = await send('/v1/health', pairs);
      assert.equal(r.status, 401, name); assert.equal(r.text, UNAUTH);
    }
  });

  test('header name case does not matter; uppercase names verify identically', async () => {
    const h = await signedHeaders({ ...k, path: '/v1/health' });
    const upper = Object.fromEntries(Object.entries(h).map(([n, v]) => [n.toUpperCase(), v]));
    assert.equal((await send('/v1/health', upper)).status, 200);
  });

  test('oversized viewer header: valid service auth, malformed token → uniform 404; huge header never yields data or CORS', async () => {
    const big = 'a'.repeat(257);
    const r = await send(ip('inv-a1'), await signedHeaders({ ...k, path: ip('inv-a1'), viewerToken: big }));
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
    const huge = 'a'.repeat(60_000);
    const r2 = await send(ip('inv-a1'), await signedHeaders({ ...k, path: ip('inv-a1'), viewerToken: huge }));
    assert.equal(r2.status, 404); assert.equal(r2.text, NOT_FOUND);
    noCorsNoCookie(r2);
  });

  test('key id prototype names: constructor/toString/hasOwnProperty are unknown → 401; a configured "__proto__" key is an own key', async () => {
    for (const keyId of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = await send('/v1/health', await signedHeaders({ keyId, secret: k.secret, path: '/v1/health' }));
      assert.equal(r.status, 401, keyId); assert.equal(r.text, UNAUTH);
    }
    // __proto__ was configured as a real key in DAIDAI_SERVICE_KEYS (JSON own property): it works, with its own secret only.
    const good = await send('/v1/health', await signedHeaders({ keyId: '__proto__', secret: 'p'.repeat(40), path: '/v1/health' }));
    assert.equal(good.status, 200);
    const bad = await send('/v1/health', await signedHeaders({ keyId: '__proto__', secret: k.secret, path: '/v1/health' }));
    assert.equal(bad.status, 401);
    // parseServiceKeys returns a null-prototype object: inherited names are never present.
    const keys = parseServiceKeys(JSON.stringify({ a: 'x'.repeat(32) }))!;
    for (const n of ['constructor', 'toString', '__proto__']) assert.equal(Object.hasOwn(keys, n), false);
    assert.equal(Object.getPrototypeOf(keys), null);
    // A plain-object keys map (not via parseServiceKeys) is also safe: hasOwn, not `in`.
    assert.equal(await verifyRequest({ keys: { a: 'x'.repeat(32) }, headers: new Headers(await signRequest({ keyId: 'toString', secret: 'x'.repeat(32),
      method: 'GET', path: '/v1/health', nowMs: NOW, nonce: randomNonce() })), method: 'GET', path: '/v1/health', body: '', viewerToken: '',
      nowMs: NOW, nonces: new NonceWindow() }), false);
  });

  test('timestamp formats: seconds, decimals, signs, padding, exponent and hex are refused → 401', async () => {
    for (const ts of [String(Math.floor(NOW / 1000)), `${NOW}.0`, `+${NOW}`, ` ${NOW}`, `0${NOW}`, '1.7e12', '0x' + NOW.toString(16), `${NOW}`.padStart(14, '0')]) {
      const h = await signedHeaders({ ...k, path: '/v1/health' });
      const r = await send('/v1/health', { ...h, [SERVICE_HEADERS.timestamp]: ts });
      assert.equal(r.status, 401, ts); assert.equal(r.text, UNAUTH);
    }
  });

  test('replay of the same request under a different key id fails (signature is per key)', async () => {
    const k2 = serviceKey();
    const w2 = await startWorker({ keys: { [k.keyId]: k.secret, [k2.keyId]: k2.secret } });
    try {
      await applySchema(w2.db); // P10.5: the global nonce store must exist, or every request fails closed with 503
      const nonce = randomNonce();
      const h = await signedHeaders({ ...k, path: '/v1/health', nonce });
      const r1 = await w2.mf.dispatchFetch(BASE + '/v1/health', { headers: h });
      assert.equal(r1.status, 200);
      const r2 = await w2.mf.dispatchFetch(BASE + '/v1/health', { headers: { ...h, [SERVICE_HEADERS.keyId]: k2.keyId } });
      assert.equal(r2.status, 401); assert.equal(await r2.text(), UNAUTH);
      // The same nonce under the second key's own valid signature is a distinct (keyId, nonce) and is accepted once.
      const h2 = await signedHeaders({ ...k2, path: '/v1/health', nonce });
      assert.equal((await w2.mf.dispatchFetch(BASE + '/v1/health', { headers: h2 })).status, 200);
      assert.equal((await w2.mf.dispatchFetch(BASE + '/v1/health', { headers: h2 })).status, 401);
    } finally { await w2.mf.dispose(); }
  });

  test('nonce reuse after the window: the signature is stale by then, so a late replay is still refused by the skew check', async () => {
    const nonces = new NonceWindow();
    const keys = { kid: 'q'.repeat(40) };
    const t0 = 1_800_000_000_000;
    const h = new Headers(await signRequest({ keyId: 'kid', secret: keys.kid, method: 'GET', path: '/v1/health', nowMs: t0, nonce: 'n'.repeat(20) }));
    const v = (now: number) => verifyRequest({ keys, headers: h, method: 'GET', path: '/v1/health', body: '', viewerToken: '', nowMs: now, nonces });
    assert.equal(await v(t0), true);
    assert.equal(await v(t0 + 59_000), false); // replay inside window
    assert.equal(await v(t0 + 121_000), false); // nonce expired from the window, but timestamp skew > 60 s
  });

  test('OBSERVATION: NonceWindow evicts the oldest entries once over `max`, so a nonce can be replayed inside the skew window after max+1 claims (per isolate)', () => {
    const nw = new NonceWindow(120_000, 3);
    const t = 1_800_000_000_000;
    for (const n of ['a', 'b', 'c', 'd', 'e']) assert.equal(nw.claim(n, t), true);
    // 'a' was evicted by the size bound although it is well within the TTL.
    assert.equal(nw.claim('a', t + 1), true);
  });

  test('rate limit: per key id, applied only after authentication; unauthenticated floods do not drain the bucket', async () => {
    const limiter = new RateLimiter(2, 0);
    const deps = { repos: () => d1Repositories(db), db: () => db, keys: () => parseServiceKeys(JSON.stringify({ [k.keyId]: k.secret })), audience: AUDIENCE,
      nonces: new NonceWindow(), limiter, now: () => Date.now(), log: () => {} };
    const call = async (headers: Record<string, string>) => handle(new Request(BASE + '/v1/health', { headers }), deps);
    for (let i = 0; i < 20; i++) assert.equal((await call({ ...await signedHeaders({ ...k, path: '/v1/health' }), [SERVICE_HEADERS.signature]: '0'.repeat(64) })).status, 401);
    assert.equal((await call(await signedHeaders({ ...k, path: '/v1/health' }))).status, 200);
    assert.equal((await call(await signedHeaders({ ...k, path: '/v1/health' }))).status, 200);
    const limited = await call(await signedHeaders({ ...k, path: '/v1/health' }));
    assert.equal(limited.status, 429);
    assert.equal(await limited.text(), '{"apiVersion":"v1","kind":"error","error":"rate-limited"}');
    // Varying the key id to an unknown one does not open a fresh bucket: unknown key ids never pass auth.
    assert.equal((await call(await signedHeaders({ keyId: 'other-' + k.keyId, secret: k.secret, path: '/v1/health' }))).status, 401);
  });

  test('HEAD / TRACE / OPTIONS / CONNECT-like methods are refused with 405 and no body data', async () => {
    for (const method of ['HEAD', 'OPTIONS', 'PROPFIND', 'get']) {
      const r = await send(ip('inv-a1'), await signedHeaders({ ...k, path: ip('inv-a1'), viewerToken: s.tokens.demo }), { method });
      if (method === 'get') { assert.equal(r.status, 200, 'fetch normalizes lower-case get to GET'); continue; }
      assert.equal(r.status, 405, method);
      if (method !== 'HEAD') assert.equal(r.text, NOT_ALLOWED);
      else assert.equal(r.text, '');
      assert.ok(r.headers.some(([n, v]) => n === 'allow' && v === 'GET'));
      noCorsNoCookie(r);
    }
    // TRACE is rejected by the fetch implementation before reaching the Worker.
    await assert.rejects(send(ip('inv-a1'), {}, { method: 'TRACE' }));
  });

  test('Origin (any value, including "null") → 401; OBSERVATION: Referer / Sec-Fetch-* alone are not rejected (only a signed request gets through)', async () => {
    for (const origin of ['null', 'http://127.0.0.1:3000']) {
      const r = await send('/v1/health', { ...await signedHeaders({ ...k, path: '/v1/health' }), origin });
      assert.equal(r.status, 401, JSON.stringify(origin)); assert.equal(r.text, UNAUTH);
      noCorsNoCookie(r);
    }
    // Miniflare 4's transport can remove an empty header. Test its presence at the same handler boundary directly.
    const empty = new Request(BASE + '/v1/health', { headers: { ...await signedHeaders({ ...k, path: '/v1/health' }), origin: '' } });
    assert.equal(empty.headers.has('origin'), true);
    const denied = await handle(empty, {
      repos: () => { throw Error('unexpected invoice access'); },
      db: () => { throw Error('unexpected database access'); },
      keys: () => { throw Error('unexpected service authentication'); },
      audience: AUDIENCE, nonces: new NonceWindow(), limiter: new RateLimiter(), now: Date.now, log: () => {},
    });
    assert.equal(denied.status, 401);
    assert.equal(await denied.text(), UNAUTH);
    const r = await send(ip('inv-a1'), { ...await signedHeaders({ ...k, path: ip('inv-a1'), viewerToken: s.tokens.demo }),
      referer: 'https://evil.example/', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' });
    assert.equal(r.status, 200);
    noCorsNoCookie(r);
    const unsigned = await send(ip('inv-a1'), { [VIEWER_HEADER]: s.tokens.demo, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' });
    assert.equal(unsigned.status, 401);
  });

  test('every denial is byte-identical (status, headers, body): unknown invoice, forbidden, cross-tenant, expired session, malformed token', async () => {
    const rs = [
      await asDemo('inv-zz'), await asDemo('inv-a4'), await asDemo('inv-b1'), await asDemo('inv-a1', s.tokens.expired),
      await asDemo('inv-a1', s.tokens.viewerB), await asDemo('inv-a1', s.tokens.noPermission), await asDemo('inv-a1', randomToken()),
      await asDemo('inv-a1', 'short'),
    ];
    for (const r of rs) {
      assert.equal(r.status, 404);
      assert.equal(r.text, NOT_FOUND);
      assert.deepEqual(r.headers, rs[0].headers);
      noCorsNoCookie(r);
    }
  });
});

// ───────────────────────────── 2. Viewer / session / permission ─────────────────────────────
function recording(inner: D1Like, log: string[]): D1Like {
  const wrap = (stmt: D1Stmt, sql: string): D1Stmt => ({
    bind: (...v) => wrap(stmt.bind(...v), sql),
    first: () => { log.push(sql); return stmt.first(); },
    all: () => { log.push(sql); return stmt.all(); },
    run: () => { log.push(sql); return stmt.run(); },
  });
  return { prepare: sql => wrap(inner.prepare(sql), sql), batch: st => { log.push('BATCH'); return inner.batch(st); } };
}
function harness(now: number) {
  const sql: string[] = [], lines: LogLine[] = [];
  const deps = { repos: () => d1Repositories(recording(db, sql)), db: () => recording(db, sql), keys: () => parseServiceKeys(JSON.stringify({ [k.keyId]: k.secret })),
    audience: AUDIENCE, nonces: new NonceWindow(), limiter: new RateLimiter(), now: () => now, log: (l: LogLine) => lines.push(l) };
  const call = async (id: string, token: string) => {
    const r = await handle(new Request(BASE + ip(id), { headers: await signedHeaders({ ...k, path: ip(id), viewerToken: token, nowMs: now }) }), deps);
    return { status: r.status, text: await r.text() };
  };
  return { sql, call };
}
const touchesData = (sql: string[]) => sql.filter(q => /FROM (invoices|signatures|attempts|attempt_events)\b/.test(q));
async function addSession(token: string, viewer: string, tenant: string, authAt: unknown, expires: unknown) {
  await db.prepare('INSERT INTO viewer_sessions (token_sha256, viewer_id, tenant_id, authenticated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)').bind(await sha256Hex(token), viewer, tenant, authAt, expires).run();
}

describe('ADV-2 viewer, session and permission', () => {
  test('session expiry boundary: expires == now is denied, now+1 allowed; authenticated_at in the future denied; no data query on denial', async () => {
    const T = NOW + 10_000;
    const atNow = randomToken(), plus1 = randomToken(), futureAuth = randomToken(), authEqNow = randomToken();
    await addSession(atNow, 'demo-viewer', 'tenant-a', T - 1000, T);
    await addSession(plus1, 'demo-viewer', 'tenant-a', T - 1000, T + 1);
    await addSession(futureAuth, 'demo-viewer', 'tenant-a', T + 1, T + 3600_000);
    await addSession(authEqNow, 'demo-viewer', 'tenant-a', T, T + 3600_000);
    for (const tok of [atNow, futureAuth]) {
      const h = harness(T);
      const r = await h.call('inv-a1', tok);
      assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
      assert.deepEqual(touchesData(h.sql), []);
    }
    for (const tok of [plus1, authEqNow]) assert.equal((await harness(T).call('inv-a1', tok)).status, 200);
  });

  test('non-integer timestamps and malformed viewer/tenant ids in a session row are denied (numeric text is coerced by INTEGER affinity)', async () => {
    // INTEGER column affinity stores '123' as 123, so numeric text behaves like the integer (benign, not a bypass).
    const coerced = randomToken();
    await addSession(coerced, 'demo-viewer', 'tenant-a', String(NOW - 1000), String(NOW + 3600_000));
    assert.equal((await harness(NOW).call('inv-a1', coerced)).status, 200);
    const cases: [string, string, unknown, unknown][] = [
      ['demo-viewer', 'tenant-a', NOW - 1000.5, NOW + 3600_000],
      ['demo-viewer', 'tenant-a', NOW - 1000, NOW + 3600_000.25],
      ['demo-viewer', 'tenant-a', 'yesterday', NOW + 3600_000],
      ['demo viewer', 'tenant-a', NOW - 1000, NOW + 3600_000],
      ['demo-viewer', "tenant-a' OR 1=1", NOW - 1000, NOW + 3600_000],
    ];
    for (const [v, t, a, e] of cases) {
      const tok = randomToken();
      await addSession(tok, v, t, a, e);
      const h = harness(NOW);
      const r = await h.call('inv-a1', tok);
      assert.equal(r.status, 404, JSON.stringify([v, t, a, e])); assert.equal(r.text, NOT_FOUND);
      assert.deepEqual(touchesData(h.sql), []);
    }
  });

  test('token hash: uppercase-hex stored hash never matches; a token differing only in case is a different session', async () => {
    const tok = randomToken();
    await db.prepare('INSERT INTO viewer_sessions (token_sha256, viewer_id, tenant_id, authenticated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)').bind((await sha256Hex(tok)).toUpperCase(), 'demo-viewer', 'tenant-a', NOW - 1000, NOW + 3600_000).run();
    assert.equal((await harness(NOW).call('inv-a1', tok)).status, 404);
    const lowerVariant = s.tokens.demo.toLowerCase() === s.tokens.demo ? s.tokens.demo.toUpperCase() : s.tokens.demo.toLowerCase();
    assert.equal((await harness(NOW).call('inv-a1', lowerVariant)).status, 404);
    // Repository refuses non-hex/uppercase lookups outright (no query).
    const log: string[] = [];
    const sessions = d1Sessions(recording(db, log));
    assert.equal(await sessions.findByTokenHash((await sha256Hex(tok)).toUpperCase()), null);
    assert.equal(await sessions.findByTokenHash("' OR 1=1 --"), null);
    assert.deepEqual(log, []);
  });

  test('tenant mismatch between session, permission and tenant_directory is always denied before any invoice read', async () => {
    // Session says tenant-b, permission row claims tenant-b for inv-a1, but the directory says tenant-a.
    const tok = randomToken();
    await addSession(tok, 'mallory', 'tenant-b', NOW - 1000, NOW + 3600_000);
    await db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-b', 'mallory', 'inv-a1', 'invoice:read')").run();
    // Permission in tenant-a for the same viewer id (but the session is tenant-b).
    await db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-a', 'mallory', 'inv-a1', 'invoice:read')").run();
    // An invoice row for inv-a1 under tenant-b (would leak if the directory were bypassed).
    await db.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, 1)').bind('tenant-b', 'inv-a1', JSON.stringify(s.invoices['inv-a1'].invoice), s.invoices['inv-a1'].digest).run();
    const h = harness(NOW);
    const r = await h.call('inv-a1', tok);
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
    assert.deepEqual(touchesData(h.sql), []);
    // Directory missing entirely for an invoice that has rows and a permission → denied.
    await db.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?, 1)').bind('tenant-a', 'inv-nodir', JSON.stringify(s.invoices['inv-a1'].invoice), s.invoices['inv-a1'].digest).run();
    await db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-a', 'demo-viewer', 'inv-nodir', 'invoice:read')").run();
    const h2 = harness(NOW);
    assert.equal((await h2.call('inv-nodir', s.tokens.demo)).status, 404);
    assert.deepEqual(touchesData(h2.sql), []);
  });

  test('permission rows with other values cannot be stored (CHECK), so they cannot grant', async () => {
    for (const p of ['invoice:write', 'invoice:read ', 'INVOICE:READ', '*']) {
      await assert.rejects(db.prepare('INSERT INTO invoice_permissions VALUES (?, ?, ?, ?)').bind('tenant-a', 'viewer-a-none', 'inv-a1', p).run(),
        /CHECK constraint failed/, p);
    }
    assert.equal((await harness(NOW).call('inv-a1', s.tokens.noPermission)).status, 404);
  });

  test('SQL injection through invoice ids is refused by validation (400) and is inert at the repository (bound params)', async () => {
    for (const id of ["inv-a1'--", 'inv-a1" OR "1"="1', "x' OR '1'='1", 'inv-a1;DROP TABLE invoices', "inv-a1' UNION SELECT 1--"]) {
      const p = ip(encodeURIComponent(id));
      const r = await send(p, await signedHeaders({ ...k, path: p, viewerToken: s.tokens.demo }));
      assert.equal(r.status, 400, id); assert.equal(r.text, INVALID);
    }
    const perms = d1Permissions(db);
    assert.equal(await perms.tenantOfInvoice("x' OR 1=1 --"), null);
    assert.equal(await perms.tenantOfInvoice("' UNION SELECT tenant_id FROM tenant_directory --"), null);
    assert.equal(await perms.canReadInvoice("tenant-a' OR '1'='1", 'demo-viewer', 'inv-a1'), false);
    assert.equal(await perms.canReadInvoice('tenant-a', "x' OR 1=1 --", 'inv-a1'), false);
    // Tables still intact.
    assert.ok(Number((await db.prepare('SELECT count(*) AS c FROM invoices').first<{ c: number }>())!.c) > 5);
  });

  test('read path issues only SELECT statements, never a batch, across allowed and denied requests', async () => {
    const h = harness(NOW);
    for (const [id, tok] of [['inv-a1', s.tokens.demo], ['inv-a2', s.tokens.demo], ['inv-a3', s.tokens.demo], ['inv-b1', s.tokens.demo],
      ['inv-a1', s.tokens.expired], ['inv-t-forged-final', s.tokens.demo]] as const) await h.call(id, tok);
    assert.ok(h.sql.length > 10);
    // P10.5: the only writes are the global nonce claim and the session idle slide (auth tables only, single statements).
    for (const q of h.sql) assert.match(q.trimStart(), /^SELECT\b|^INSERT INTO service_nonces \(key_id, nonce, seen_at_ms\) VALUES|^UPDATE viewer_sessions SET idle_expires_at_ms = /, q);
    assert.ok(!h.sql.includes('BATCH'));
  });

  test('Worker source: no write statements, no chain reader construction, no request-derived chain config', () => {
    const dir = fileURLToPath(new URL('../src/', import.meta.url));
    for (const f of ['handler.ts', 'index.ts', 'd1-repositories.ts']) {
      const src = readFileSync(join(dir, f), 'utf8');
      assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|REPLACE|ALTER|CREATE|PRAGMA|ATTACH)\s/i, f);
      // P10.5: the only chain wiring is the env-gated chainFromEnv hook (chain-config.ts), never request-derived.
      assert.doesNotMatch(src.replace('chain: () => chainFromEnv(env),', ''), /readOnlyRpc|transactionVerifier|canonicalBlockReader|\bchain\s*:/, f);
    }
    // P10.5 writes live only in d1-auth.ts and target only the authentication tables.
    const auth = readFileSync(join(dir, 'd1-auth.ts'), 'utf8');
    const writes = [...auth.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/g)];
    assert.ok(writes.length >= 5);
    for (const m of writes) assert.match(m[2], /^(viewer_invitations|viewer_sessions|service_nonces)$/, m[0]);
    assert.doesNotMatch(auth, /\b(DROP|ALTER|CREATE|PRAGMA|ATTACH|REPLACE)\s/i);
    const bundle = readFileSync(fileURLToPath(new URL('../dist/worker.js', import.meta.url)), 'utf8');
    assert.doesNotMatch(bundle, /D1LineageWriter/, 'the prototype writer is not in the Worker bundle');
  });
});

// ───────────────────────────── 3. Projection integrity over D1 rows ─────────────────────────────
describe('ADV-3 projection integrity', () => {
  test('tampered invoice body with the stored digest → uniform 404 (commitment re-derived)', async () => {
    const tampered = { ...ex['inv-t-body'].invoice, buyAmount: '1' };
    await db.prepare("UPDATE invoices SET body = ? WHERE invoice_id = 'inv-t-body'").bind(JSON.stringify(tampered)).run();
    const r = await asDemo('inv-t-body');
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
  });

  test('revision: negative refused by CHECK; non-integer (REAL) revision fails closed → 404', async () => {
    await assert.rejects(db.prepare("UPDATE invoices SET revision = -1 WHERE invoice_id = 'inv-t-rev'").run(), /CHECK constraint failed/);
    await db.prepare("UPDATE invoices SET revision = 1.5 WHERE invoice_id = 'inv-t-rev'").run();
    const r = await asDemo('inv-t-rev');
    assert.equal(r.status, 404); assert.equal(r.text, NOT_FOUND);
  });

  test('swapped approval/consent signatures → neither verifies; never settled', async () => {
    const inv = ex['inv-t-swap'];
    await db.prepare("UPDATE signatures SET approval = ?, consent = ? WHERE invoice_id = 'inv-t-swap'").bind(inv.consent, inv.approval).run();
    const { status, body } = await proj('inv-t-swap');
    assert.equal(status, 200);
    assert.notEqual(body.invoice.approval.state, 'verified');
    assert.notEqual(body.invoice.consent.state, 'verified');
    assert.notEqual(body.invoice.settlement, 'settled');
  });

  test('signatures from another tenant or another digest are never used', async () => {
    const inv = ex['inv-t-xtenant-sig'];
    await db.prepare("DELETE FROM signatures WHERE invoice_id = 'inv-t-xtenant-sig'").run();
    await db.prepare('INSERT INTO signatures VALUES (?, ?, ?, ?, ?)').bind('tenant-b', 'inv-t-xtenant-sig', inv.digest, inv.approval, inv.consent).run();
    await db.prepare('INSERT INTO signatures VALUES (?, ?, ?, ?, ?)').bind('tenant-a', 'inv-t-xtenant-sig', 'ee'.repeat(32), inv.approval, inv.consent).run();
    const { body } = await proj('inv-t-xtenant-sig');
    assert.deepEqual(body.invoice.approval, { purpose: 'invoice approval', state: 'unverified', reason: 'missing' });
    assert.deepEqual(body.invoice.consent, { purpose: 'recipient consent', state: 'unverified', reason: 'missing' });
  });

  test('raw-SQL forged verified-final closure (inside the trust boundary) still never settles without a chain reader', async () => {
    const inv = ex['inv-t-forged-final'];
    const hash = '0x' + 'aa'.repeat(32);
    const auth = JSON.stringify({ digest: inv.digest, approvalSigner: inv.approver.address, consentSigner: inv.recipient.address, expiresAtMs: inv.invoice.expires });
    const env = JSON.stringify({ chainId: 42220, to: inv.invoice.buy, dataSha256: 'ab'.repeat(32), value: '0' });
    for (const op of ['conversion', 'payout'] as const) {
      const id = `forged-${op}`;
      await db.prepare(`INSERT INTO attempts VALUES (?, 'tenant-a', 'inv-t-forged-final', ?, 1, 'recorded', ?, ?, ?, ?, NULL, 'claimed', NULL)`)
        .bind(id, inv.digest, op, NOW - 900, auth, env).run();
      await db.prepare("UPDATE attempts SET hash = ?, dispatch = 'hash-recorded' WHERE attempt_id = ?").bind(op === 'payout' ? hash : '0x' + 'bb'.repeat(32), id).run();
      const h = op === 'payout' ? hash : '0x' + 'bb'.repeat(32);
      await db.prepare("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES (?, 'verification', ?, ?)")
        .bind(id, NOW - 800, JSON.stringify({ result: 'verified-final', verifier: 'attested-evidence', hash: h })).run();
      // The forged verdict satisfies the trigger: closure succeeds. (Documented: raw writers are trusted.)
      await db.prepare("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = ?").bind(id).run();
    }
    const { status, body } = await proj('inv-t-forged-final');
    assert.equal(status, 200);
    assert.deepEqual(body.invoice.payout, { state: 'unknown', reason: 'unavailable', attemptId: 'forged-payout', recordedRevision: 1 });
    assert.deepEqual(body.invoice.conversion, { state: 'unknown', reason: 'unavailable', attemptId: 'forged-conversion', recordedRevision: 1 });
    assert.equal(body.invoice.settlement, 'reconciliation-required');
  });

  test('attempts for another tenant with the same invoice id and digest do not leak into the projection', async () => {
    const inv = ex['inv-t-xtenant-att'];
    const auth = JSON.stringify({ digest: inv.digest, approvalSigner: inv.approver.address, consentSigner: inv.recipient.address, expiresAtMs: inv.invoice.expires });
    const env = JSON.stringify({ chainId: 42220, to: inv.invoice.buy, dataSha256: 'ab'.repeat(32), value: '0' });
    await db.prepare(`INSERT INTO attempts VALUES ('xt-payout', 'tenant-b', 'inv-t-xtenant-att', ?, 1, 'recorded', 'payout', ?, ?, ?, NULL, 'claimed', NULL)`)
      .bind(inv.digest, NOW - 900, auth, env).run();
    const { body } = await proj('inv-t-xtenant-att');
    assert.deepEqual(body.invoice.payout, { state: 'unverified', reason: 'missing' });
    assert.equal(body.invoice.settlement, 'unverified');
  });

  test('malformed attempt JSON (raw insert) fails closed: payout reconciliation-required/unavailable, never settled', async () => {
    const inv = ex['inv-t-badjson'];
    await db.prepare(`INSERT INTO attempts VALUES ('bad-json', 'tenant-a', 'inv-t-badjson', ?, 1, 'recorded', 'payout', ?, '{not json', '{}', NULL, 'claimed', NULL)`)
      .bind(inv.digest, NOW - 900).run();
    const { status, body } = await proj('inv-t-badjson');
    assert.equal(status, 200);
    assert.deepEqual(body.invoice.payout, { state: 'reconciliation-required', reason: 'unavailable' });
    assert.equal(body.invoice.settlement, 'reconciliation-required');
  });

  test('OBSERVATION: re-committing an invoice row to a new digest hides earlier-digest attempts from the projection (writer still blocks a new attempt)', async () => {
    const inv = ex['inv-t-recommit'];
    const auth = JSON.stringify({ digest: inv.digest, approvalSigner: inv.approver.address, consentSigner: inv.recipient.address, expiresAtMs: inv.invoice.expires });
    const env = JSON.stringify({ chainId: 42220, to: inv.invoice.buy, dataSha256: 'ab'.repeat(32), value: '0' });
    await db.prepare(`INSERT INTO attempts VALUES ('rc-payout', 'tenant-a', 'inv-t-recommit', ?, 1, 'recorded', 'payout', ?, ?, ?, NULL, 'outcome-unknown', NULL)`)
      .bind(inv.digest, NOW - 900, auth, env).run();
    assert.equal((await proj('inv-t-recommit')).body.invoice.payout.state, 'unknown');
    const { invoice: v2, digest: d2 } = commit({ ...inv.invoice, nonce: 'ff'.repeat(16) });
    await db.prepare("UPDATE invoices SET body = ?, digest = ?, revision = 2 WHERE invoice_id = 'inv-t-recommit'").bind(JSON.stringify(v2), d2).run();
    const after = (await proj('inv-t-recommit')).body.invoice;
    assert.equal(after.digest, d2);
    // The earlier open payout attempt is not visible under the new commitment: payout reads as "missing", not unknown.
    assert.deepEqual(after.payout, { state: 'unverified', reason: 'missing' });
    // ...but the lineage schema refuses to open a new payout attempt for the invoice under the new digest.
    await assert.rejects(db.prepare(`INSERT INTO attempts VALUES ('rc-payout-2', 'tenant-a', 'inv-t-recommit', ?, 2, 'recorded', 'payout', ?, ?, ?, NULL, 'claimed', NULL)`)
      .bind(d2, NOW, auth, env).run(), /open or finalized under some commitment/);
  });
});

// ───────────────────────────── 4. D1 lineage writer vs node store under adversarial sequences ─────────────────────────────
let n = 0;
const uniq = (p: string) => `${p}-adv-${++n}`;
const DG = 'ab'.repeat(32), DG2 = 'cd'.repeat(32);
let hn = 50_000;
const nextHash = () => '0x' + (++hn).toString(16).padStart(64, '0');
const claim = (invoiceId: string, patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: uniq('att'), tenantId: 'tenant-l', invoiceId, digest: DG, recordedRevision: 1, operation: 'payout', createdAtMs: 1_000_000,
  authorization: { digest: patch.digest ?? DG, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 },
  envelope: { chainId: 42220, to: '0x' + '0c'.repeat(20), dataSha256: 'ee'.repeat(32), value: '0' }, ...patch,
});
function evidence(r: Record<string, unknown>, attemptId: string, blockHash = '0x' + 'b1'.repeat(32), finalized = '120') {
  const tx = attest<ObservedTransaction>({
    source: 'transaction-verifier', tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id), digest: String(r.digest),
    revision: Number(r.recorded_revision), operation: r.operation as 'payout', attemptId, hash: String(r.hash), chainId: 42220,
    buyToken: '0x' + '0c'.repeat(20), sellToken: '0x' + '0d'.repeat(20), sender: '0x' + '33'.repeat(20), recipient: '0x' + '22'.repeat(20),
    amountAtomic: '1', debitAtomic: '0', blockNumber: '100', blockHash, success: true, observedAtMs: 1,
  });
  const canonical = attest<CanonicalBlockObservation>({ source: 'canonical-chain-reader', chainId: 42220, blockNumber: '100', blockHash, blockTimestampMs: 1,
    finalizedBlockNumber: finalized, finalizedBlockHash: '0x' + 'f1'.repeat(32), observedAtMs: 1 });
  return { tx, canonical };
}
const row = (id: string) => db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').bind(id).first<Record<string, unknown>>();
const cnt = async (sql: string, ...a: unknown[]) => Number((await db.prepare(sql).bind(...a).first<{ c: number }>())!.c);
const settle = async <T>(ps: Promise<T>[]) => Promise.allSettled(ps);

describe('ADV-4 D1 lineage writer under adversarial sequences', () => {
  let L: D1LineageWriter;
  before(() => { L = new D1LineageWriter(db); });

  test('concurrent recordHash with different hashes: exactly one wins, one hash-recorded event, loser gets the set-once error', async () => {
    const a = claim(uniq('inv'));
    await L.recordAttempt(a);
    const hashes = Array.from({ length: 8 }, nextHash);
    const res = await settle(hashes.map(h => L.recordHash(a.attemptId, h, 1_000_100)));
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of res) if (r.status === 'rejected') assert.match(String(r.reason), /attempt hash is immutable/);
    assert.equal(await cnt("SELECT count(*) AS c FROM attempt_events WHERE attempt_id = ? AND kind = 'hash-recorded'", a.attemptId), 1);
    assert.ok(hashes.includes(String((await row(a.attemptId))!.hash)));
  });

  test('race: close vs a newer negative verdict — closed state and the closed event are always consistent', async () => {
    for (let i = 0; i < 6; i++) {
      const a = claim(uniq('inv'));
      await L.recordAttempt(a);
      await L.recordHash(a.attemptId, nextHash(), 1_000_100);
      const { tx, canonical } = evidence((await row(a.attemptId))!, a.attemptId);
      await L.recordVerifiedFinal(a.attemptId, tx, canonical, 1_000_200);
      const res = await settle<unknown>([L.close(a.attemptId, 'verified-final', 1_000_300, 'ops'), L.appendVerification(a.attemptId, 1_000_250, 'mismatch', 'auditor')]);
      const closed = (await row(a.attemptId))!.closed;
      const closedEvents = await cnt("SELECT count(*) AS c FROM attempt_events WHERE attempt_id = ? AND kind = 'closed'", a.attemptId);
      assert.equal(closedEvents, closed === 'verified-final' ? 1 : 0);
      if (closed === null) assert.match(String((res[0] as PromiseRejectedResult).reason), /latest independent verdict|independent verified-final verification/);
    }
  });

  test('concurrent recordVerifiedFinal with different evidence: both verdicts recorded as history; closure uses the latest and stays single', async () => {
    const a = claim(uniq('inv'));
    await L.recordAttempt(a);
    await L.recordHash(a.attemptId, nextHash(), 1_000_100);
    const r = (await row(a.attemptId))!;
    const e1 = evidence(r, a.attemptId, '0x' + 'c1'.repeat(32)), e2 = evidence(r, a.attemptId, '0x' + 'c2'.repeat(32));
    await Promise.all([L.recordVerifiedFinal(a.attemptId, e1.tx, e1.canonical, 1_000_200), L.recordVerifiedFinal(a.attemptId, e2.tx, e2.canonical, 1_000_201)]);
    assert.equal(await cnt("SELECT count(*) AS c FROM attempt_events WHERE attempt_id = ? AND kind = 'verification'", a.attemptId), 2);
    await L.close(a.attemptId, 'verified-final', 1_000_300, 'ops');
    assert.equal((await row(a.attemptId))!.closed, 'verified-final');
    assert.equal(await cnt("SELECT count(*) AS c FROM attempt_events WHERE attempt_id = ? AND kind = 'closed'", a.attemptId), 1);
  });

  test('FIXED (P10.4 adversarial finding): close() on an already verified-final attempt succeeds again and appends a second "closed" event with a different operator (D1; node has the same behaviour)', async () => {
    const a = claim(uniq('inv'));
    await L.recordAttempt(a);
    await L.recordHash(a.attemptId, nextHash(), 1_000_100);
    const e = evidence((await row(a.attemptId))!, a.attemptId);
    await L.recordVerifiedFinal(a.attemptId, e.tx, e.canonical, 1_000_200);
    await L.close(a.attemptId, 'verified-final', 1_000_300, 'ops-alice');
    // Expected: refused ('attempt closure is final' or similar). Actual: the UPDATE sets closed to the same value, which
    // attempt_close_once (NEW.closed IS NOT OLD.closed) and closed_attempt_frozen (hash, dispatch only) both allow.
    await assert.rejects(L.close(a.attemptId, 'verified-final', 1_000_400, 'ops-mallory'), /closure is final|already closed/);
    assert.equal(await cnt("SELECT count(*) AS c FROM attempt_events WHERE attempt_id = ? AND kind = 'closed'", a.attemptId), 1);
  });

  test('importLegacy: id owned by another invoice/tenant/digest/operation → conflict; concurrent identical imports give one row', async () => {
    const inv = uniq('inv'), id = uniq('legacy');
    const out = await Promise.all(Array.from({ length: 6 }, () => L.importLegacy('tenant-l', { digest: DG, invoiceId: inv, payoutId: id }, 1_000_000)));
    assert.equal(out.flat().length >= 1, true);
    assert.equal(await cnt('SELECT count(*) AS c FROM attempts WHERE attempt_id = ?', id), 1);
    assert.equal(await cnt("SELECT count(*) AS c FROM attempt_events WHERE attempt_id = ? AND kind = 'legacy-import'", id), 1);
    for (const legacy of [{ digest: DG, invoiceId: uniq('inv'), payoutId: id }, { digest: DG2, invoiceId: inv, payoutId: id }, { digest: DG, invoiceId: inv, swapId: id }]) {
      await assert.rejects(L.importLegacy('tenant-l', legacy, 1_000_000), /legacy attempt id conflict/);
    }
    await assert.rejects(L.importLegacy('tenant-z', { digest: DG, invoiceId: inv, payoutId: id }, 1_000_000), /legacy attempt id conflict/);
    // The unresolved legacy attempt blocks a recorded claim for the invoice operation, under any digest.
    await assert.rejects(L.recordAttempt(claim(inv, { digest: DG2 })), /already open/);
  });

  test('raw SQL REPLACE/UPSERT on every unique key is refused by triggers', async () => {
    const a = claim(uniq('inv')), b = claim(uniq('inv'));
    await L.recordAttempt(a); await L.recordAttempt(b);
    const ha = nextHash();
    await L.recordHash(a.attemptId, ha, 1_000_100);
    const seq = Number((await db.prepare('SELECT max(seq) AS m FROM attempt_events').first<{ m: number }>())!.m);
    const cols = `(attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms, authorization, envelope, hash, dispatch, closed)`;
    const vals = (id: string, inv: string, hash: string | null) =>
      `('${id}', 'tenant-l', '${inv}', '${DG2}', 1, 'recorded', 'payout', 1, '{}', '{}', ${hash ? `'${hash}'` : 'NULL'}, 'claimed', NULL)`;
    // Same-id inserts trip whichever BEFORE INSERT trigger SQLite runs first (most recently created first): both refuse.
    const SAME_ID = /attempt identity is immutable|open or finalized under some commitment/;
    const cases: [string, RegExp][] = [
      [`INSERT OR REPLACE INTO attempts ${cols} VALUES ${vals(a.attemptId, a.invoiceId, null)}`, SAME_ID],
      [`REPLACE INTO attempts ${cols} VALUES ${vals(a.attemptId, a.invoiceId, null)}`, SAME_ID],
      [`INSERT INTO attempts ${cols} VALUES ${vals(a.attemptId, a.invoiceId, null)} ON CONFLICT(attempt_id) DO UPDATE SET hash = NULL, closed = NULL`, SAME_ID],
      [`INSERT OR REPLACE INTO attempts ${cols} VALUES ${vals(uniq('att'), uniq('inv'), ha)}`, /transaction hash already belongs to another attempt/],
      [`INSERT INTO attempts ${cols} VALUES ${vals(uniq('att'), uniq('inv'), ha)} ON CONFLICT(hash) WHERE hash IS NOT NULL DO NOTHING`, /transaction hash already belongs to another attempt/],
      [`INSERT OR REPLACE INTO attempts ${cols} VALUES ${vals(uniq('att'), b.invoiceId, null)}`, /open or finalized/],
      [`UPDATE OR REPLACE attempts SET hash = '${ha}' WHERE attempt_id = '${b.attemptId}'`, /transaction hash already belongs to another attempt/],
      [`UPDATE OR REPLACE attempts SET invoice_id = '${a.invoiceId}' WHERE attempt_id = '${b.attemptId}'`, /attempt identity is immutable/],
      [`INSERT OR REPLACE INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (${seq}, '${a.attemptId}', 'claimed', 1, '{}')`, /append-only/],
      [`INSERT INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (${seq}, '${a.attemptId}', 'claimed', 1, '{}') ON CONFLICT(seq) DO UPDATE SET detail = '{}'`, /append-only/],
      [`UPDATE OR REPLACE attempt_events SET detail = '{}' WHERE seq = ${seq}`, /append-only/],
      [`DELETE FROM attempts WHERE attempt_id = '${a.attemptId}'`, /attempts are retained/],
    ];
    for (const [sql, msg] of cases) await assert.rejects(db.prepare(sql).run(), msg, sql);
    assert.equal((await row(a.attemptId))!.hash, ha);
  });

  test('OBSERVATION (documented A8): the D1 binding can DROP TRIGGER; re-applying the schema restores enforcement', async () => {
    const scratch = await startWorker({ keys: { [k.keyId]: k.secret } });
    try {
      await applySchema(scratch.db);
      await scratch.db.prepare('DROP TRIGGER attempt_no_delete').run();
      await scratch.db.prepare(`INSERT INTO attempts VALUES ('x', 't', 'i', '${DG}', NULL, 'unresolved', 'payout', 1, NULL, NULL, NULL, 'outcome-unknown', NULL)`).run();
      await scratch.db.prepare("DELETE FROM attempts WHERE attempt_id = 'x'").run(); // succeeds without the trigger
      await applySchema(scratch.db);
      await scratch.db.prepare(`INSERT INTO attempts VALUES ('y', 't', 'i2', '${DG}', NULL, 'unresolved', 'payout', 1, NULL, NULL, NULL, 'outcome-unknown', NULL)`).run();
      await assert.rejects(scratch.db.prepare("DELETE FROM attempts WHERE attempt_id = 'y'").run(), /attempts are retained/);
    } finally { await scratch.mf.dispose(); }
  });

  test('parity: the same adversarial sequence yields the same rows, events and refusal messages on node:sqlite and D1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daidai-adv-'));
    const node = new AttemptLineageStore(join(dir, 'l.db'));
    const scratch = await startWorker({ keys: { [k.keyId]: k.secret } });
    try {
      await applySchema(scratch.db);
      const d1 = new D1LineageWriter(scratch.db);
      const inv = 'inv-par', h1 = '0x' + '11'.repeat(32), h2 = '0x' + '12'.repeat(32);
      const a = { ...claim(inv), attemptId: 'par-1' };
      const steps: [string, (s: any, rowOf: (id: string) => Promise<Record<string, unknown>>) => unknown][] = [
        ['claim', st => st.recordAttempt(a)],
        ['claim again', st => st.recordAttempt(a)],
        ['conflicting claim same id', st => st.recordAttempt({ ...a, recordedRevision: 2 })],
        ['new digest while open', st => st.recordAttempt({ ...claim(inv, { digest: DG2 }), attemptId: 'par-2' })],
        ['verify before hash', st => st.appendVerification('par-1', 1_000_050, 'not-found', 'aud')],
        ['hash', st => st.recordHash('par-1', h1, 1_000_100)],
        ['same hash again', st => st.recordHash('par-1', h1, 1_000_101)],
        ['different hash', st => st.recordHash('par-1', h2, 1_000_102)],
        ['close without verdict', st => st.close('par-1', 'verified-final', 1_000_150, 'ops')],
        ['verified-final via appendVerification', st => st.appendVerification('par-1', 1_000_160, 'verified-final', 'attested-evidence')],
        ['reconciled-not-landed', st => st.close('par-1', 'reconciled-not-landed', 1_000_170, 'ops')],
        ['final', async (st, rowOf) => { const e = evidence(await rowOf('par-1'), 'par-1'); return st.recordVerifiedFinal('par-1', e.tx, e.canonical, 1_000_200); }],
        ['negative after final', st => st.appendVerification('par-1', 1_000_210, 'not-final', 'aud')],
        ['close blocked by newer negative', st => st.close('par-1', 'verified-final', 1_000_220, 'ops')],
        ['final again', async (st, rowOf) => { const e = evidence(await rowOf('par-1'), 'par-1'); return st.recordVerifiedFinal('par-1', e.tx, e.canonical, 1_000_230); }],
        ['close', st => st.close('par-1', 'verified-final', 1_000_240, 'ops')],
        ['new digest after final', st => st.recordAttempt({ ...claim(inv, { digest: DG2 }), attemptId: 'par-3' })],
        ['fresh id same digest after final', st => st.recordAttempt({ ...claim(inv), attemptId: 'par-4' })],
      ];
      const outcomes: Record<'node' | 'd1', string[]> = { node: [], d1: [] };
      const norm = (e: unknown) => String((e as Error).message ?? e).replace(/^D1_ERROR: /, '').replace(/: SQLITE_CONSTRAINT.*$/, '');
      for (const [name, fn] of steps) {
        for (const [label, st, rowOf] of [
          ['node', node, async (id: string) => node.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(id) as Record<string, unknown>],
          ['d1', d1, async (id: string) => (await scratch.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').bind(id).first<Record<string, unknown>>())!],
        ] as const) {
          try { const v = await fn(st, rowOf); outcomes[label].push(`${name}: ok ${JSON.stringify(v ?? null)}`); }
          catch (e) { outcomes[label].push(`${name}: ERR ${norm(e)}`); }
        }
      }
      assert.deepEqual(outcomes.d1, outcomes.node);
      const nodeRows = await new AttemptLineageReader(join(dir, 'l.db')).attempts({ tenantId: 'tenant-l', invoiceId: inv, digest: DG }, 'payout');
      const d1Rows = await d1Attempts(scratch.db).attempts({ tenantId: 'tenant-l', invoiceId: inv, digest: DG }, 'payout');
      assert.deepEqual(JSON.parse(JSON.stringify(d1Rows)), JSON.parse(JSON.stringify(nodeRows)));
      assert.equal(d1Rows[0].closed, 'verified-final');
      assert.ok(outcomes.node.some(o => o.startsWith('new digest after final: ERR')));
      assert.ok(outcomes.node.some(o => o.startsWith('close blocked by newer negative: ERR')));
    } finally {
      node.close_db(); await scratch.mf.dispose(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
