// M1: one durable journal, no money. Every "restart" below closes the journal and opens a new one on the same file,
// with new objects and a new reader, so nothing survives except what SQLite persisted. All chain data is a
// deterministic fixture: no network, no wallet, no signer, no transaction.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeAbiParameters, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AttemptLineageStore } from '../src/attempt-lineage.ts';
import { authorizationMessage } from '../src/authorization.ts';
import { cngn, chain, commit, reactor, usdt } from '../src/invoice.ts';
import { deriveState, ObligationJournal, type AttemptSummary } from '../src/obligation-journal.ts';
import { reviewConversion } from '../src/settlement-review.ts';
import { fillerAbi, orderAbi, preferredFiller, reactorAbi } from '../src/textile.ts';
import { feeLimits, origin, readFixture, transactionHash } from './rpc-fixture.ts';

const addr = (digit: string) => ('0x' + digit.repeat(40)) as Hex;
const key = (digit: string) => ('0x' + digit.repeat(64)) as Hex;
const approver = privateKeyToAccount(key('1')), recipient = privateKeyToAccount(key('2'));
const taker = addr('3'), maker = addr('4'), payoutHash = key('5');
const now = 1_800_000_000_000, debit = 1_001_000n, target = 1_500_000_000n;
const terms = { id: 'm1-obligation', version: 1, nonce: '1'.repeat(32), source: 'fixture', chain, sell: usdt, buy: cngn,
  sellDecimals: 6, buyDecimals: 6, buyAmount: String(target), maxSell: '1100000', approver: approver.address,
  recipient: recipient.address, taker, expires: now + 600_000 };
const { invoice, digest } = commit(terms);
const policy = { code: 'celo_daidai_fixture', swap: feeLimits, payout: feeLimits };
const iso = (delta: number) => new Date(now + delta).toISOString();

function quote() {
  const deadline = BigInt(now + 45_000) / 1000n;
  const order = encodeAbiParameters(orderAbi, [{ info: { reactor, swapper: maker, nonce: 1n, deadline, validator: preferredFiller,
    validation: encodeAbiParameters(fillerAbi, [[taker], deadline]) },
  input: { token: cngn, amount: target, maxAmount: target }, outputs: [{ token: usdt, amount: 1_000_000n, recipient: maker }] }]);
  return { data: { status: 'quoted', quote: { taker: taker as string, reactor, buyAmount: String(target), takerPays: String(debit),
    feeAmount: '1000', expiresAt: iso(40_000), orderDeadline: iso(45_000), latestOrderDeadline: iso(45_000) },
    transactions: {
      approval: { chainId: chain, to: usdt, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [reactor, debit] }) },
      swap: { chainId: chain, to: reactor, value: '0', data: encodeFunctionData({ abi: reactorAbi, functionName: 'execute', args: [{ order, sig: '0xabcd' }] }) },
    } } };
}

