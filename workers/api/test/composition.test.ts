// Runs the Worker's exact composition (src/handler.ts) in Node over the same local D1, with the D1 binding wrapped to
// record every SQL statement. Proves C2 (no invoice read before authorization), rate limiting and the request clock.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NonceWindow } from '../../../src/service-auth.ts';
import { d1Repositories } from '../src/d1-repositories.ts';
import type { D1Like, D1Stmt } from '../src/d1-schema.ts';
import { RateLimiter, handle, parseServiceKeys, type LogLine } from '../src/handler.ts';
import { AUDIENCE, randomToken, seed, serviceKey, signedHeaders, startWorker, type Seeded } from './fixtures.ts';

const k = serviceKey();
let w: Awaited<ReturnType<typeof startWorker>>;
let s: Seeded;
before(async () => { w = await startWorker({ keys: { [k.keyId]: k.secret } }); s = await seed(w.db); });
after(async () => { await w.mf.dispose(); });

function recording(db: D1Like, log: string[]): D1Like {
  const wrap = (stmt: D1Stmt, sql: string): D1Stmt => ({
    bind: (...v) => wrap(stmt.bind(...v), sql),
    first: () => { log.push(sql); return stmt.first(); },
    all: () => { log.push(sql); return stmt.all(); },
    run: () => { log.push(sql); return stmt.run(); },
  });
  return { prepare: sql => wrap(db.prepare(sql), sql), batch: st => { log.push('BATCH'); return db.batch(st); } };
}

function harness(o: { limiter?: RateLimiter; now?: () => number } = {}) {
  const sql: string[] = [], lines: LogLine[] = [];
  const deps = {
    repos: () => d1Repositories(recording(w.db, sql)), db: () => recording(w.db, sql), keys: () => parseServiceKeys(JSON.stringify({ [k.keyId]: k.secret })),
    audience: AUDIENCE, nonces: new NonceWindow(), limiter: o.limiter ?? new RateLimiter(), now: o.now ?? (() => Date.now()),
    log: (l: LogLine) => lines.push(l),
  };
  const call = async (id: string, token: string) => {
    const path = `/v1/invoices/${id}/authoritative`;
    return handle(new Request('http://api.local' + path, { headers: await signedHeaders({ ...k, path, viewerToken: token }) }), deps);
  };
  return { sql, lines, deps, call };
}
const touchesData = (sql: string[]) => sql.filter(q => /FROM (invoices|signatures|attempts|attempt_events)\b/.test(q));

describe('C2 no invoice read before authorization', () => {
  const denials: [string, string, () => string][] = [
    ['unknown token', 'inv-a1', () => randomToken()],
    ['expired session', 'inv-a1', () => s.tokens.expired],
    ['viewer without permission', 'inv-a1', () => s.tokens.noPermission],
    ['permission missing for this invoice', 'inv-a4', () => s.tokens.demo],
    ['cross-tenant viewer', 'inv-a1', () => s.tokens.viewerB],
    ['nonexistent invoice', 'inv-none', () => s.tokens.demo],
  ];
  for (const [name, id, token] of denials) {
    test(`${name}: identical 404 and no invoice/signature/attempt query`, async () => {
      const h = harness();
      const r = await h.call(id, token());
      assert.equal(r.status, 404);
      assert.equal(await r.text(), '{"apiVersion":"v1","kind":"error","error":"not-found-or-forbidden"}');
      assert.deepEqual(touchesData(h.sql), []);
      assert.ok(h.sql.length >= 1 && h.sql.every(q => /FROM (viewer_sessions|tenant_directory|invoice_permissions)\b|^INSERT INTO service_nonces |^DELETE FROM service_nonces WHERE seen_at_ms < |^UPDATE viewer_sessions SET idle_expires_at_ms /.test(q)), h.sql.join('\n'));
    });
  }
  test('an authorized viewer does reach the invoice, signatures and attempts (the instrument works)', async () => {
    const h = harness();
    const r = await h.call('inv-a1', s.tokens.demo);
    assert.equal(r.status, 200);
    assert.ok(touchesData(h.sql).length >= 3);
    // P10.5: besides SELECTs, only the nonce claim and the session idle slide (auth tables) are written.
    assert.ok(h.sql.every(q => /^\s*SELECT|^INSERT INTO service_nonces |^DELETE FROM service_nonces WHERE seen_at_ms < |^UPDATE viewer_sessions SET idle_expires_at_ms /i.test(q)), 'read path writes only auth state');
  });
});

