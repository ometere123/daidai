import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { isAttested } from '../src/evidence-attestation.ts';
import { cngn, reactor } from '../src/invoice.ts';

const digest = 'ab'.repeat(32);
const base = { tenantId: 'tenant-a', invoiceId: 'invoice-a', digest };
const fingerprint = { digest, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 };
const conversionEnvelope = envelopeOf({ chainId: 42220, to: reactor, data: '0x1234', value: '0' });
const payoutEnvelope = envelopeOf({ chainId: 42220, to: cngn, data: '0xa9059cbb', value: '0' });
const hashA = '0x' + '55'.repeat(32), hashB = '0x' + '66'.repeat(32);

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-lineage-'));
  const file = join(dir, 'lineage.db');
  const store = new AttemptLineageStore(file);
  return { file, store, cleanup: () => { store.close_db(); rmSync(dir, { recursive: true, force: true }); } };
}
const claim = (patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: 'conv-1', ...base, recordedRevision: 3, operation: 'conversion', createdAtMs: 1_000_000,
  authorization: fingerprint, envelope: conversionEnvelope, ...patch,
});

test('a claimed attempt keeps its recorded revision and identity; history is appended, never rewritten', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  assert.equal(store.recordAttempt(claim()), 'created');
  store.recordHash('conv-1', hashA, 1_000_100);
  store.appendVerification('conv-1', 1_000_200, 'not-final', 'transaction-verifier');
  store.appendVerification('conv-1', 1_000_300, 'verified-final', 'transaction-verifier');
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  const [a] = reader.attempts(base, 'conversion');
  assert(isAttested(a));
  assert.equal(a.recordedRevision, 3);
  assert.equal(a.lineage, 'recorded');
  assert.equal(a.hash, hashA);
  assert.equal(a.dispatch, 'hash-recorded');
  assert.deepEqual(a.history.map(e => e.kind), ['claimed', 'hash-recorded', 'verification', 'verification']);
  assert.deepEqual(a.history.map(e => e.detail.result).filter(Boolean), ['not-final', 'verified-final']);
  assert(Object.isFrozen(a) && Object.isFrozen(a.history));
});

test('duplicate claims are idempotent; a conflicting claim under the same id is refused', t => {
  const { store, cleanup } = fresh(); t.after(cleanup);
  store.recordAttempt(claim());
  assert.equal(store.recordAttempt(claim()), 'existing');
  assert.throws(() => store.recordAttempt(claim({ recordedRevision: 4 })), /attempt id conflict/);
  assert.throws(() => store.recordAttempt(claim({ envelope: payoutEnvelope })), /attempt id conflict/);
});

test('only one open attempt per operation; a second needs explicit reconciliation of the first', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  store.recordAttempt(claim());
  assert.throws(() => store.recordAttempt(claim({ attemptId: 'conv-2', recordedRevision: 5 })), /already open/);
  // A payout for the same invoice is a different operation and may be open at the same time.
  store.recordAttempt(claim({ attemptId: 'pay-1', operation: 'payout', recordedRevision: 6, envelope: payoutEnvelope }));
  assert.throws(() => store.close('conv-1', 'reconciled-not-landed', 1_000_500, ''), /accountable operator/);
  store.close('conv-1', 'reconciled-not-landed', 1_000_500, 'ops-reviewer');
  assert.equal(store.recordAttempt(claim({ attemptId: 'conv-2', recordedRevision: 5 })), 'created');
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  const attempts = reader.attempts(base, 'conversion');
  assert.deepEqual(attempts.map(a => [a.id, a.recordedRevision, a.closed]), [['conv-1', 3, 'reconciled-not-landed'], ['conv-2', 5, null]]);
});

test('concurrent claims from two connections: exactly one wins', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  const other = new AttemptLineageStore(file); t.after(() => other.close_db());
  const results = [store, other].map((s, n) => {
    try { return s.recordAttempt(claim({ attemptId: 'race-' + n })); } catch (e) { return (e as Error).message; }
  });
  assert.equal(results.filter(r => r === 'created').length, 1);
  assert.match(String(results.find(r => r !== 'created')), /already open/);
});