async function world(t: { after: (f: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-m1-'));
  const file = join(dir, 'journal.db');
  const open: ObligationJournal[] = [];
  const clock = { at: now };
  const journalOpen = () => { const j = new ObligationJournal(file, { clock: () => clock.at }); open.push(j); return j; };
  t.after(() => { for (const j of open) { try { j.close(); } catch { /* already closed */ } } rmSync(dir, { recursive: true, force: true }); });
  const signatures = {
    approval: await approver.signTypedData(authorizationMessage(invoice, digest, 'invoice approval', origin)),
    consent: await recipient.signTypedData(authorizationMessage(invoice, digest, 'recipient consent', origin)),
  };
  // A fresh chain fixture per "process": the only link between processes is the file and the shared (fixture) chain state.
  const chainState = readFixture(taker, maker, target, debit);
  const funds = () => ({ chain, wallet: taker, sellToken: usdt, buyToken: cngn, spender: reactor, observedAt: clock.at,
    allowance: debit, usdt: 1_100_000n, cngn: target, native: 2n * feeLimits.totalWei });
  const ports = () => ({ clock: () => clock.at, balances: async () => funds(), reader: chainState.reader });
  return { file, journalOpen, signatures, chainState, ports, clock };
}
const ctx = (w: Awaited<ReturnType<typeof world>>) => ({ rpc: w.chainState.rpc, attributionCode: policy.code });

async function reviewedConversion(w: Awaited<ReturnType<typeof world>>, j: ObligationJournal) {
  await j.importAgreement({ tenantId: 'tenant-a', invoice, origin, signatures: w.signatures });
  const proofPorts = w.ports();
  // The review needs the authorization certificate; rebuild it exactly as the journal does.
  const { verifyAuthorization } = await import('../src/authorization.ts');
  const proof = await verifyAuthorization(invoice, digest, origin, w.signatures, w.clock.at);
  const review = await reviewConversion(invoice, proof, quote().data ? quote() : quote(), proofPorts, policy);
  assert.equal(review.kind, 'review');
  if (review.kind !== 'review') throw Error('no review');
  return review.candidate;
}

test('M1-1: import binds one stable invoice id to one commitment; terms can never change', async t => {
  const w = await world(t); const j = w.journalOpen();
  const first = await j.importAgreement({ tenantId: 'tenant-a', invoice, origin, signatures: w.signatures });
  assert.equal(first.created, true);
  assert.deepEqual(j.inspect(invoice.id).state, 'AUTHORISED');
  assert.equal((await j.importAgreement({ tenantId: 'tenant-a', invoice, origin, signatures: w.signatures })).created, false);
  const v2 = { ...terms, version: 2, buyAmount: String(target + 1n) };
  const { invoice: i2, digest: d2 } = commit(v2);
  const sigs2 = {
    approval: await approver.signTypedData(authorizationMessage(i2, d2, 'invoice approval', origin)),
    consent: await recipient.signTypedData(authorizationMessage(i2, d2, 'recipient consent', origin)),
  };
  await assert.rejects(j.importAgreement({ tenantId: 'tenant-a', invoice: i2, origin, signatures: sigs2 }), /different commitment/);
  await assert.rejects(j.importAgreement({ tenantId: 'tenant-b', invoice, origin, signatures: w.signatures }), /different commitment/);
  assert.throws(() => j.db.exec("UPDATE obligations SET digest = '" + 'a'.repeat(64) + "'"), /immutable/);
  assert.throws(() => j.db.exec('DELETE FROM obligations'), /retained/);
  // Wrong signer / swapped roles are refused at import.
  const { invoice: i3, digest: d3 } = commit({ ...terms, id: 'm1-other', nonce: '2'.repeat(32) });
  await assert.rejects(j.importAgreement({ tenantId: 'tenant-a', invoice: i3, origin, signatures: {
    approval: await recipient.signTypedData(authorizationMessage(i3, d3, 'invoice approval', origin)),
    consent: await approver.signTypedData(authorizationMessage(i3, d3, 'recipient consent', origin)) } }), /invalid approval or consent signature/);
});

test('M1-2: the claim commits attempt, nonce and exact calldata atomically; a failed claim leaves nothing behind', async t => {
  const w = await world(t); const j = w.journalOpen();
  const candidate = await reviewedConversion(w, j);
  assert.equal(j.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate }), 'created');
  const row = j.db.prepare('SELECT tx_data, tx_to, action FROM reviewed_envelopes WHERE attempt_id = ?').get('conv-1') as { tx_data: string; tx_to: string; action: string };
  assert.equal(row.tx_data, candidate.tx.data);
  assert.equal(row.action, 'swap');
  assert.equal(Number((j.db.prepare('SELECT count(*) AS n FROM taker_nonces').get() as { n: number }).n), 1);
  // Repeating a claim that is already open is refused outright (the store alone would answer 'existing'); either way
  // nothing is dispatched twice. The journal chooses the stricter contract: the caller must inspect, not re-claim.
  assert.throws(() => j.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate }), /not permitted in state CONVERSION_CLAIMED/);
  assert.throws(() => j.db.exec("UPDATE reviewed_envelopes SET tx_data = '0x00'"), /immutable/);
  assert.throws(() => j.db.exec('DELETE FROM reviewed_envelopes'), /retained/);
  // Store level: a failure inside the same transaction rolls back the attempt and the nonce together.
  const dir2 = mkdtempSync(join(tmpdir(), 'daidai-m1-atomic-')); t.after(() => rmSync(dir2, { recursive: true, force: true }));
  const store = new AttemptLineageStore(join(dir2, 'a.db')); t.after(() => store.close_db());
  const base = { attemptId: 'x-1', tenantId: 'tenant-a', invoiceId: 'inv-x', digest, recordedRevision: 1, operation: 'conversion' as const, createdAtMs: now,
    authorization: { digest, approvalSigner: addr('a'), consentSigner: addr('b'), expiresAtMs: now + 1 }, envelope: { chainId: 42220, to: reactor, dataSha256: 'c'.repeat(64), value: '0' } };
  assert.throws(() => store.recordAttempt(base, { chainId: 42220, sender: taker, nonce: 9 }, () => { throw Error('envelope write failed'); }), /envelope write failed/);
  assert.equal(Number((store.db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n), 0);
  assert.equal(Number((store.db.prepare('SELECT count(*) AS n FROM taker_nonces').get() as { n: number }).n), 0);
});

