// A5/A6/A7/A8 on LOCAL D1 (Miniflare/workerd). Nothing here assumes node:sqlite behaviour transfers: every invariant is
// exercised against the D1 binding, through the prototype writer and through raw SQL. Each negative asserts the message.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptLineageReader, AttemptLineageStore, type NewAttempt } from '../../../src/attempt-lineage.ts';
import type { CanonicalBlockObservation, ObservedTransaction } from '../../../src/authoritative-invoice.ts';
import { attest, isAttested } from '../../../src/evidence-attestation.ts';
import { d1Attempts } from '../src/d1-repositories.ts';
import { D1LineageWriter } from '../src/d1-lineage.ts';
import { applySchema, SCHEMA_STATEMENTS, type D1Like } from '../src/d1-schema.ts';
import { serviceKey, startWorker } from './fixtures.ts';

const k = serviceKey();
let w: Awaited<ReturnType<typeof startWorker>>;
let db: D1Like;
let store: D1LineageWriter;
before(async () => { w = await startWorker({ keys: { [k.keyId]: k.secret } }); db = w.db; await applySchema(db); store = new D1LineageWriter(db); });
after(async () => { await w.mf.dispose(); });

let n = 0;
const uniq = (p: string) => `${p}-${++n}`;
const digest = 'ab'.repeat(32), digest2 = 'cd'.repeat(32);
const hashOf = (i: number) => '0x' + i.toString(16).padStart(64, '0');
let h = 1000;
const nextHash = () => hashOf(++h);
const fingerprint = (d = digest) => ({ digest: d, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 });
const envelope = { chainId: 42220, to: '0x' + '0c'.repeat(20), dataSha256: 'ee'.repeat(32), value: '0' };
const claim = (invoiceId: string, patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: uniq('att'), tenantId: 'tenant-a', invoiceId, digest, recordedRevision: 1, operation: 'payout', createdAtMs: 1_000_000,
  authorization: fingerprint(patch.digest ?? digest), envelope, ...patch,
});
const one = async <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) => Number((await one<{ c: number }>(sql, ...args))!.c);

async function evidenceFor(attemptId: string, patch: Partial<ObservedTransaction> = {}, canonPatch: Partial<CanonicalBlockObservation> = {}) {
  const r = (await one('SELECT * FROM attempts WHERE attempt_id = ?', attemptId))!;
  const blockHash = '0x' + 'b1'.repeat(32);
  const tx = attest<ObservedTransaction>({
    source: 'transaction-verifier', tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id), digest: String(r.digest),
    revision: Number(r.recorded_revision), operation: r.operation as 'payout', attemptId, hash: String(r.hash), chainId: 42220,
    buyToken: '0x' + '0c'.repeat(20), sellToken: '0x' + '0d'.repeat(20), sender: '0x' + '33'.repeat(20), recipient: '0x' + '22'.repeat(20),
    amountAtomic: '1', debitAtomic: '0', blockNumber: '100', blockHash, success: true, observedAtMs: 1, ...patch,
  });
  const canonical = attest<CanonicalBlockObservation>({
    source: 'canonical-chain-reader', chainId: 42220, blockNumber: '100', blockHash, blockTimestampMs: 1,
    finalizedBlockNumber: '120', finalizedBlockHash: '0x' + 'f1'.repeat(32), observedAtMs: 1, ...canonPatch,
  });
  return { tx, canonical };
}
async function finalized(invoiceId: string, patch: Partial<NewAttempt> = {}) {
  const a = claim(invoiceId, patch);
  await store.recordAttempt(a);
  await store.recordHash(a.attemptId, nextHash(), 1_000_100);
  const { tx, canonical } = await evidenceFor(a.attemptId);
  await store.recordVerifiedFinal(a.attemptId, tx, canonical, 1_000_200);
  await store.close(a.attemptId, 'verified-final', 1_000_300, 'ops-1');
  return a;
}
const rawInsert = (id: string, invoiceId: string, o: { digest?: string; hash?: string | null; closed?: string | null; verb?: string } = {}) =>
  db.prepare(`${o.verb ?? 'INSERT'} INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms,
    authorization, envelope, hash, dispatch, closed) VALUES (?, 'tenant-a', ?, ?, 1, 'recorded', 'payout', 1, '{}', '{}', ?, 'claimed', ?)`)
    .bind(id, invoiceId, o.digest ?? digest, o.hash ?? null, o.closed ?? null).run();

