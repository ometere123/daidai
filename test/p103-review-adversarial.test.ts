// Independent adversarial review of P10.3 attempt lineage (B1, B2, H fixes). Temp SQLite files only, under /tmp/daidai-adv2.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyFinal } from './lineage-fixtures.ts';
import { DatabaseSync } from 'node:sqlite';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { selectAttempt } from '../src/authoritative-invoice.ts';

const root = '/tmp/daidai-adv2';
mkdirSync(root, { recursive: true });
const digest = 'ab'.repeat(32), digest2 = 'cd'.repeat(32);
const base = { tenantId: 'tenant-a', invoiceId: 'invoice-a', digest };
const fp = (d = digest) => ({ digest: d, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 });
const env = envelopeOf({ chainId: 42220, to: '0x' + '11'.repeat(20), data: '0xa9059cbb', value: '0' });
const hashA = '0x' + '55'.repeat(32), hashB = '0x' + '66'.repeat(32);
const claim = (p: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: 'pay-1', ...base, recordedRevision: 3, operation: 'payout', createdAtMs: 1_000_000, authorization: fp(p.digest), envelope: env, ...p,
});

function fresh(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(root, 't-'));
  const file = join(dir, 'lineage.db');
  const store = new AttemptLineageStore(file);
  const raws: DatabaseSync[] = [];
  const raw = (fk = true) => { const d = new DatabaseSync(file); d.exec(`PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ${fk ? 'ON' : 'OFF'};`); raws.push(d); return d; };
  t.after(() => { for (const d of raws) try { d.close(); } catch {} ; try { store.close_db(); } catch {} ; rmSync(dir, { recursive: true, force: true }); });
  return { file, store, raw };
}
function snap(file: string) {
  const d = new DatabaseSync(file, { readOnly: true });
  try { return JSON.stringify([d.prepare('SELECT * FROM attempts ORDER BY attempt_id').all(), d.prepare('SELECT * FROM attempt_events ORDER BY seq').all()]); }
  finally { d.close(); }
}
function finalize(store: AttemptLineageStore, id = 'pay-1', h = hashA, p: Partial<NewAttempt> = {}) {
  store.recordAttempt(claim({ attemptId: id, ...p }));
  store.recordHash(id, h, 1_000_100);
  verifyFinal(store, id, 1_000_200);
  store.close(id, 'verified-final', 1_000_300, 'ops-reviewer');
}
const cols = `(attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms, authorization, envelope, hash, dispatch, closed)`;
function rawInsert(db: DatabaseSync, verb: string, r: Record<string, unknown> = {}, tail = '') {
  const v = { attempt_id: 'pay-2', tenant_id: 'tenant-a', invoice_id: 'invoice-a', digest, recorded_revision: 3, lineage: 'recorded', operation: 'payout',
    created_at_ms: 2_000_000, authorization: JSON.stringify(fp()), envelope: JSON.stringify(env), hash: null, dispatch: 'claimed', closed: null, ...r };
  return db.prepare(`${verb} INTO attempts ${cols} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ${tail}`).run(...(Object.values(v) as (string | number | null)[]));
}
const count = (file: string) => JSON.parse(snap(file))[0].length as number;

// 1. Final, then a second attempt with the same key.
for (const operation of ['payout', 'conversion'] as const) {
  test(`${operation}: after verified-final, no second attempt via store or any raw insert form`, t => {
    const { file, store, raw } = fresh(t);
    finalize(store, 'pay-1', hashA, { operation });
    const before = snap(file);
    assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-2', operation, recordedRevision: 9 })), /this operation is already finalized/);
    const db = raw();
    for (const verb of ['INSERT', 'INSERT OR REPLACE', 'INSERT OR IGNORE', 'REPLACE', 'INSERT OR ROLLBACK', 'INSERT OR FAIL']) {
      assert.throws(() => rawInsert(db, verb, { operation }), /open or finalized/, verb);
      // Same id as the final row: identity guard fires first.
      assert.throws(() => rawInsert(db, verb, { operation, attempt_id: 'pay-1' }), /attempt identity is immutable|open or finalized/, verb + ' same id');
    }
    assert.throws(() => rawInsert(db, 'INSERT', { operation }, 'ON CONFLICT DO UPDATE SET closed = NULL'), /open or finalized/);
    assert.throws(() => rawInsert(db, 'INSERT', { operation, attempt_id: 'pay-1' }, 'ON CONFLICT(attempt_id) DO UPDATE SET closed = NULL'), /attempt identity is immutable|open or finalized/);
    assert.throws(() => rawInsert(db, 'INSERT', { operation }, 'ON CONFLICT DO NOTHING'), /open or finalized/);
    assert.equal(snap(file), before);
  });
}