test('M1-3: only a reviewed, simulated envelope for the right operation and state can be claimed', async t => {
  const w = await world(t); const j = w.journalOpen();
  const candidate = await reviewedConversion(w, j);
  assert.throws(() => j.claim(invoice.id, 'conversion', { attemptId: 'forged-1', candidate: { ...candidate } }), /reviewed and simulated/);
  assert.throws(() => j.claim(invoice.id, 'payout', { attemptId: 'wrong-op', candidate }), /does not match the operation/);
  assert.throws(() => j.claim(invoice.id, 'conversion', { attemptId: 'late-1', candidate, notAfterMs: now }), /expired/);
  assert.equal(j.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate }), 'created');
  assert.throws(() => j.claim(invoice.id, 'conversion', { attemptId: 'conv-2', candidate }), /not permitted in state CONVERSION_CLAIMED/);
  assert.equal(j.inspect(invoice.id).state, 'CONVERSION_CLAIMED');
});

test('M1-4: a crash after the claim leaves a retained blocking claim; a fresh process cannot resend or replace it', async t => {
  const w = await world(t); const a = w.journalOpen();
  const candidate = await reviewedConversion(w, a);
  a.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate });
  a.close(); // simulated process crash before any hash was recorded
  const b = w.journalOpen();
  const seen = b.inspect(invoice.id);
  assert.equal(seen.state, 'CONVERSION_CLAIMED');
  assert.equal(seen.nextAction, 'reconcile-conversion');
  assert.match(seen.reason, /do not resend/);
  assert.throws(() => b.claim(invoice.id, 'conversion', { attemptId: 'conv-2', candidate }), /not permitted/);
  assert.deepEqual(await b.resume(invoice.id, w.ports(), policy), { kind: 'not-resumable', state: 'CONVERSION_CLAIMED', nextAction: 'reconcile-conversion' });
  assert.deepEqual(await b.confirm(invoice.id, 'conversion', ctx(w)), { kind: 'blocked', reason: 'no transaction hash recorded; reconcile manually and do not resend' });
});

test('M1-5: unknown outcome blocks every action and is never retried or released', async t => {
  const w = await world(t); const a = w.journalOpen();
  const candidate = await reviewedConversion(w, a);
  a.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate });
  a.recordUnknown('conv-1', 'wallet window closed after handoff');
  a.close();
  const b = w.journalOpen();
  assert.equal(b.inspect(invoice.id).state, 'CONVERSION_UNKNOWN');
  assert.throws(() => b.claim(invoice.id, 'conversion', { attemptId: 'conv-2', candidate }), /not permitted/);
  assert.throws(() => b.db.prepare("UPDATE attempts SET closed = 'reconciled-not-landed' WHERE attempt_id = 'conv-1'").run(), /disabled/);
  assert.equal((await b.resume(invoice.id, w.ports(), policy)).kind, 'not-resumable');
});

test('M1-6: a recorded hash is verified in a fresh process; not-final is pending, never settled', async t => {
  const w = await world(t); const a = w.journalOpen();
  const candidate = await reviewedConversion(w, a);
  a.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate });
  a.recordHandoff('conv-1', transactionHash);
  a.close();
  const b = w.journalOpen();
  assert.equal(b.inspect(invoice.id).state, 'CONVERSION_PENDING');
  assert.equal((await b.confirm(invoice.id, 'conversion', ctx(w))).kind, 'unverified', 'no transaction on chain yet');
  w.chainState.mine(transactionHash, candidate.tx, taker);
  w.chainState.state.finalized = '0x1';
  assert.deepEqual(await b.confirm(invoice.id, 'conversion', ctx(w)), { kind: 'pending', reason: 'transaction found but its block is not yet finalized' });
  assert.equal(b.inspect(invoice.id).state, 'CONVERSION_PENDING');
  w.chainState.state.finalized = '0x3';
  const done = await b.confirm(invoice.id, 'conversion', ctx(w));
  assert.equal(done.kind, 'final');
  assert.equal(b.inspect(invoice.id).state, 'CONVERTED_UNPAID');
  assert.throws(() => b.db.prepare("UPDATE attempts SET dispatch = 'claimed' WHERE attempt_id = 'conv-1'").run(), /frozen/);
});