describe('A5 identity, hash and REPLACE guards on D1', () => {
  test('recordAttempt: created, idempotent existing, conflicting id refused', async () => {
    const a = claim(uniq('inv'));
    assert.equal(await store.recordAttempt(a), 'created');
    assert.equal(await store.recordAttempt(a), 'existing');
    await assert.rejects(store.recordAttempt({ ...a, recordedRevision: 2 }), /^Error: attempt id conflict$/);
    await assert.rejects(store.recordAttempt({ ...a, attemptId: 'bad id!' }), /invalid attempt identity/);
  });

  test('immutable identity: every identity column is refused by the trigger (raw SQL)', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    for (const [col, value] of [['attempt_id', "'x'"], ['tenant_id', "'t'"], ['invoice_id', "'i'"], ['digest', "'d'"], ['recorded_revision', '9'],
      ['lineage', "'unresolved'"], ['operation', "'conversion'"], ['created_at_ms', '2'], ['authorization', "'{}'"], ['envelope', "'{}'"]]) {
      await assert.rejects(db.prepare(`UPDATE attempts SET ${col} = ${value} WHERE attempt_id = ?`).bind(a.attemptId).run(), /attempt identity is immutable/, col);
    }
    await assert.rejects(db.prepare('DELETE FROM attempts WHERE attempt_id = ?').bind(a.attemptId).run(), /attempts are retained/);
  });

  test('set-once hash: same hash idempotent (no extra event), different hash refused (store and raw SQL)', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    const hash = nextHash();
    await store.recordHash(a.attemptId, hash, 1_000_100);
    await store.recordHash(a.attemptId, hash, 1_000_101);
    assert.equal(await count("SELECT count(*) c FROM attempt_events WHERE attempt_id = ? AND kind = 'hash-recorded'", a.attemptId), 1);
    await assert.rejects(store.recordHash(a.attemptId, nextHash(), 1_000_102), /attempt hash is immutable/);
    await assert.rejects(db.prepare('UPDATE attempts SET hash = NULL WHERE attempt_id = ?').bind(a.attemptId).run(), /attempt hash is immutable/);
    await assert.rejects(store.recordHash(a.attemptId, '0xnothex', 1), /invalid transaction hash/);
    await assert.rejects(store.recordHash('missing', nextHash(), 1), /unknown attempt/);
    assert.equal((await one('SELECT hash FROM attempts WHERE attempt_id = ?', a.attemptId))!.hash, hash);
  });

  test('the conditional event write (changes() inside a batch) only logs a real hash change', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    const hash = nextHash();
    // Two concurrent recordHash calls with the same hash: exactly one hash-recorded event.
    await Promise.all([store.recordHash(a.attemptId, hash, 2), store.recordHash(a.attemptId, hash, 3)]);
    assert.equal(await count("SELECT count(*) c FROM attempt_events WHERE attempt_id = ? AND kind = 'hash-recorded'", a.attemptId), 1);
  });

  test('unique hash across attempts (store, raw insert, raw update)', async () => {
    const a = claim(uniq('inv')), b = claim(uniq('inv'));
    await store.recordAttempt(a); await store.recordAttempt(b);
    const hash = nextHash();
    await store.recordHash(a.attemptId, hash, 2);
    await assert.rejects(store.recordHash(b.attemptId, hash, 3), /transaction hash already belongs to another attempt/);
    await assert.rejects(rawInsert(uniq('raw'), uniq('inv'), { hash }), /transaction hash already belongs to another attempt/);
    await assert.rejects(db.prepare('UPDATE OR REPLACE attempts SET hash = ? WHERE attempt_id = ?').bind(hash, b.attemptId).run(),
      /transaction hash already belongs to another attempt/);
  });

  test('REPLACE guards: OR REPLACE cannot delete a row through id, operation key, hash or event seq', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    const hash = nextHash();
    await store.recordHash(a.attemptId, hash, 2);
    await assert.rejects(rawInsert(a.attemptId, uniq('inv'), { verb: 'INSERT OR REPLACE' }), /attempt identity is immutable/);
    await assert.rejects(rawInsert(uniq('raw'), a.invoiceId, { verb: 'INSERT OR REPLACE' }), /an attempt for this (invoice )?operation is open or finalized/);
    await assert.rejects(rawInsert(uniq('raw'), uniq('inv'), { verb: 'REPLACE', hash }), /transaction hash already belongs to another attempt/);
    const seq = (await one<{ seq: number }>('SELECT seq FROM attempt_events WHERE attempt_id = ? ORDER BY seq LIMIT 1', a.attemptId))!.seq;
    await assert.rejects(db.prepare("INSERT OR REPLACE INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (?, ?, 'claimed', 1, '{}')")
      .bind(seq, a.attemptId).run(), /attempt history is append-only/);
    const row = (await one('SELECT * FROM attempts WHERE attempt_id = ?', a.attemptId))!;
    assert.equal(row.invoice_id, a.invoiceId);
    assert.equal(row.hash, hash);
    assert.equal(await count('SELECT count(*) c FROM attempt_events WHERE attempt_id = ?', a.attemptId), 2);
  });

  test('append-only events and recorded-open inserts', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    await assert.rejects(db.prepare("UPDATE attempt_events SET detail = '{}' WHERE attempt_id = ?").bind(a.attemptId).run(), /attempt history is append-only/);
    await assert.rejects(db.prepare('DELETE FROM attempt_events WHERE attempt_id = ?').bind(a.attemptId).run(), /attempt history is append-only/);
    await assert.rejects(rawInsert(uniq('raw'), uniq('inv'), { closed: 'verified-final' }), /attempts are recorded open/);
  });
});

