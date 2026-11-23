// P10.5 L1–L4: claim-time lineage in an isolated test environment (simulated dispatch only).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { ClaimCoordinator, simulatedDispatcher, type ClaimRequest } from '../src/claim-coordinator.ts';
import { cngn } from '../src/invoice-core.ts';
import { verifyFinal } from './lineage-fixtures.ts';

const digest = 'ab'.repeat(32);
const sender = '0x' + '33'.repeat(20);
const fp = { digest, approvalSigner: '0x' + '44'.repeat(20), consentSigner: '0x' + '22'.repeat(20), expiresAtMs: 9_000_000 };
function req(o: { id?: string; invoiceId?: string; tenantId?: string; nonce?: number; data?: string; op?: 'payout' | 'conversion' } = {}): ClaimRequest {
  const data = o.data ?? '0xa9059cbb' + (o.invoiceId ?? 'invoice-a').length.toString(16).padStart(2, '0');
  const attempt: NewAttempt = { attemptId: o.id ?? 'pay-1', tenantId: o.tenantId ?? 'tenant-a', invoiceId: o.invoiceId ?? 'invoice-a', digest, recordedRevision: 3,
    operation: o.op ?? 'payout', createdAtMs: 1_000_000, authorization: fp, envelope: envelopeOf({ chainId: 42220, to: cngn, data, value: '0' }) };
  return { attempt, reservation: { chainId: 42220, sender, nonce: o.nonce ?? 7 }, tx: { chainId: 42220, to: cngn, data, value: '0', sender, nonce: o.nonce ?? 7 } };
}
function setup(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-claim-'));
  const file = join(dir, 'l.db');
  const store = new AttemptLineageStore(file);
  t.after(() => { store.close_db(); rmSync(dir, { recursive: true, force: true }); });
  const rows = (op: 'payout' | 'conversion' = 'payout', inv = 'invoice-a') => { const r = new AttemptLineageReader(file); try { return r.attempts({ tenantId: 'tenant-a', invoiceId: inv, digest }, op); } finally { r.close(); } };
  return { file, store, rows };
}
const clock = () => 1_000_500;

test('L1: the claim is persisted before dispatch; dispatch sees the attempt and its nonce reservation on disk', async t => {
  const { file, store, rows } = setup(t);
  let observed: unknown;
  const dispatcher = simulatedDispatcher();
  const spy = { kind: 'simulated' as const, async dispatch(tx: Parameters<typeof dispatcher.dispatch>[0]) {
    const db = new DatabaseSync(file, { readOnly: true });
    observed = { attempt: db.prepare("SELECT dispatch, hash FROM attempts WHERE attempt_id = 'pay-1'").get(), nonce: db.prepare('SELECT nonce, attempt_id FROM taker_nonces').get() };
    db.close();
    return dispatcher.dispatch(tx);
  } };
  const out = await new ClaimCoordinator(store, spy, { clock }).claimAndDispatch(req());
  assert.equal(out.outcome, 'hash-recorded');
  assert.deepEqual(JSON.parse(JSON.stringify(observed)), { attempt: { dispatch: 'claimed', hash: null }, nonce: { nonce: 7, attempt_id: 'pay-1' } });
  assert.equal(rows()[0].dispatch, 'hash-recorded');
});

for (const point of ['afterClaim', 'afterDispatch'] as const) {
  test(`L1: a crash ${point} leaves a retained, blocking attempt and no retry`, async t => {
    const { file, store, rows } = setup(t);
    const d = simulatedDispatcher();
    await assert.rejects(new ClaimCoordinator(store, d, { clock, [point]: () => { throw Error('simulated process crash'); } }).claimAndDispatch(req()), /simulated process crash/);
    // A restarted process sees the claim and refuses to dispatch again (same id or a fresh id).
    const restarted = new AttemptLineageStore(file); t.after(() => restarted.close_db());
    const d2 = simulatedDispatcher();
    const c2 = new ClaimCoordinator(restarted, d2, { clock });
    assert.deepEqual(await c2.claimAndDispatch(req()), { outcome: 'refused', reason: 'attempt already claimed; no retry' });
    const fresh = await c2.claimAndDispatch(req({ id: 'pay-2', nonce: 8 }));
    assert.equal(fresh.outcome, 'refused');
    assert.match((fresh as { reason: string }).reason, /already open/);
    assert.equal(d2.calls.length, 0);
    assert.equal(d.calls.length, point === 'afterClaim' ? 0 : 1);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].hash, null); // the hash was never recorded: outcome unknown, held for reconciliation
  });
}