test('M1-7: provider disagreement or a wrong transaction never promotes a conversion', async t => {
  const w = await world(t); const j = w.journalOpen();
  const candidate = await reviewedConversion(w, j);
  j.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate });
  j.recordHandoff('conv-1', transactionHash);
  w.chainState.mine(transactionHash, candidate.tx, taker, target - 1n); // short credit
  assert.equal((await j.confirm(invoice.id, 'conversion', ctx(w))).kind, 'unverified');
  w.chainState.mine(transactionHash, candidate.tx, taker);
  const flaky = { ...ctx(w), rpc: async (m: string, p: readonly unknown[]) => { if (m === 'eth_getTransactionReceipt') throw Error('providers disagree'); return w.chainState.rpc(m, p); } };
  assert.equal((await j.confirm(invoice.id, 'conversion', flaky)).kind, 'unavailable');
  assert.equal(j.inspect(invoice.id).state, 'CONVERSION_PENDING');
  assert.notEqual(j.inspect(invoice.id).state, 'CONVERTED_UNPAID');
});

async function converted(w: Awaited<ReturnType<typeof world>>) {
  const a = w.journalOpen();
  const candidate = await reviewedConversion(w, a);
  a.claim(invoice.id, 'conversion', { attemptId: 'conv-1', candidate });
  a.recordHandoff('conv-1', transactionHash);
  w.chainState.mine(transactionHash, candidate.tx, taker);
  assert.equal((await a.confirm(invoice.id, 'conversion', ctx(w))).kind, 'final');
  w.chainState.state.nonce = '0x1'; // the conversion consumed nonce 0; the wallet's next nonce is now 1
  a.close(); // the application stops while the payout is still outstanding
  return candidate;
}

test('M1-8 (R08): after a restart, the journal re-verifies the conversion and offers only the payout, then settles', async t => {
  const w = await world(t);
  const candidate = await converted(w);
  const b = w.journalOpen();
  assert.deepEqual([b.inspect(invoice.id).state, b.inspect(invoice.id).nextAction], ['CONVERTED_UNPAID', 'prepare-payout']);
  assert.throws(() => b.claim(invoice.id, 'conversion', { attemptId: 'conv-again', candidate }), /not permitted in state CONVERTED_UNPAID/);
  w.chainState.calls.length = 0;
  w.chainState.state.payoutRecipient = invoice.recipient as Hex;
  const resumed = await b.resume(invoice.id, w.ports(), policy);
  assert.equal(resumed.kind, 'payout-review');
  if (resumed.kind !== 'payout-review') throw Error('no resume');
  assert.equal(resumed.candidate.action, 'payout');
  assert.equal(resumed.candidate.recipient, invoice.recipient);
  assert.equal(resumed.candidate.debit, 0n, 'a payout never debits USDt');
  assert(w.chainState.calls.includes('eth_getTransactionByHash'), 'the conversion was re-verified against the chain');
  assert.equal(w.chainState.calls.filter(m => m === 'eth_simulateV1').length, 1, 'only the payout was simulated; no conversion was prepared');
  assert(!w.chainState.calls.some(m => /send|sign/i.test(m)));
  // Payout is claimed, handed off, verified, and the obligation settles.
  assert.equal(b.claim(invoice.id, 'payout', { attemptId: 'pay-1', candidate: resumed.candidate }), 'created');
  assert.equal(b.inspect(invoice.id).state, 'PAYOUT_CLAIMED');
  b.recordHandoff('pay-1', payoutHash);
  w.chainState.mine(payoutHash, resumed.candidate.tx, invoice.recipient as Hex, target, '0x1');
  const settled = await b.confirm(invoice.id, 'payout', ctx(w));
  assert.equal(settled.kind, 'final');
  const finalState = b.inspect(invoice.id);
  assert.equal(finalState.state, 'SETTLED');
  assert.equal(finalState.nextAction, 'none');
  assert.notEqual(finalState.conversion?.hash, finalState.payout?.hash);
  assert.throws(() => b.claim(invoice.id, 'payout', { attemptId: 'pay-2', candidate: resumed.candidate }), /not permitted in state SETTLED/);
});