describe('A5/C3 verified-final is terminal and requires attested evidence', () => {
  test('appendVerification refuses verified-final; negative verdicts are bound to the stored hash', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    await assert.rejects(store.appendVerification(a.attemptId, 2, 'not-final', 'verifier-1'), /verification requires a recorded transaction hash/);
    const hash = nextHash();
    await store.recordHash(a.attemptId, hash, 2);
    await assert.rejects(store.appendVerification(a.attemptId, 3, 'verified-final' as never, 'operator'), /verified-final can only be recorded from attested evidence/);
    await assert.rejects(store.appendVerification(a.attemptId, 3, 'mismatch', 'bad name!'), /invalid verification/);
    await store.appendVerification(a.attemptId, 3, 'not-final', 'verifier-1');
    const e = (await one<{ detail: string }>("SELECT detail FROM attempt_events WHERE attempt_id = ? AND kind = 'verification'", a.attemptId))!;
    assert.equal(e.detail, JSON.stringify({ result: 'not-final', verifier: 'verifier-1', hash }));
  });

  test('recordVerifiedFinal: unattested, foreign and unfinalized evidence are refused', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    await store.recordHash(a.attemptId, nextHash(), 2);
    const { tx, canonical } = await evidenceFor(a.attemptId);
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, { ...tx }, canonical, 3), /^Error: verified-final requires attested evidence$/);
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, JSON.parse(JSON.stringify(tx)), JSON.parse(JSON.stringify(canonical)), 3), /verified-final requires attested evidence/);
    const foreign = await evidenceFor(a.attemptId, { attemptId: 'other' });
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, foreign.tx, foreign.canonical, 3), /evidence does not belong to this attempt/);
    const wrongHash = await evidenceFor(a.attemptId, { hash: nextHash() });
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, wrongHash.tx, wrongHash.canonical, 3), /evidence does not belong to this attempt/);
    const failed = await evidenceFor(a.attemptId, { success: false });
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, failed.tx, failed.canonical, 3), /evidence does not belong to this attempt/);
    const unfinal = await evidenceFor(a.attemptId, {}, { finalizedBlockNumber: '99' });
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, unfinal.tx, unfinal.canonical, 3), /evidence is not canonical and finalized/);
    const reorg = await evidenceFor(a.attemptId, {}, { blockHash: '0x' + 'b2'.repeat(32) });
    await assert.rejects(store.recordVerifiedFinal(a.attemptId, reorg.tx, reorg.canonical, 3), /evidence is not canonical and finalized/);
    await assert.rejects(store.close(a.attemptId, 'verified-final', 4, 'ops-1'),
      /verified-final requires an independent verified-final verification \(the latest verdict, for the recorded hash\)/);
  });

  test('trigger: a raw verified-final verdict from a caller-named verifier cannot close the attempt', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    const hash = nextHash();
    await store.recordHash(a.attemptId, hash, 2);
    await db.prepare(`INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES (?, 'verification', 3, json_object('result', 'verified-final', 'verifier', 'operator', 'hash', ?))`)
      .bind(a.attemptId, hash).run();
    await assert.rejects(db.prepare("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = ?").bind(a.attemptId).run(),
      /verified-final requires the latest independent verdict for the recorded hash/);
    const hashless = claim(uniq('inv'));
    await store.recordAttempt(hashless);
    await assert.rejects(db.prepare("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = ?").bind(hashless.attemptId).run(),
      /verified-final requires a recorded transaction hash/);
    await assert.rejects(store.close(hashless.attemptId, 'verified-final', 3, 'ops-1'), /verified-final requires a recorded transaction hash/);
  });

  test('a newer negative verdict after verified-final blocks closing (latest verdict wins)', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    await store.recordHash(a.attemptId, nextHash(), 2);
    const { tx, canonical } = await evidenceFor(a.attemptId);
    await store.recordVerifiedFinal(a.attemptId, tx, canonical, 3);
    await store.appendVerification(a.attemptId, 4, 'mismatch', 'verifier-2');
    await assert.rejects(store.close(a.attemptId, 'verified-final', 5, 'ops-1'), /the latest verdict, for the recorded hash/);
  });

  test('verified-final is terminal: a fresh id under the same commitment is refused (store and raw SQL); closed rows are frozen', async () => {
    const a = await finalized(uniq('inv'));
    assert.equal((await one('SELECT closed FROM attempts WHERE attempt_id = ?', a.attemptId))!.closed, 'verified-final');
    await assert.rejects(store.recordAttempt(claim(a.invoiceId)), /^Error: this operation is already finalized$/);
    await assert.rejects(rawInsert(uniq('raw'), a.invoiceId), /an attempt for this (invoice )?operation is open or finalized/);
    await assert.rejects(db.prepare("UPDATE attempts SET dispatch = 'outcome-unknown' WHERE attempt_id = ?").bind(a.attemptId).run(), /closed attempts are frozen/);
    await assert.rejects(db.prepare('UPDATE attempts SET closed = NULL WHERE attempt_id = ?').bind(a.attemptId).run(), /attempt closure is final/);
    await assert.rejects(store.close(a.attemptId, 'reconciled-not-landed', 9, 'ops-1'), /reconciled-not-landed closure is disabled/);
  });

  test('A7: a new commitment digest is refused after final and while open (store and raw SQL)', async () => {
    const a = await finalized(uniq('inv'));
    await assert.rejects(store.recordAttempt(claim(a.invoiceId, { digest: digest2 })), /^Error: this operation is already finalized$/);
    await assert.rejects(rawInsert(uniq('raw'), a.invoiceId, { digest: digest2 }),
      /an attempt for this invoice operation is open or finalized under some commitment/);
    const open = claim(uniq('inv'));
    await store.recordAttempt(open);
    await assert.rejects(store.recordAttempt(claim(open.invoiceId, { digest: digest2 })), /^Error: an attempt for this operation is already open$/);
    await assert.rejects(rawInsert(uniq('raw'), open.invoiceId, { digest: digest2 }), /under some commitment/);
    // A different operation on the same invoice is independent.
    assert.equal(await store.recordAttempt(claim(open.invoiceId, { operation: 'conversion' })), 'created');
  });

  test('reconciled-not-landed is refused by the store and by raw SQL, so hashless/unknown attempts keep blocking', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    await store.recordOutcomeUnknown(a.attemptId, 2, 'crash after submit');
    await assert.rejects(store.close(a.attemptId, 'reconciled-not-landed', 3, 'ops-1'),
      /^Error: reconciled-not-landed closure is disabled until authoritative reconciliation exists$/);
    await assert.rejects(db.prepare("UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = ?").bind(a.attemptId).run(),
      /reconciled-not-landed closure is disabled until authoritative reconciliation exists/);
    await assert.rejects(store.recordAttempt(claim(a.invoiceId)), /already open/);
    assert.equal((await one('SELECT dispatch FROM attempts WHERE attempt_id = ?', a.attemptId))!.dispatch, 'outcome-unknown');
  });
});

