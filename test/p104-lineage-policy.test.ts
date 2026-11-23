// P10.4 lineage policy on the real node:sqlite store and schema:
//  A7 – finality and open attempts are per invoice operation across commitments (a new digest cannot pay again);
//  C3 – 'verified-final' can only be recorded from attested, attempt-bound, canonical and finalized evidence.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { attest } from '../src/evidence-attestation.ts';
import { LINEAGE_SCHEMA_STATEMENTS } from '../src/lineage-schema.ts';
import { cngn, reactor } from '../src/invoice.ts';
import { attestedEvidenceFor, verifyFinal } from './lineage-fixtures.ts';

const d1 = 'ab'.repeat(32), d2 = 'cd'.repeat(32);
const fp = (digest: string) => ({ digest, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 });
const env = { conversion: envelopeOf({ chainId: 42220, to: reactor, data: '0x12', value: '0' }), payout: envelopeOf({ chainId: 42220, to: cngn, data: '0x34', value: '0' }) };
const claim = (op: 'conversion' | 'payout', id: string, digest = d1, patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: id, tenantId: 'tenant-a', invoiceId: 'invoice-a', digest, recordedRevision: 2, operation: op, createdAtMs: 1_000_000,
  authorization: fp(digest), envelope: env[op], ...patch,
});
function setup(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-p104-'));
  const file = join(dir, 'l.db');
  const store = new AttemptLineageStore(file);
  const raw = new DatabaseSync(file);
  t.after(() => { raw.close(); store.close_db(); rmSync(dir, { recursive: true, force: true }); });
  const snap = () => JSON.stringify([raw.prepare('SELECT * FROM attempts ORDER BY attempt_id').all(), raw.prepare('SELECT * FROM attempt_events ORDER BY seq').all()]);
  return { store, raw, snap };
}

test('schema module: every statement is idempotent and applies cleanly twice', () => {
  const db = new DatabaseSync(':memory:');
  for (let n = 0; n < 2; n++) for (const s of LINEAGE_SCHEMA_STATEMENTS) db.exec(s);
  assert(LINEAGE_SCHEMA_STATEMENTS.every(s => /IF NOT EXISTS/.test(s)));
  assert(LINEAGE_SCHEMA_STATEMENTS.some(s => s.includes('invoice_operation_open_or_final')));
  db.close();
});

for (const op of ['payout', 'conversion'] as const) {
  test(`A7: a finalized ${op} cannot be attempted again under a new commitment digest`, t => {
    const { store, raw, snap } = setup(t);
    store.recordAttempt(claim(op, op + '-1'));
    store.recordHash(op + '-1', '0x' + (op === 'payout' ? '11' : '12').repeat(32), 1_000_100);
    verifyFinal(store, op + '-1', 1_000_200);
    store.close(op + '-1', 'verified-final', 1_000_300, 'ops-reviewer');
    const before = snap();
    assert.throws(() => store.recordAttempt(claim(op, op + '-2', d2)), /this operation is already finalized/);
    assert.throws(() => raw.exec(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms,
      authorization, envelope, hash, dispatch, closed) VALUES ('${op}-raw', 'tenant-a', 'invoice-a', '${d2}', 3, 'recorded', '${op}', 1, '{}', '{}', NULL, 'claimed', NULL)`),
      /open or finalized/);
    assert.equal(snap(), before);
  });
}

test('A7: an open attempt under one commitment also blocks the same operation under another', t => {
  const { store } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  assert.throws(() => store.recordAttempt(claim('payout', 'pay-2', d2)), /already open/);
  // A different invoice or tenant is unaffected.
  assert.equal(store.recordAttempt(claim('payout', 'pay-x', d2, { invoiceId: 'invoice-b' })), 'created');
  assert.equal(store.recordAttempt(claim('payout', 'pay-y', d2, { tenantId: 'tenant-b' })), 'created');
});

test('C3: a caller-named verifier cannot record verified-final; only attested evidence for this attempt can', t => {
  const { store, raw, snap } = setup(t);
  store.recordAttempt(claim('payout', 'pay-1'));
  store.recordAttempt(claim('conversion', 'conv-1'));
  store.recordHash('pay-1', '0x' + '11'.repeat(32), 1_000_100);
  store.recordHash('conv-1', '0x' + '12'.repeat(32), 1_000_110);
  const before = snap();
  for (const verifier of ['transaction-verifier', 'attested-evidence', 'chainlink', 'ops'])
    assert.throws(() => store.appendVerification('pay-1', 1_000_200, 'verified-final' as 'mismatch', verifier), /only be recorded from attested evidence/);
  const { tx, canonical } = attestedEvidenceFor(store, 'pay-1');
  const plain = <T>(v: T) => JSON.parse(JSON.stringify(v)) as T;
  assert.throws(() => store.recordVerifiedFinal('pay-1', plain(tx), canonical, 1_000_200), /requires attested evidence/);
  assert.throws(() => store.recordVerifiedFinal('pay-1', tx, plain(canonical), 1_000_200), /requires attested evidence/);
  // Attested, but for another attempt / revision / commitment.
  const conv = attestedEvidenceFor(store, 'conv-1');
  assert.throws(() => store.recordVerifiedFinal('pay-1', conv.tx, conv.canonical, 1_000_200), /does not belong to this attempt/);
  for (const patch of [{ revision: 9 }, { digest: d2 }, { tenantId: 'tenant-b' }, { success: false }]) {
    assert.throws(() => store.recordVerifiedFinal('pay-1', attest({ ...tx, ...patch }), canonical, 1_000_200), /does not belong to this attempt/, JSON.stringify(patch));
  }
  // Attested, but not canonical or not finalized.
  for (const patch of [{ blockHash: '0x' + '99'.repeat(32) }, { finalizedBlockNumber: '99' }, { chainId: 1 }]) {
    assert.throws(() => store.recordVerifiedFinal('pay-1', tx, attest({ ...canonical, ...patch }), 1_000_200), /not canonical and finalized/, JSON.stringify(patch));
  }
  // A raw event that claims verified-final without the attested-evidence marker cannot close the attempt.
  raw.exec(`INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('conv-1', 'verification', 1,
    '${JSON.stringify({ result: 'verified-final', verifier: 'ops', hash: '0x' + '12'.repeat(32) })}')`);
  assert.throws(() => raw.exec("UPDATE attempts SET closed = 'verified-final' WHERE attempt_id = 'conv-1'"), /latest independent verdict/);
  assert.notEqual(snap(), before); // only the raw event row was appended
  store.recordVerifiedFinal('pay-1', tx, canonical, 1_000_300);
  store.close('pay-1', 'verified-final', 1_000_400, 'ops-reviewer');
});