test('a crash after the claim and before a hash leaves a retained, hashless attempt', t => {
  const { file, cleanup } = fresh(); t.after(cleanup);
  const crashing = new AttemptLineageStore(file);
  crashing.recordAttempt(claim());
  crashing.close_db(); // simulated crash: the process ends, nothing else is written
  const reopened = new AttemptLineageStore(file); t.after(() => reopened.close_db());
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  const [a] = reader.attempts(base, 'conversion');
  assert.equal(a.hash, null);
  assert.equal(a.dispatch, 'claimed');
  // The open attempt still blocks any automatic new attempt.
  assert.throws(() => reopened.recordAttempt(claim({ attemptId: 'conv-2' })), /already open/);
  reopened.recordOutcomeUnknown('conv-1', 1_000_100, 'wallet returned no hash');
  assert.equal(new AttemptLineageReader(file).attempts(base, 'conversion')[0].dispatch, 'outcome-unknown');
});

test('hashes are set once; a different hash or a reused hash is refused by SQLite', t => {
  const { store, cleanup } = fresh(); t.after(cleanup);
  store.recordAttempt(claim());
  store.recordAttempt(claim({ attemptId: 'pay-1', operation: 'payout', envelope: payoutEnvelope }));
  store.recordHash('conv-1', hashA, 1_000_100);
  store.recordHash('conv-1', hashA, 1_000_200); // idempotent
  assert.throws(() => store.recordHash('conv-1', hashB, 1_000_300), /immutable/);
  assert.throws(() => store.recordHash('pay-1', hashA, 1_000_300), /UNIQUE/);
  assert.throws(() => store.recordHash('conv-1', 'not-a-hash', 1_000_300), /invalid transaction hash/);
});

test('identity, closure and history are immutable at the database level', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  store.recordAttempt(claim());
  store.close('conv-1', 'verified-final', 1_000_100, 'ops-reviewer');
  const raw = new DatabaseSync(file); t.after(() => raw.close());
  assert.throws(() => raw.exec("UPDATE attempts SET recorded_revision = 99 WHERE attempt_id = 'conv-1'"), /immutable/);
  assert.throws(() => raw.exec("UPDATE attempts SET lineage = 'unresolved' WHERE attempt_id = 'conv-1'"), /immutable/);
  assert.throws(() => raw.exec("UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'conv-1'"), /final/);
  assert.throws(() => raw.exec("DELETE FROM attempts"), /retained/);
  assert.throws(() => raw.exec("UPDATE attempt_events SET kind = 'claimed'"), /append-only/);
  assert.throws(() => raw.exec("DELETE FROM attempt_events"), /append-only/);
  assert.throws(() => raw.exec(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
    created_at_ms, authorization, envelope, hash, dispatch, closed) VALUES ('x', 't', 'i', '${digest}', NULL, 'recorded', 'payout', 1, NULL, NULL, NULL, 'claimed', NULL)`), /CHECK/);
});

test('the reader connection cannot write', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  store.recordAttempt(claim());
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  assert.throws(() => reader.db.exec("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('conv-1', 'closed', 1, '{}')"), /readonly|read-only|query_only/i);
});

test('legacy attempts without a provable revision are imported as unresolved and never guessed', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  const legacy = { digest, invoiceId: 'invoice-a', swapId: digest + ':swap', payoutId: digest + ':payout' };
  assert.deepEqual(store.importLegacy('tenant-a', legacy, 1_000_000), [legacy.swapId, legacy.payoutId]);
  assert.deepEqual(store.importLegacy('tenant-a', legacy, 1_000_001), []); // idempotent
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  for (const op of ['conversion', 'payout'] as const) {
    const [a] = reader.attempts(base, op);
    assert.equal(a.lineage, 'unresolved');
    assert.equal(a.recordedRevision, null);
    assert.equal(a.authorization, null);
    assert.equal(a.hash, null);
    assert.equal(a.history[0].kind, 'legacy-import');
  }
  // An unresolved legacy attempt is open, so it blocks a fresh attempt until a human reconciles it.
  assert.throws(() => store.recordAttempt(claim()), /already open/);
});

test('invalid claims are refused before anything is written', t => {
  const { file, store, cleanup } = fresh(); t.after(cleanup);
  for (const bad of [
    claim({ recordedRevision: -1 }), claim({ digest: 'xyz' }), claim({ attemptId: '../etc' }),
    claim({ authorization: { ...fingerprint, digest: 'cd'.repeat(32) } }),
    claim({ authorization: { ...fingerprint, consentSigner: fingerprint.approvalSigner } }),
    claim({ envelope: { ...conversionEnvelope, value: '-1' } }),
  ]) assert.throws(() => store.recordAttempt(bad));
  const reader = new AttemptLineageReader(file); t.after(() => reader.close());
  assert.deepEqual(reader.attempts(base, 'conversion'), []);
});