describe('legacy unresolved attempts', () => {
  test('import is unresolved, idempotent, conflict-checked and blocks new attempts', async () => {
    const inv = uniq('inv');
    const legacy = { digest, invoiceId: inv, swapId: uniq('swap'), payoutId: uniq('pay') };
    assert.deepEqual(await store.importLegacy('tenant-a', legacy, 5), [legacy.swapId, legacy.payoutId]);
    assert.deepEqual(await store.importLegacy('tenant-a', legacy, 6), []);
    await assert.rejects(store.importLegacy('tenant-b', legacy, 7), /^Error: legacy attempt id conflict$/);
    await assert.rejects(store.importLegacy('tenant-a', { ...legacy, digest: digest2 }, 7), /legacy attempt id conflict/);
    await assert.rejects(store.recordAttempt(claim(inv)), /already open/);
    await assert.rejects(store.recordAttempt(claim(inv, { digest: digest2 })), /already open/);
    const [row] = await d1Attempts(db).attempts({ tenantId: 'tenant-a', invoiceId: inv, digest }, 'payout');
    assert.equal(row.lineage, 'unresolved');
    assert.equal(row.recordedRevision, null);
    assert.equal(row.dispatch, 'outcome-unknown');
    assert.deepEqual(row.history.map(e => e.kind), ['legacy-import']);
  });
});

