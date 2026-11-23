// Regression tests for the P10.3 security review of PR #5 (blockers 1 and 2, REPLACE hardening).
// Every refusal asserts its specific reason, and table contents are compared before and after.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { cngn, reactor } from '../src/invoice.ts';

const digest = 'ab'.repeat(32);
const key = { tenantId: 'tenant-a', invoiceId: 'invoice-a', digest };
const fp = { digest, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 };
const env = { conversion: envelopeOf({ chainId: 42220, to: reactor, data: '0x1234', value: '0' }),
  payout: envelopeOf({ chainId: 42220, to: cngn, data: '0xa9059cbb', value: '0' }) };
const h = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(32);

function setup(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-review-'));
  const file = join(dir, 'lineage.db');
  const store = new AttemptLineageStore(file);
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  t.after(() => { raw.close(); store.close_db(); rmSync(dir, { recursive: true, force: true }); });
  const snapshot = () => JSON.stringify([raw.prepare('SELECT * FROM attempts ORDER BY attempt_id').all(),
    raw.prepare('SELECT * FROM attempt_events ORDER BY seq').all()]);
  return { file, store, raw, snapshot };
}
const claim = (op: 'conversion' | 'payout', id: string, patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: id, ...key, recordedRevision: 3, operation: op, createdAtMs: 1_000_000, authorization: fp, envelope: env[op], ...patch,
});
function finalize(store: AttemptLineageStore, id: string, hash: string) {
  store.recordHash(id, hash, 1_000_100);
  store.appendVerification(id, 1_000_200, 'verified-final', 'transaction-verifier');
  store.close(id, 'verified-final', 1_000_300, 'ops-reviewer');
}
const rawInsert = (verb: string, id: string, op: string, hash: string | null = null, tenant = key.tenantId, invoice = key.invoiceId) =>
  `${verb} INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms, authorization,
   envelope, hash, dispatch, closed) VALUES ('${id}', '${tenant}', '${invoice}', '${digest}', 4, 'recorded', '${op}', 1000001,
   '${JSON.stringify(fp)}', '${JSON.stringify(env.payout)}', ${hash ? `'${hash}'` : 'NULL'}, 'claimed', NULL)`;

// ------------------------------------------------------------------ blocker 1: verified-final is terminal

for (const op of ['payout', 'conversion'] as const) {
  test(`a verified-final ${op} is terminal: a second ${op} with a fresh id is refused (store and raw SQL)`, t => {
    const { store, raw, snapshot, file } = setup(t);
    store.recordAttempt(claim(op, op + '-1'));
    finalize(store, op + '-1', h(1));
    const before = snapshot();
    assert.throws(() => store.recordAttempt(claim(op, op + '-2', { recordedRevision: 9 })), /this operation is already finalized/);
    for (const verb of ['INSERT', 'INSERT OR REPLACE', 'REPLACE', 'INSERT OR IGNORE', 'INSERT OR ROLLBACK', 'INSERT OR FAIL']) {
      assert.throws(() => raw.exec(rawInsert(verb, op + '-raw', op)), /open or finalized/, verb);
    }
    assert.equal(snapshot(), before, 'rows and history unchanged');
    const reader = new AttemptLineageReader(file); t.after(() => reader.close());
    assert.deepEqual(reader.attempts(key, op).map(a => [a.id, a.closed]), [[op + '-1', 'verified-final']]);
  });
}

test('the other operation and other invoices/tenants are unaffected by a final attempt', t => {
  const { store } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  finalize(store, 'pay-1', h(1));
  assert.equal(store.recordAttempt(claim('conversion', 'conv-1')), 'created');
  assert.equal(store.recordAttempt(claim('payout', 'pay-b', { tenantId: 'tenant-b' })), 'created');
  assert.equal(store.recordAttempt(claim('payout', 'pay-y', { invoiceId: 'invoice-y' })), 'created');
});

// ------------------------------------------------------------------ blocker 2: reconciliation closure needs evidence

test('reconciled-not-landed closure is disabled in the store and in SQLite, for any operator claim', t => {
  const { store, raw, snapshot } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  const before = snapshot();
  for (const by of ['ops-reviewer', 'admin', 'root', '']) {
    assert.throws(() => store.close('pay-1', 'reconciled-not-landed', 1_000_100, by), /disabled until authoritative reconciliation exists/);
  }
  for (const sql of ["UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'pay-1'",
    "UPDATE OR REPLACE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'pay-1'"]) {
    assert.throws(() => raw.exec(sql), /disabled until authoritative reconciliation exists/, sql);
  }
  assert.throws(() => raw.exec(rawInsert('INSERT', 'pay-x', 'payout').replace(/'claimed', NULL\)$/, "'claimed', 'reconciled-not-landed')")),
    /open or finalized|recorded open/);
  assert.equal(snapshot(), before);
  // The open attempt keeps blocking a new one.
  assert.throws(() => store.recordAttempt(claim('payout', 'pay-2')), /already open/);
});