// 2. Key dodges.
test('key dodges: revision/legacy blocked; other operation allowed; case variants are distinct keys (store rejects whitespace)', t => {
  const { file, store, raw } = fresh(t);
  finalize(store);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-r', recordedRevision: 0 })), /already finalized/);
  assert.throws(() => store.importLegacy('tenant-a', { digest, invoiceId: 'invoice-a', payoutId: 'legacy-pay' }, 3_000_000), /open or finalized/);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-w', tenantId: 'tenant-a ' })), /invalid attempt identity/);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-w', digest: digest.toUpperCase() })), /invalid attempt binding/);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-w', operation: 'Payout' as 'payout' })), /invalid attempt binding/);
  assert.throws(() => rawInsert(raw(), 'INSERT', { operation: 'PAYOUT' }), /CHECK constraint failed/);
  assert.equal(store.recordAttempt(claim({ attemptId: 'conv-1', operation: 'conversion' })), 'created');
  // Observation: identifiers are compared byte-exactly; 'Tenant-A' is a different tenant to the store.
  assert.equal(store.recordAttempt(claim({ attemptId: 'pay-case', tenantId: 'Tenant-A' })), 'created');
  // Raw writer can insert a whitespace-variant key that the store would never accept; reader for the real binding never sees it.
  rawInsert(raw(), 'INSERT', { attempt_id: 'pay-ws', invoice_id: 'invoice-a ' });
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  assert.deepEqual(reader.attempts(base, 'payout').map(a => a.id), ['pay-1']);
});