test('L2: concurrent claims for the same invoice operation produce exactly one dispatch', async t => {
  const { file, store } = setup(t);
  const others = Array.from({ length: 5 }, () => new AttemptLineageStore(file));
  t.after(() => others.forEach(s => s.close_db()));
  const d = simulatedDispatcher();
  const results = await Promise.all([store, ...others].map((s, n) => new ClaimCoordinator(s, d, { clock }).claimAndDispatch(req({ id: 'race-' + n, nonce: 100 + n }))));
  assert.equal(results.filter(r => r.outcome === 'hash-recorded').length, 1);
  assert.equal(d.calls.length, 1);
  assert(results.filter(r => r.outcome === 'refused').every(r => /already open/.test((r as { reason: string }).reason)));
});

test('L3: a taker nonce reserved by one invoice cannot be reused by another invoice or tenant; nothing is written', async t => {
  const { store, rows } = setup(t);
  const d = simulatedDispatcher();
  const c = new ClaimCoordinator(store, d, { clock });
  assert.equal((await c.claimAndDispatch(req({ id: 'pay-a', invoiceId: 'invoice-a', nonce: 42 }))).outcome, 'hash-recorded');
  for (const other of [req({ id: 'pay-b', invoiceId: 'invoice-b', nonce: 42 }), req({ id: 'pay-c', invoiceId: 'invoice-c', tenantId: 'tenant-b', nonce: 42 }),
    req({ id: 'conv-a', invoiceId: 'invoice-a', op: 'conversion', nonce: 42 })]) {
    const out = await c.claimAndDispatch(other);
    assert.deepEqual(out, { outcome: 'refused', reason: 'taker nonce already reserved' }, other.attempt.attemptId);
  }
  assert.equal(d.calls.length, 1);
  assert.equal(rows('payout', 'invoice-b').length, 0, 'the refused attempt was rolled back with its reservation');
  assert.throws(() => store.db.exec("UPDATE taker_nonces SET nonce = 43"), /immutable/);
  assert.throws(() => store.db.exec("DELETE FROM taker_nonces"), /immutable/);
  assert.throws(() => store.db.exec(`INSERT OR REPLACE INTO taker_nonces VALUES (42220, '${sender}', 42, 'pay-x', 1)`), /already reserved/);
});

test('L4: an unknown outcome (no hash, or a dispatch failure) is recorded and never retried', async t => {
  for (const mode of ['no-hash', 'throw'] as const) {
    const { store, rows } = setup(t);
    const d = simulatedDispatcher(() => mode);
    const c = new ClaimCoordinator(store, d, { clock });
    assert.deepEqual(await c.claimAndDispatch(req()), { outcome: 'outcome-unknown', attemptId: 'pay-1' });
    assert.equal(rows()[0].dispatch, 'outcome-unknown');
    assert.equal(rows()[0].hash, null);
    const again = await new ClaimCoordinator(store, simulatedDispatcher(), { clock }).claimAndDispatch(req({ id: 'pay-2', nonce: 9 }));
    assert.equal(again.outcome, 'refused', mode);
    assert.equal(d.calls.length, 1);
  }
});

test('L4: after a finalized payout no further payout can be claimed, under any nonce or commitment', async t => {
  const { store } = setup(t);
  const c = new ClaimCoordinator(store, simulatedDispatcher(), { clock });
  const first = await c.claimAndDispatch(req());
  assert.equal(first.outcome, 'hash-recorded');
  verifyFinal(store, 'pay-1', 1_000_600);
  store.close('pay-1', 'verified-final', 1_000_700, 'ops-reviewer');
  const d = simulatedDispatcher();
  const second = await new ClaimCoordinator(store, d, { clock }).claimAndDispatch(req({ id: 'pay-2', nonce: 99 }));
  assert.deepEqual(second, { outcome: 'refused', reason: 'this operation is already finalized' });
  assert.equal(d.calls.length, 0);
});

test('guards: only a simulated dispatcher is accepted; mismatched transactions and failing preflight are refused before any write', async t => {
  const { store, rows } = setup(t);
  for (const bad of [{ kind: 'metamask', dispatch: async () => '0x' }, { dispatch: async () => '0x' }, null, { kind: 'simulated' }])
    assert.throws(() => new ClaimCoordinator(store, bad as never, { clock }), /only a simulated dispatcher/);
  const d = simulatedDispatcher();
  const c = new ClaimCoordinator(store, d, { clock, preflight: () => { throw Error('insufficient allowance'); } });
  assert.deepEqual(await c.claimAndDispatch(req()), { outcome: 'refused', reason: 'preflight: insufficient allowance' });
  const c2 = new ClaimCoordinator(store, d, { clock });
  const r = req();
  for (const tx of [{ ...r.tx, nonce: 8 }, { ...r.tx, data: '0xdeadbeef' }, { ...r.tx, to: '0x' + '99'.repeat(20) }, { ...r.tx, sender: '0x' + '55'.repeat(20) }]) {
    const out = await c2.claimAndDispatch({ ...r, tx });
    assert.equal(out.outcome, 'refused');
    assert.match((out as { reason: string }).reason, /does not match/);
  }
  assert.equal(d.calls.length, 0);
  assert.equal(rows().length, 0);
});