describe('request time', () => {
  test('one request time is used for all observations (a live clock would fail closed)', async () => {
    let t = Date.now();
    const h = harness({ now: () => (t += 5) }); // every read of the clock advances time
    const r = await h.call('inv-a1', s.tokens.demo);
    assert.equal(r.status, 200);
  });
});

describe('rate limiting (per isolate, per key id)', () => {
  test('bucket exhaustion → 429 after authentication; refills over time', async () => {
    let now = Date.now();
    const h = harness({ limiter: new RateLimiter(3, 1), now: () => now });
    for (let i = 0; i < 3; i++) assert.equal((await h.call('inv-a1', s.tokens.demo)).status, 200);
    const limited = await h.call('inv-a1', s.tokens.demo);
    assert.equal(limited.status, 429);
    assert.equal(await limited.text(), '{"apiVersion":"v1","kind":"error","error":"rate-limited"}');
    now += 1500;
    assert.equal((await h.call('inv-a1', s.tokens.demo)).status, 200);
  });
  test('unauthenticated requests do not consume a key bucket', async () => {
    const limiter = new RateLimiter(1, 0.0001);
    const h = harness({ limiter });
    const path = '/v1/health';
    for (let i = 0; i < 5; i++) {
      const r = await handle(new Request('http://api.local' + path, { headers: await signedHeaders({ keyId: k.keyId, secret: 'x'.repeat(40), path }) }), h.deps);
      assert.equal(r.status, 401);
    }
    assert.equal((await handle(new Request('http://api.local' + path, { headers: await signedHeaders({ ...k, path }) }), h.deps)).status, 200);
  });
});

describe('service key configuration', () => {
  test('parseServiceKeys accepts only {keyId: secret>=32}', () => {
    assert.equal(parseServiceKeys(undefined), null);
    assert.equal(parseServiceKeys(''), null);
    assert.equal(parseServiceKeys('not json'), null);
    assert.equal(parseServiceKeys('[]'), null);
    assert.equal(parseServiceKeys('{}'), null);
    assert.equal(parseServiceKeys(JSON.stringify({ a: 'short' })), null);
    assert.equal(parseServiceKeys(JSON.stringify({ 'bad key!': 'x'.repeat(32) })), null);
    assert.equal(parseServiceKeys(JSON.stringify({ a: 1 })), null);
    assert.deepEqual({ ...parseServiceKeys(JSON.stringify({ a: 'x'.repeat(32) })) }, { a: 'x'.repeat(32) });
  });
  test('an exception in a repository becomes 503 unavailable without leaking the message', async () => {
    const h = harness();
    const deps = { ...h.deps, repos: () => { throw Error('SECRET internal detail'); } };
    const path = '/v1/invoices/inv-a1/authoritative';
    const r = await handle(new Request('http://api.local' + path, { headers: await signedHeaders({ ...k, path, viewerToken: s.tokens.demo }) }), deps);
    assert.equal(r.status, 503);
    assert.equal(await r.text(), '{"apiVersion":"v1","kind":"error","error":"unavailable"}');
    assert.deepEqual(Object.keys(h.lines.at(-1)!), ['rid', 'route', 'status', 'keyId']);
  });
});

describe('tampered rows fail closed', () => {
  test('a row whose body no longer matches its digest yields the uniform 404', async () => {
    const id = 'inv-a4';
    await w.db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-a', 'demo-viewer', ?, 'invoice:read')").bind(id).run();
    const before = await harness().call(id, s.tokens.demo);
    assert.equal(before.status, 200);
    await w.db.prepare("UPDATE invoices SET body = json_set(body, '$.buyAmount', '9999999999') WHERE invoice_id = ?").bind(id).run();
    const after = await harness().call(id, s.tokens.demo);
    assert.equal(after.status, 404);
  });
  test('a hand-written reconciled-not-landed row cannot exist (trigger), so it can never unblock', async () => {
    await assert.rejects(w.db.prepare("UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'att-a2-payout'").run(),
      /reconciled-not-landed closure is disabled until authoritative reconciliation exists/);
  });
});