describe('reader parity with the node:sqlite AttemptLineageReader', () => {
  test('the same operations produce identical attested rows (shape, history, seq)', async t => {
    const w2 = await startWorker({ keys: { [k.keyId]: k.secret } });
    t.after(() => w2.mf.dispose());
    await applySchema(w2.db);
    const d1 = new D1LineageWriter(w2.db);
    const dir = mkdtempSync(join(tmpdir(), 'daidai-d1-parity-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const node = new AttemptLineageStore(join(dir, 'l.db'));
    const a = claim('inv-parity', { attemptId: 'parity-1' });
    const hash = nextHash();
    node.recordAttempt(a); await d1.recordAttempt(a);
    node.recordHash(a.attemptId, hash, 2); await d1.recordHash(a.attemptId, hash, 2);
    node.appendVerification(a.attemptId, 3, 'not-final', 'verifier-1'); await d1.appendVerification(a.attemptId, 3, 'not-final', 'verifier-1');
    node.recordOutcomeUnknown(a.attemptId, 4, 'note'); await d1.recordOutcomeUnknown(a.attemptId, 4, 'note');
    node.importLegacy('tenant-a', { digest, invoiceId: 'inv-parity', swapId: 'legacy-swap' }, 5);
    await d1.importLegacy('tenant-a', { digest, invoiceId: 'inv-parity', swapId: 'legacy-swap' }, 5);
    node.close_db();
    const reader = new AttemptLineageReader(join(dir, 'l.db'));
    t.after(() => reader.close());
    for (const op of ['payout', 'conversion'] as const) {
      const binding = { tenantId: 'tenant-a', invoiceId: 'inv-parity', digest };
      const fromNode = reader.attempts(binding, op), fromD1 = await d1Attempts(w2.db).attempts(binding, op);
      assert.equal(fromD1.length, 1);
      assert.ok(fromD1.every(isAttested) && Object.isFrozen(fromD1[0].history));
      assert.deepEqual(fromD1, fromNode);
    }
  });
});

describe('A6 concurrency and batch atomicity', () => {
  test('many concurrent recordAttempt calls for one key (fresh ids, mixed digests) → exactly one row', async () => {
    const inv = uniq('inv');
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => store.recordAttempt(claim(inv, { digest: i % 2 ? digest : digest2 }))));
    const created = results.filter(r => r.status === 'fulfilled');
    assert.equal(created.length, 1);
    for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /an attempt for this operation is already open/);
    assert.equal(await count("SELECT count(*) c FROM attempts WHERE invoice_id = ? AND operation = 'payout'", inv), 1);
    assert.equal(await count("SELECT count(*) c FROM attempt_events e JOIN attempts a USING (attempt_id) WHERE a.invoice_id = ?", inv), 1);
  });

  test('concurrent identical claims → one created, the rest existing; one claimed event', async () => {
    const a = claim(uniq('inv'));
    const results = await Promise.all(Array.from({ length: 12 }, () => store.recordAttempt(a)));
    assert.equal(results.filter(r => r === 'created').length, 1);
    assert.equal(results.filter(r => r === 'existing').length, 11);
    assert.equal(await count('SELECT count(*) c FROM attempt_events WHERE attempt_id = ?', a.attemptId), 1);
  });

  test('raw concurrent inserts (no pre-check at all) still yield one row: the triggers are the authority', async () => {
    const inv = uniq('inv');
    const results = await Promise.allSettled(Array.from({ length: 16 }, () => rawInsert(uniq('raw'), inv)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results) if (r.status === 'rejected') assert.match(String(r.reason), /open or finalized/);
  });

  test('a failing statement rolls back the whole batch', async () => {
    const inv = uniq('inv'), id1 = uniq('raw');
    await assert.rejects(db.batch([
      db.prepare(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms,
        authorization, envelope, hash, dispatch, closed) VALUES (?, 'tenant-a', ?, ?, 1, 'recorded', 'payout', 1, '{}', '{}', NULL, 'claimed', NULL)`).bind(id1, inv, digest),
      db.prepare("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES (?, 'claimed', 1, '{}')").bind(id1),
      db.prepare("UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = ?").bind(id1),
    ]), /reconciled-not-landed closure is disabled/);
    assert.equal(await count('SELECT count(*) c FROM attempts WHERE attempt_id = ?', id1), 0);
    assert.equal(await count('SELECT count(*) c FROM attempt_events WHERE attempt_id = ?', id1), 0);
  });

  test('close(): if the UPDATE is refused, the closed event in the same batch is rolled back', async () => {
    const a = claim(uniq('inv'));
    await store.recordAttempt(a);
    await store.recordHash(a.attemptId, nextHash(), 2);
    await assert.rejects(db.batch([
      db.prepare("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES (?, 'closed', 3, '{}')").bind(a.attemptId),
      db.prepare("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = ?").bind(a.attemptId),
    ]), /verified-final requires the latest independent verdict/);
    assert.equal(await count("SELECT count(*) c FROM attempt_events WHERE attempt_id = ? AND kind = 'closed'", a.attemptId), 0);
  });
});

describe('A8 unsupported D1 semantics (observed on local workerd)', () => {
  test('no interactive transactions: BEGIN / COMMIT / ROLLBACK / SAVEPOINT are rejected', async () => {
    for (const sql of ['BEGIN', 'BEGIN IMMEDIATE', 'BEGIN TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT s1']) {
      await assert.rejects(db.prepare(sql).run(), /To execute a transaction, please use the state\.storage\.transaction\(\)/, sql);
    }
  });
  test('no journal_mode / busy_timeout / query_only / ATTACH (not authorized)', async () => {
    for (const sql of ['PRAGMA journal_mode', 'PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 2000', 'PRAGMA query_only = ON',
      "ATTACH DATABASE ':memory:' AS other"]) {
      await assert.rejects(db.prepare(sql).run(), /not authorized/, sql);
    }
  });
  test('foreign keys are enforced by default (event for an unknown attempt is refused)', async () => {
    await assert.rejects(db.prepare("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('no-such-attempt', 'claimed', 1, '{}')").run(),
      /FOREIGN KEY constraint failed/);
  });
  test('no read-only connection: the binding that reads can also write and even drop triggers (code review is the guard)', async t => {
    const w2 = await startWorker({ keys: { [k.keyId]: k.secret } });
    t.after(() => w2.mf.dispose());
    await applySchema(w2.db);
    await w2.db.prepare('DROP TRIGGER attempt_no_delete').run();
    assert.equal(await (async () => { try { await w2.db.prepare('PRAGMA query_only = ON').run(); return 'set'; } catch { return 'refused'; } })(), 'refused');
    // Re-applying the idempotent schema restores the dropped trigger.
    await applySchema(w2.db);
    assert.equal(Number((await w2.db.prepare("SELECT count(*) c FROM sqlite_master WHERE type = 'trigger' AND name = 'attempt_no_delete'").first<{ c: number }>())!.c), 1);
  });
  test('the schema is idempotent and applies statement by statement', async () => {
    await applySchema(db);
    const triggers = Number((await one<{ c: number }>("SELECT count(*) c FROM sqlite_master WHERE type = 'trigger'"))!.c);
    assert.equal(triggers, SCHEMA_STATEMENTS.filter(s => /CREATE TRIGGER/.test(s)).length);
  });
});

describe('recovery: a persisted local D1 keeps its invariants after restart', () => {
  test('reopen the persist dir; rows, triggers and terminal state survive', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'daidai-d1-persist-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const first = await startWorker({ keys: { [k.keyId]: k.secret }, persist: dir });
    await applySchema(first.db);
    const writer = new D1LineageWriter(first.db);
    const a = claim('inv-persist', { attemptId: 'persist-1' });
    await writer.recordAttempt(a);
    const hash = nextHash();
    await writer.recordHash(a.attemptId, hash, 2);
    const ev = await (async () => {
      const r = (await first.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').bind(a.attemptId).first())!;
      return { r };
    })();
    assert.equal(ev.r.hash, hash);
    await first.mf.dispose();

    const second = await startWorker({ keys: { [k.keyId]: k.secret }, persist: dir });
    t.after(() => second.mf.dispose());
    await applySchema(second.db); // idempotent on an existing database
    const again = new D1LineageWriter(second.db);
    const row = (await second.db.prepare('SELECT hash, dispatch FROM attempts WHERE attempt_id = ?').bind(a.attemptId).first())!;
    assert.deepEqual({ ...row }, { hash, dispatch: 'hash-recorded' });
    await assert.rejects(again.recordHash(a.attemptId, nextHash(), 3), /attempt hash is immutable/);
    await assert.rejects(again.recordAttempt(claim('inv-persist', { digest: digest2 })), /already open/);
    await assert.rejects(second.db.prepare('DELETE FROM attempts').run(), /attempts are retained/);
  });
});