test('policy (P10.4): a NEW digest for the same invoice cannot pay a finalized payout again', t => {
  const { store, raw, file } = fresh(t);
  finalize(store);
  const before = snap(file);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-d2', digest: digest2 })), /this operation is already finalized/);
  assert.throws(() => raw().prepare(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
    created_at_ms, authorization, envelope, hash, dispatch, closed) SELECT 'pay-raw', tenant_id, invoice_id, ?, recorded_revision, lineage,
    operation, created_at_ms, authorization, envelope, NULL, 'claimed', NULL FROM attempts WHERE attempt_id = 'pay-1'`).run(digest2),
    /open or finalized/);
  assert.equal(snap(file), before);
});

// 3. reconciled-not-landed.
test('reconciled-not-landed cannot be written by any path', t => {
  const { file, store, raw } = fresh(t);
  store.recordAttempt(claim());
  store.recordHash('pay-1', hashA, 1_000_100);
  const before = snap(file);
  assert.throws(() => store.close('pay-1', 'reconciled-not-landed', 1_000_500, 'ops-reviewer'), /disabled until authoritative reconciliation/);
  const db = raw();
  for (const verb of ['UPDATE', 'UPDATE OR REPLACE', 'UPDATE OR IGNORE'])
    assert.throws(() => db.prepare(`${verb} attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'pay-1'`).run(), /disabled until authoritative reconciliation/, verb);
  assert.throws(() => db.prepare(`UPDATE attempts SET closed = 'reconciled-not-landed', dispatch = 'claimed' WHERE attempt_id = 'pay-1'`).run(), /disabled until authoritative reconciliation/);
  assert.throws(() => rawInsert(db, 'INSERT', { attempt_id: 'pay-x', tenant_id: 'tenant-z', closed: 'reconciled-not-landed' }), /attempts are recorded open/);
  assert.throws(() => rawInsert(db, 'INSERT', { attempt_id: 'pay-x', tenant_id: 'tenant-z', closed: 'verified-final', hash: hashB }), /attempts are recorded open/);
  assert.equal(snap(file), before);
});

test('closure is final: other-column updates on a final row cannot reopen or relabel it', t => {
  const { file, store, raw } = fresh(t);
  finalize(store);
  const before = snap(file), db = raw();
  assert.throws(() => db.prepare(`UPDATE OR REPLACE attempts SET closed = NULL WHERE attempt_id = 'pay-1'`).run(), /attempt closure is final/);
  assert.throws(() => db.prepare(`UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'pay-1'`).run(), /disabled|closure is final/);
  assert.throws(() => db.prepare(`UPDATE attempts SET dispatch = 'outcome-unknown' WHERE attempt_id = 'pay-1'`).run(), /closed attempts are frozen/);
  assert.throws(() => db.prepare(`UPDATE attempts SET invoice_id = 'invoice-b' WHERE attempt_id = 'pay-1'`).run(), /attempt identity is immutable/);
  assert.throws(() => db.prepare(`DELETE FROM attempts WHERE attempt_id = 'pay-1'`).run(), /attempts are retained/);
  assert.equal(snap(file), before);
});

test('projector: a forged reconciled-not-landed row (triggers dropped in a scratch copy) still fails closed', t => {
  const { file, store, raw } = fresh(t);
  finalize(store);
  const db = raw();
  db.exec('DROP TRIGGER attempt_close_once; DROP TRIGGER reconciled_not_landed_disabled; DROP TRIGGER closed_attempt_frozen; DROP TRIGGER operation_open_or_final');
  db.exec(`UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'pay-1'`);
  rawInsert(db, 'INSERT', { attempt_id: 'pay-2' });
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  const sel = selectAttempt({ ...base, revision: 5 }, 'payout', reader.attempts(base, 'payout'));
  assert.ok('projection' in sel);
  assert.equal((sel as { projection: { reason: string } }).projection.reason, 'multiple-attempts');
  // Re-opening the store restores the dropped triggers (CREATE ... IF NOT EXISTS).
  const s2 = new AttemptLineageStore(file); t.after(() => s2.close_db());
  assert.throws(() => rawInsert(db, 'INSERT', { attempt_id: 'pay-3', hash: hashB }), /open or finalized/);
});

// 4. Fraudulent verified-final.
test('verified-final requires hash and a verified-final verification of the same attempt', t => {
  const { file, store, raw } = fresh(t);
  store.recordAttempt(claim());
  store.recordAttempt(claim({ attemptId: 'other-1', invoiceId: 'invoice-b' }));
  // (Lead, after fixing F1) a verdict can no longer be recorded before a hash exists.
  assert.throws(() => store.appendVerification('pay-1', 1_000_050, 'verified-final' as 'mismatch', 'v'), /only be recorded from attested evidence/);
  let before = snap(file);
  assert.throws(() => store.close('pay-1', 'verified-final', 1_000_300, 'ops'), /verified-final requires a recorded transaction hash/);
  assert.throws(() => raw().prepare(`UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'pay-1'`).run(), /verified-final requires a recorded transaction hash/);
  assert.equal(snap(file), before);
  store.recordHash('other-1', hashB, 1_000_060);
  store.appendVerification('other-1', 1_000_070, 'mismatch', 'v');
  store.appendVerification('other-1', 1_000_071, 'not-found', 'v');
  store.appendVerification('other-1', 1_000_072, 'not-final', 'v');
  before = snap(file);
  assert.throws(() => store.close('other-1', 'verified-final', 1_000_300, 'ops'), /independent verified-final verification/);
  for (const op of ['', ' ', 'ops reviewer', '../x', 'a'.repeat(200)])
    assert.throws(() => store.close('other-1', 'verified-final', 1_000_300, op), /accountable operator/, JSON.stringify(op));
  assert.throws(() => store.close('nope', 'verified-final', 1_000_300, 'ops'), /unknown attempt/);
  assert.throws(() => store.close('other-1', 'bogus' as 'verified-final', 1_000_300, 'ops'), /disabled until authoritative reconciliation/);
  assert.equal(snap(file), before);
});

test('FIXED (re-review F1): verification is bound to the recorded hash and only the latest verdict counts', t => {
  const { store, raw, file } = fresh(t);
  store.recordAttempt(claim());
  assert.throws(() => store.appendVerification('pay-1', 1_000_050, 'verified-final' as 'mismatch', 'v'), /only be recorded from attested evidence/);
  store.recordHash('pay-1', hashA, 1_000_100);
  verifyFinal(store, 'pay-1', 1_000_120);
  store.appendVerification('pay-1', 1_000_150, 'mismatch', 'v');       // latest verdict contradicts
  const before = snap(file);
  assert.throws(() => store.close('pay-1', 'verified-final', 1_000_300, 'ops'), /the latest verdict, for the recorded hash/);
  assert.throws(() => raw().prepare(`UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'pay-1'`).run(), /latest independent verdict for the recorded hash/);
  assert.equal(snap(file), before);
  verifyFinal(store, 'pay-1', 1_000_200);
  store.close('pay-1', 'verified-final', 1_000_300, 'ops');
});

test('FIXED (re-review observation): a raw writer cannot close verified-final without a verification event', t => {
  const { file, store, raw } = fresh(t);
  store.recordAttempt(claim());
  store.recordHash('pay-1', hashA, 1_000_100);
  const before = snap(file);
  assert.throws(() => raw().prepare(`UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'pay-1'`).run(), /latest independent verdict for the recorded hash/);
  assert.equal(snap(file), before);
});

// 5. Unknown/hashless attempts block forever.
test('claimed-only, outcome-unknown and legacy attempts keep blocking', t => {
  const { file, store } = fresh(t);
  store.recordAttempt(claim());
  store.recordOutcomeUnknown('pay-1', 1_000_100, 'crash');
  store.importLegacy('tenant-a', { digest, invoiceId: 'invoice-a', swapId: 'legacy-swap' }, 1_000_200);
  const before = snap(file);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'pay-2', createdAtMs: 9_999_999_999 })), /already open/);
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'conv-2', operation: 'conversion' })), /already open/);
  assert.throws(() => store.close('pay-1', 'verified-final', 1, 'ops'), /recorded transaction hash/);
  assert.equal(snap(file), before);
});

// 6. Cross-tenant / cross-invoice.
test('a final attempt for tenant A/invoice X does not block B or Y, and foreign rows do not affect selection', t => {
  const { file, store } = fresh(t);
  finalize(store);
  assert.equal(store.recordAttempt(claim({ attemptId: 'b-1', tenantId: 'tenant-b' })), 'created');
  assert.equal(store.recordAttempt(claim({ attemptId: 'y-1', invoiceId: 'invoice-y' })), 'created');
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  const rows = reader.attempts(base, 'payout');
  assert.deepEqual(rows.map(a => a.id), ['pay-1']);
  const sel = selectAttempt({ ...base, revision: 5 }, 'payout', rows);
  assert.ok('attempt' in sel && sel.attempt.id === 'pay-1');
  const sel2 = selectAttempt({ ...base, revision: 5 }, 'payout', reader.attempts({ ...base, tenantId: 'tenant-b' }, 'payout'));
  assert.ok('projection' in sel2 && sel2.projection.reason === 'mismatch');
});

test('FIXED (re-review F2): importLegacy no longer silently skips a legacy id that already belongs to ANOTHER tenant/invoice, leaving the legacy dispatch unrecorded', t => {
  // src/attempt-lineage.ts importLegacy: `if (this.row(attemptId)) return;` without comparing tenant/invoice/digest/operation.
  const { store } = fresh(t);
  store.recordAttempt(claim({ attemptId: 'shared-id', tenantId: 'tenant-b', invoiceId: 'invoice-b' }));
  let out: string[] | Error;
  try { out = store.importLegacy('tenant-a', { digest, invoiceId: 'invoice-a', payoutId: 'shared-id' }, 2_000_000); } catch (e) { out = e as Error; }
  const blocked = (() => { try { store.recordAttempt(claim({ attemptId: 'fresh-pay' })); return false; } catch { return true; } })();
  void blocked;
  // (Lead) The import now fails loudly with the specific conflict, so the legacy dispatch can't be silently dropped.
  assert.ok(out instanceof Error, 'legacy import must refuse a conflicting id');
  assert.match(out.message, /legacy attempt id conflict/);
});

// 7. Hash conflicts.
test('hash reuse through INSERT OR REPLACE / UPDATE OR REPLACE never deletes rows; history preserved byte-for-byte', t => {
  const { file, store, raw } = fresh(t);
  finalize(store);
  store.recordAttempt(claim({ attemptId: 'b-1', tenantId: 'tenant-b' }));
  const before = snap(file), db = raw();
  for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE'])
    assert.throws(() => rawInsert(db, verb, { attempt_id: 'c-1', tenant_id: 'tenant-c', hash: hashA, dispatch: 'hash-recorded' }), /already belongs to another attempt/, verb);
  for (const verb of ['UPDATE', 'UPDATE OR REPLACE', 'UPDATE OR IGNORE'])
    assert.throws(() => db.prepare(`${verb} attempts SET hash = ? WHERE attempt_id = 'b-1'`).run(hashA), /already belongs to another attempt/, verb);
  assert.throws(() => store.recordHash('b-1', hashA, 2_000_000), /already belongs to another attempt/);
  assert.equal(snap(file), before);
});

// 8. Concurrency.
test('concurrent writers: BEGIN IMMEDIATE holder blocks others; never two open rows', t => {
  const { file, store, raw } = fresh(t);
  const s2 = new AttemptLineageStore(file); t.after(() => s2.close_db());
  s2.db.exec('PRAGMA busy_timeout = 0');
  const holder = raw();
  holder.exec('BEGIN IMMEDIATE');
  rawInsert(holder, 'INSERT', { attempt_id: 'raw-1' });
  assert.throws(() => s2.recordAttempt(claim({ attemptId: 'pay-s2' })), /database is locked|busy/i);
  holder.exec('COMMIT');
  const results = [store, s2].map((s, n) => { try { return s.recordAttempt(claim({ attemptId: 'race-' + n })); } catch (e) { return (e as Error).message; } });
  assert.deepEqual(results, ['an attempt for this operation is already open', 'an attempt for this operation is already open']);
  assert.equal(count(file), 1);
});

// 9. Event immutability and foreign keys.
test('events are append-only; seq reuse refused; FK enforced only on connections that enable it', t => {
  const { file, store, raw } = fresh(t);
  finalize(store);
  const before = snap(file), db = raw();
  assert.throws(() => db.prepare(`UPDATE attempt_events SET detail = '{}' WHERE seq = 1`).run(), /append-only/);
  assert.throws(() => db.prepare(`UPDATE OR REPLACE attempt_events SET seq = 99 WHERE seq = 1`).run(), /append-only/);
  assert.throws(() => db.prepare(`DELETE FROM attempt_events`).run(), /append-only/);
  for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE'])
    assert.throws(() => db.prepare(`${verb} INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (1, 'pay-1', 'closed', 1, '{}')`).run(), /append-only/, verb);
  assert.throws(() => db.prepare(`INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('ghost', 'claimed', 1, '{}')`).run(), /FOREIGN KEY constraint failed/);
  assert.equal(snap(file), before);
  // Observation: node:sqlite enables FKs by default; a raw connection that sets foreign_keys = OFF can append orphan events.
  raw(false).prepare(`INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('ghost', 'claimed', 1, '{}')`).run();
  assert.notEqual(snap(file), before);
});
