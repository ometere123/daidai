import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productPath, parseProductReply } from '../../../src/product-contract.ts';
import { signRequest } from '../../../src/service-auth.ts';
import { VIEWER_HEADER } from '../../../src/api-contract.ts';
import { applyProductSchema } from '../src/product-schema.ts';
import { seed, randomNonce, randomToken, serviceKey, startWorker } from './fixtures.ts';

const keys = serviceKey();
const id = () => randomBytes(16).toString('hex');
const dbDir = mkdtempSync(join(tmpdir(), 'daidai-p11-'));
const open = () => startWorker({ keys: { [keys.keyId]: keys.secret }, product: true, persist: dbDir });
let instance: Awaited<ReturnType<typeof open>>;
let seeded: Awaited<ReturnType<typeof seed>>;
let stopped = false;
const terms = () => ({ target: '1500000000', cap: '1100000', expiry: Date.now() + 60_000,
  recipient: '0x' + '12'.repeat(20), approver: '0x' + '34'.repeat(20) });

before(async () => {
  instance = await open();
  seeded = await seed(instance.db);
  await applyProductSchema(instance.db);
  await applyProductSchema(instance.db);
  await instance.db.prepare("INSERT INTO product_merchants VALUES ('tenant-a','demo-viewer'), ('tenant-b','viewer-b')").run();
});
after(async () => {
  if (!stopped) await instance?.mf.dispose();
  try { rmSync(dbDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
  catch (e) { if (process.platform !== 'win32' || (e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
});
async function request(payload: object, token = seeded.tokens.demo, host = '127.0.0.1') {
  const body = JSON.stringify({ version: 'p11.v1', ...payload });
  const headers = await signRequest({ ...keys, method: 'POST', path: productPath, body, viewerToken: token,
    nowMs: Date.now(), nonce: randomNonce() });
  const res = await instance.mf.dispatchFetch('http://' + host + productPath, { method: 'POST', body,
    headers: { ...headers, [VIEWER_HEADER]: token, 'content-type': 'application/json' } });
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  return { status: res.status, value: parseProductReply(await res.json()) };
}

test('idempotent create survives a lost response and stale keys cannot change terms', async () => {
  const payload = { kind: 'save', id: id(), key: id(), expected: 0, draft: terms() };
  const results = await Promise.all([request(payload), request(payload)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].value?.revisions[0].revision, 1);
  assert.equal((await request({ ...payload, draft: { ...payload.draft, cap: '1' } })).status, 409);
  assert.equal((await request({ kind: 'detail', id: payload.id })).value?.revisions.length, 1);
});

test('concurrent revision changes admit one writer, and committed terms remain immutable', async () => {
  const invoice = id(), draft = terms();
  assert.equal((await request({ kind: 'save', id: invoice, key: id(), expected: 0, draft })).status, 200);
  const results = await Promise.all(['1100000', '1200000'].map(cap => request({
    kind: 'save', id: invoice, key: id(), expected: 1, draft: { ...draft, cap },
  })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const committed = await request({ kind: 'commit', id: invoice, key: id(), expected: 2 });
  assert.equal(committed.value?.revisions[0].state, 'committed');
  assert.match(committed.value?.revisions[0].digest ?? '', /^[a-f0-9]{64}$/);
  assert.equal((await request({ kind: 'save', id: invoice, key: id(), expected: 3, draft })).status, 409);
  await assert.rejects(instance.db.prepare('DELETE FROM product_revisions WHERE id=?').bind(invoice).run(), /immutable revision/);
  assert.deepEqual((await request({ kind: 'detail', id: invoice })).value?.revisions.map(r => r.revision), [3, 2, 1]);
});

test('cross-tenant and same-tenant viewer denial, and local gate before private data', async () => {
  const invoice = id();
  const save = { kind: 'save', id: invoice, key: id(), expected: 0, draft: terms() };
  assert.equal((await request(save)).status, 200);
  assert.equal((await request({ kind: 'detail', id: invoice }, seeded.tokens.viewerB)).status, 404);
  assert.equal((await request({ ...save, key: id(), expected: 1 }, seeded.tokens.noPermission)).status, 404);
  assert.equal((await request(save, seeded.tokens.expired)).status, 404);
  assert.equal((await request(save, seeded.tokens.demo, 'example.invalid')).status, 404);
});

test('share reveals one commitment only, is revocable, and cancellation invalidates existing links', async () => {
  const invoice = id(), code = randomToken(), alternate = randomToken();
  await request({ kind: 'save', id: invoice, key: id(), expected: 0, draft: terms() });
  assert.equal((await request({ kind: 'share', id: invoice, code })).status, 409);
  await request({ kind: 'commit', id: invoice, key: id(), expected: 1 });
  assert.equal((await request({ kind: 'share', id: invoice, code })).value?.kind, 'shared');
  assert.equal((await request({ kind: 'redeem', code }, seeded.tokens.viewerB)).value?.revisions[0].id, invoice);
  assert.equal((await request({ kind: 'redeem', code }, randomToken())).status, 404);
  assert.equal((await request({ kind: 'revoke', id: invoice }, seeded.tokens.viewerB)).status, 404);
  await request({ kind: 'revoke', id: invoice });
  assert.equal((await request({ kind: 'redeem', code }, seeded.tokens.viewerB)).status, 404);
  assert.equal((await request({ kind: 'share', id: invoice, code: alternate })).status, 200);
  assert.equal((await request({ kind: 'cancel', id: invoice, key: id(), expected: 2 })).value?.revisions[0].state, 'cancelled');
  assert.equal((await request({ kind: 'redeem', code: alternate }, seeded.tokens.viewerB)).status, 404);
  assert(!instance.logs.some(line => line.includes(code) || line.includes(seeded.tokens.demo)));
});

test('expired shares fail closed and D1 schema failure returns a redacted 503', async () => {
  const invoice = id(), code = randomToken();
  await request({ kind: 'save', id: invoice, key: id(), expected: 0, draft: terms() });
  await request({ kind: 'commit', id: invoice, key: id(), expected: 1 });
  assert.equal((await request({ kind: 'share', id: invoice, code })).status, 200);
  await instance.db.prepare('UPDATE product_shares SET expires_at=1 WHERE id=?').bind(invoice).run();
  assert.equal((await request({ kind: 'redeem', code }, seeded.tokens.viewerB)).status, 404);
  await instance.db.prepare('ALTER TABLE product_merchants RENAME TO product_merchants_unavailable').run();
  try { assert.equal((await request({ kind: 'detail', id: invoice })).status, 503); }
  finally { await instance.db.prepare('ALTER TABLE product_merchants_unavailable RENAME TO product_merchants').run(); }
});

test('revisions survive restart and migration re-entry independently of financial lineage', async () => {
  const invoice = id(), draft = terms();
  assert.equal((await request({ kind: 'save', id: invoice, key: id(), expected: 0, draft })).status, 200);
  await instance.mf.dispose();
  stopped = true;
  instance = await open();
  stopped = false;
  await applyProductSchema(instance.db);
  const reply = await request({ kind: 'detail', id: invoice });
  assert.equal(reply.value?.revisions[0].target, draft.target);
  assert.equal((await instance.db.prepare('SELECT version FROM product_schema').first<{version: number}>())?.version, 1);
  assert.equal((await instance.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE invoice_id=?').bind(invoice).first<{n: number}>())?.n, 0);
});