test('verified-final closure needs a recorded hash and an independent verified-final verification of that attempt', t => {
  const { store, raw, snapshot } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  store.recordAttempt(claim('conversion', 'conv-1'));
  assert.throws(() => store.close('pay-1', 'verified-final', 1_000_100, 'ops-reviewer'), /requires a recorded transaction hash/);
  assert.throws(() => raw.exec("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'pay-1'"), /requires a recorded transaction hash/);
  store.recordHash('pay-1', h(1), 1_000_100);
  for (const result of ['mismatch', 'not-found', 'not-final'] as const) store.appendVerification('pay-1', 1_000_150, result, 'transaction-verifier');
  // A verified-final event on a *different* attempt does not count.
  store.recordHash('conv-1', h(2), 1_000_160);
  store.appendVerification('conv-1', 1_000_170, 'verified-final', 'transaction-verifier');
  const before = snapshot();
  assert.throws(() => store.close('pay-1', 'verified-final', 1_000_200, 'ops-reviewer'), /independent verified-final verification/);
  assert.throws(() => store.close('pay-1', 'verified-final', 1_000_200, ''), /accountable operator/);
  assert.equal(snapshot(), before);
});

// ------------------------------------------------------------------ unknown and hashless attempts keep blocking

test('claimed-only and outcome-unknown attempts block every new attempt for the operation', t => {
  const { store, raw } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  assert.throws(() => store.recordAttempt(claim('payout', 'pay-2')), /already open/);
  store.recordOutcomeUnknown('pay-1', 1_000_100, 'wallet returned no hash');
  assert.throws(() => store.recordAttempt(claim('payout', 'pay-2')), /already open/);
  assert.throws(() => raw.exec(rawInsert('INSERT OR REPLACE', 'pay-2', 'payout')), /open or finalized/);
  // Legacy, unresolved attempts block too.
  store.importLegacy('tenant-a', { digest, invoiceId: 'invoice-l', swapId: 'legacy-swap' }, 1_000_000);
  assert.throws(() => store.recordAttempt(claim('conversion', 'conv-l', { invoiceId: 'invoice-l' })), /already open/);
});

// ------------------------------------------------------------------ REPLACE hardening on the real schema

test('INSERT OR REPLACE with a different id cannot displace a row through the operation key or the hash', t => {
  const { store, raw, snapshot } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  store.recordHash('pay-1', h(7), 1_000_100);
  // The other tenant's operation is free, but its hash collides with pay-1.
  const before = snapshot();
  assert.throws(() => raw.exec(rawInsert('INSERT OR REPLACE', 'pay-evil', 'payout', h(7), 'tenant-b')), /already belongs to another attempt/);
  assert.throws(() => raw.exec(rawInsert('INSERT OR REPLACE', 'pay-evil', 'payout', null)), /open or finalized/);
  assert.equal(snapshot(), before);
  // UPDATE OR REPLACE on another row's hash is refused too (it would otherwise delete pay-1).
  store.recordAttempt(claim('payout', 'pay-b', { tenantId: 'tenant-b' }));
  const before2 = snapshot();
  assert.throws(() => raw.exec(`UPDATE OR REPLACE attempts SET hash = '${h(7)}' WHERE attempt_id = 'pay-b'`), /already belongs to another attempt/);
  assert.equal(snapshot(), before2);
});

test('event history is immutable, including REPLACE on an existing sequence number', t => {
  const { store, raw, snapshot } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  store.recordHash('pay-1', h(1), 1_000_100);
  const before = snapshot();
  for (const sql of ["UPDATE attempt_events SET kind = 'legacy-import'", 'DELETE FROM attempt_events',
    "INSERT OR REPLACE INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (1, 'pay-1', 'legacy-import', 1, '{}')",
    "REPLACE INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (2, 'pay-1', 'closed', 1, '{}')"]) {
    assert.throws(() => raw.exec(sql), /append-only/, sql);
  }
  assert.throws(() => raw.exec("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('no-such-attempt', 'closed', 1, '{}')"), /FOREIGN KEY/);
  assert.equal(snapshot(), before);
});

test('concurrent writers on one file: exactly one attempt per key, before and after finality', t => {
  const { store, file } = setup(t);
  const second = new AttemptLineageStore(file); t.after(() => second.close_db());
  const outcome = [store, second].map((s, n) => { try { return s.recordAttempt(claim('payout', 'race-' + n)); } catch (e) { return (e as Error).message; } });
  assert.deepEqual(outcome.filter(o => o === 'created').length, 1);
  assert.match(String(outcome.find(o => o !== 'created')), /already open/);
  const winner = outcome[0] === 'created' ? 'race-0' : 'race-1';
  finalize(store, winner, h(9));
  // A writer holding an immediate transaction excludes the other; after it commits the operation is final.
  second.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => store.recordAttempt(claim('payout', 'race-2')), /locked|busy/i);
  second.db.exec('ROLLBACK');
  for (const s of [store, second]) assert.throws(() => s.recordAttempt(claim('payout', 'race-3')), /already finalized/);
});
