// P10.5 R1 (global replay across separate Worker instances sharing one persisted D1) and R2 (nonce store outage → 503).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonceWindow, MAX_SKEW_MS } from '../../../src/service-auth.ts';
import { NONCE_RETENTION_MS, claimNonce, pruneNonces } from '../src/d1-auth.ts';
import { applySchema } from '../src/d1-schema.ts';
import { d1Repositories } from '../src/d1-repositories.ts';
import { RateLimiter, handle, parseServiceKeys } from '../src/handler.ts';
import { AUDIENCE, randomNonce, serviceKey, signedHeaders, startWorker } from './fixtures.ts';

const BASE = 'http://api.local';
const UNAUTH = '{"apiVersion":"v1","kind":"error","error":"unauthenticated-service"}';
const UNAVAILABLE = '{"apiVersion":"v1","kind":"error","error":"unavailable"}';
const k = serviceKey();
const keys = { [k.keyId]: k.secret };
let dir: string;
let a: Awaited<ReturnType<typeof startWorker>>, b: Awaited<ReturnType<typeof startWorker>>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'daidai-r1-'));
  a = await startWorker({ keys, persist: dir });
  await applySchema(a.db);
  b = await startWorker({ keys, persist: dir });
});
after(async () => { await a.mf.dispose(); await b.mf.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe('R1 global replay across two separate Worker instances (one persisted D1)', () => {
  test('the same signed request: first instance 200, second instance 401', async () => {
    const h = await signedHeaders({ ...k, path: '/v1/health' });
    const r1 = await a.mf.dispatchFetch(BASE + '/v1/health', { headers: h });
    assert.equal(r1.status, 200);
    const r2 = await b.mf.dispatchFetch(BASE + '/v1/health', { headers: h });
    assert.equal(r2.status, 401); assert.equal(await r2.text(), UNAUTH);
    // and back on the first instance too
    const r3 = await a.mf.dispatchFetch(BASE + '/v1/health', { headers: h });
    assert.equal(r3.status, 401);
  });
  test('reverse order: second instance first', async () => {
    const h = await signedHeaders({ ...k, path: '/v1/health' });
    assert.equal((await b.mf.dispatchFetch(BASE + '/v1/health', { headers: h })).status, 200);
    const r = await a.mf.dispatchFetch(BASE + '/v1/health', { headers: h });
    assert.equal(r.status, 401); assert.equal(await r.text(), UNAUTH);
  });
  test('racing concurrently on both instances: exactly one 200', async () => {
    for (let round = 0; round < 5; round++) {
      const h = await signedHeaders({ ...k, path: '/v1/health' });
      const rs = await Promise.all([a, b, a, b].map(w => w.mf.dispatchFetch(BASE + '/v1/health', { headers: h })));
      const statuses = rs.map(r => r.status);
      // Exactly one acceptance. Losers get 401 (PK conflict) or, when two local workerd processes contend for the same
      // SQLite file lock (SQLITE_BUSY, a Miniflare artifact; hosted D1 has one primary), 503 — fail closed, never 200.
      assert.equal(statuses.filter(x => x === 200).length, 1, `round ${round}: ${statuses}`);
      assert.ok(statuses.every(x => x === 200 || x === 401 || x === 503), `round ${round}: ${statuses}`);
    }
  });
});

describe('R2 nonce store failures fail closed', () => {
  test('nonce table dropped → 503 unavailable, never 200 (handler and real Worker)', async () => {
    const w = await startWorker({ keys });
    try {
      await applySchema(w.db);
      const deps = { repos: () => d1Repositories(w.db), db: () => w.db, keys: () => parseServiceKeys(JSON.stringify(keys)), audience: AUDIENCE,
        nonces: new NonceWindow(), limiter: new RateLimiter(), now: () => Date.now(), log: () => {} };
      assert.equal((await handle(new Request(BASE + '/v1/health', { headers: await signedHeaders({ ...k, path: '/v1/health' }) }), deps)).status, 200);
      await w.db.prepare('DROP TABLE service_nonces').run();
      const r = await handle(new Request(BASE + '/v1/health', { headers: await signedHeaders({ ...k, path: '/v1/health' }) }), deps);
      assert.equal(r.status, 503); assert.equal(await r.text(), UNAVAILABLE);
      const r2 = await w.mf.dispatchFetch(BASE + '/v1/health', { headers: await signedHeaders({ ...k, path: '/v1/health' }) });
      assert.equal(r2.status, 503); assert.equal(await r2.text(), UNAVAILABLE);
    } finally { await w.mf.dispose(); }
  });
  test('a throwing D1 binding → 503; claimNonce classifies only the PK conflict as replay', async () => {
    const broken = { prepare: () => { throw Error('D1_ERROR: network connection lost'); }, batch: async () => { throw Error('x'); } };
    assert.equal(await claimNonce(broken as never, 'kid', 'n'.repeat(20), 1), 'unavailable');
    const deps = { repos: () => d1Repositories(a.db), db: () => broken as never, keys: () => parseServiceKeys(JSON.stringify(keys)), audience: AUDIENCE,
      nonces: new NonceWindow(), limiter: new RateLimiter(), now: () => Date.now(), log: () => {} };
    const r = await handle(new Request(BASE + '/v1/health', { headers: await signedHeaders({ ...k, path: '/v1/health' }) }), deps);
    assert.equal(r.status, 503); assert.equal(await r.text(), UNAVAILABLE);
    const n = randomNonce();
    assert.equal(await claimNonce(a.db, 'kid', n, Date.now()), 'claimed');
    assert.equal(await claimNonce(a.db, 'kid', n, Date.now()), 'replayed');
  });
  test('unauthenticated requests never write a nonce row', async () => {
    const before = (await a.db.prepare('SELECT count(*) c FROM service_nonces').first<{ c: number }>())!.c;
    const h = await signedHeaders({ keyId: k.keyId, secret: 'z'.repeat(40), path: '/v1/health' });
    assert.equal((await a.mf.dispatchFetch(BASE + '/v1/health', { headers: h })).status, 401);
    assert.equal((await a.db.prepare('SELECT count(*) c FROM service_nonces').first<{ c: number }>())!.c, before);
  });
  test('pruning never deletes rows a replay inside the skew window could match', async () => {
    const now = 1_900_000_000_000;
    const keep = randomNonce(), old = randomNonce();
    assert.ok(NONCE_RETENTION_MS > 2 * MAX_SKEW_MS);
    await claimNonce(a.db, 'prune', keep, now - 2 * MAX_SKEW_MS);
    await claimNonce(a.db, 'prune', old, now - NONCE_RETENTION_MS - 1);
    await pruneNonces(a.db, now);
    assert.equal(await claimNonce(a.db, 'prune', keep, now), 'replayed');
    assert.equal(await claimNonce(a.db, 'prune', old, now), 'claimed');
  });
});