test('M1-9: resume refuses to offer a payout when the chain no longer confirms the recorded conversion', async t => {
  const w = await world(t);
  await converted(w);
  const b = w.journalOpen();
  w.chainState.receipts.clear(); // a reorg, or a provider that has lost the receipt
  const out = await b.resume(invoice.id, w.ports(), policy);
  assert.equal(out.kind, 'blocked');
  assert.equal(out.kind === 'blocked' && out.reason, 'conversion-not-reverified');
  assert.equal(b.inspect(invoice.id).state, 'CONVERTED_UNPAID', 'the journal is untouched; nothing was reset');
});

test('M1-10: an expired authorization after conversion blocks the payout and can never reopen the conversion', async t => {
  const w = await world(t);
  const candidate = await converted(w);
  const b = w.journalOpen();
  w.clock.at = invoice.expires + 1;
  const out = await b.resume(invoice.id, w.ports(), policy);
  assert.equal(out.kind === 'blocked' && out.reason, 'continuation-required');
  assert.throws(() => b.claim(invoice.id, 'payout', { attemptId: 'pay-late', candidate }), /expired|does not match/);
  assert.throws(() => b.claim(invoice.id, 'conversion', { attemptId: 'conv-late', candidate }), /expired|not permitted/);
  assert.equal(b.inspect(invoice.id).state, 'CONVERTED_UNPAID');
});

test('M1-11: tampered persisted calldata is detected and no payout is offered', async t => {
  const w = await world(t);
  await converted(w);
  const b = w.journalOpen();
  // A raw-SQL writer inside the trust boundary removes the immutability trigger and rewrites the envelope.
  b.db.exec('DROP TRIGGER reviewed_envelopes_immutable');
  b.db.exec("UPDATE reviewed_envelopes SET tx_data = '0xdeadbeef' WHERE attempt_id = 'conv-1'");
  const out = await b.resume(invoice.id, w.ports(), policy);
  assert.equal(out.kind === 'blocked' && out.reason, 'journal-inconsistent');
  assert.match(out.kind === 'blocked' ? out.detail : '', /calldata does not match/);
});

test('M1-12: the pure state function never offers a send while anything is unresolved', () => {
  const a = (o: Partial<AttemptSummary>): AttemptSummary => ({ id: 'x', dispatch: 'claimed', hash: null, closed: null, createdAtMs: 1, ...o });
  const dispatching = new Set(['prepare-conversion', 'prepare-payout']);
  const cases: [AttemptSummary | null, AttemptSummary | null][] = [
    [null, null], [a({}), null], [a({ dispatch: 'hash-recorded', hash: '0x1' }), null], [a({ dispatch: 'outcome-unknown' }), null],
    [a({ dispatch: 'hash-recorded', hash: '0x1', closed: 'verified-final' }), null],
    [a({ dispatch: 'hash-recorded', hash: '0x1', closed: 'verified-final' }), a({})],
    [a({ dispatch: 'hash-recorded', hash: '0x1', closed: 'verified-final' }), a({ dispatch: 'outcome-unknown' })],
    [a({ dispatch: 'hash-recorded', hash: '0x1', closed: 'verified-final' }), a({ dispatch: 'hash-recorded', hash: '0x2' })],
    [a({ dispatch: 'hash-recorded', hash: '0x1', closed: 'verified-final' }), a({ dispatch: 'hash-recorded', hash: '0x2', closed: 'verified-final' })],
    [null, a({})],
  ];
  const expected = ['AUTHORISED', 'CONVERSION_CLAIMED', 'CONVERSION_PENDING', 'CONVERSION_UNKNOWN', 'CONVERTED_UNPAID',
    'PAYOUT_CLAIMED', 'PAYOUT_UNKNOWN', 'PAYOUT_PENDING', 'SETTLED', 'RECONCILIATION_REQUIRED'];
  cases.forEach(([c, p], n) => {
    const s = deriveState(c, p);
    assert.equal(s.state, expected[n], `case ${n}`);
    const unresolved = s.state.endsWith('CLAIMED') || s.state.endsWith('UNKNOWN') || s.state.endsWith('PENDING') || s.state === 'RECONCILIATION_REQUIRED';
    if (unresolved) assert(!dispatching.has(s.nextAction), `state ${s.state} must never offer a dispatch`);
  });
});
