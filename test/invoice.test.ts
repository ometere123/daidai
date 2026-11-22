import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';
import { Spike, MockChain, commit, tag, verifyTag, chain, usdt, cngn, reactor, registry } from '../src/invoice.ts';

const code = process.env.DAIDAI_ATTRIBUTION_CODE ?? 'celo_daidai_fixture';
const taker = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000002';
const invoice = {
  id: 'fixture', version: 1, source: 'mock invoice', nonce: '0123456789abcdef0123456789abcdef',
  chain, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6, buyAmount: '1500000000',
  recipient, maxSell: '1200000', approver: taker, taker, expires: 1000,
};
const funds = { usdt: 1200000n, gas: 10n, allowance: 1200000n, swapGas: 6n, payoutGas: 4n, cngn: 1500000000n };
const approvalData = (spender: Hex) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 1100000n] });
const transferData = (payee: Hex) =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [payee, 1500000000n] });
const tx = (to: string, data: Hex) => ({ to, data, chainId: chain, value: '0' });
const batch = '0x12345678aabb' as const; // Opaque synthetic stand-in for complete Textile batch calldata.
const quote = {
  status: 'quoted' as const, chain, sell: usdt, buy: cngn, taker, buyAmount: invoice.buyAmount,
  takerPays: '1100000', feeAmount: '220', expiresAt: 100, orderDeadline: 110,
  transactions: { approval: tx(usdt, approvalData(reactor)), swap: tx(reactor, batch) },
};
const swapReceipt = {
  ok: true, finalized: true, chain, from: taker, to: taker, token: cngn,
  amount: invoice.buyAmount, debit: quote.takerPays,
};
const payoutTx = tx(cngn, tag(transferData(recipient), code));

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-'));
  const state = join(dir, 'state.db');
  const chainFile = join(dir, 'mock-chain.db');
  let wallet = new MockChain(chainFile);
  let app = new Spike(state, wallet, code);
  const { digest } = app.create(invoice);
  t.after(() => { app.close(); wallet.close(); rmSync(dir, { recursive: true }); });
  const approval = { digest, approver: taker };
  const consent = { digest, recipient, evidence: 'synthetic consent record' };
  return {
    get app() { return app; }, get wallet() { return wallet; }, approval, consent,
    restart() { app.close(); wallet.close(); wallet = new MockChain(chainFile); app = new Spike(state, wallet, code); },
    pending() { app.authorize(invoice.id, approval, consent, 1); app.request(invoice.id); },
    converted() {
      app.receive(invoice.id, quote, 1, funds);
      const id = app.swap(invoice.id, 2, funds);
      wallet.settle(id, swapReceipt);
      app.reconcileSwap(invoice.id, 'filled');
      app.claimPayout(invoice.id);
    },
  };
}

test('immutable canonical commitment and version-bound approval', t => {
  const f = setup(t);
  assert(Object.isFrozen(commit(invoice).invoice));
  assert.equal(commit({ ...invoice, recipient: recipient.toUpperCase().replace('0X', '0x') }).digest, f.approval.digest);
  assert.notEqual(commit({ ...invoice, version: 2 }).digest, f.approval.digest);
  assert.throws(() => f.app.authorize(invoice.id, { ...f.approval, digest: commit({ ...invoice, version: 2 }).digest }, f.consent, 1), /approval/);
  assert.equal(f.app.read(invoice.id).state, 'rejected');
});

test('zero consent rejects', t => {
  const f = setup(t);
  assert.throws(() => f.app.authorize(invoice.id, f.approval, undefined, 1), /consent/);
  assert.equal(f.wallet.count(), 0);
});

test('oversize no quote is persisted without broadcast', t => {
  const f = setup(t); f.pending();
  f.app.receive(invoice.id, { status: 'no_quote' }, 1, funds);
  f.restart();
  assert.equal(f.app.read(invoice.id).state, 'failed');
  assert.equal(f.wallet.count(), 0);
});

for (const item of [
  { name: 'accept cutoff', change: { expiresAt: 1 }, error: /expired/ },
  { name: 'order deadline', change: { orderDeadline: 1 }, error: /expired/ },
  { name: 'cap breach', change: { takerPays: '1200001' }, error: /cap/ },
  { name: 'wrong token', change: { buy: usdt }, error: /corridor/ },
  { name: 'wrong chain', change: { chain: 56 }, error: /corridor/ },
  { name: 'partial output', change: { buyAmount: '1499999999' }, error: /exact output/ },
  { name: 'incorrect spender', change: { transactions: { ...quote.transactions, approval: tx(usdt, approvalData(recipient)) } }, error: /spender/ },
]) test(item.name + ' rejects before broadcast', t => {
  const f = setup(t); f.pending();
  assert.throws(() => f.app.receive(invoice.id, { ...quote, ...item.change }, 1, funds), item.error);
  assert.equal(f.app.read(invoice.id).state, 'rejected');
  assert.equal(f.wallet.count(), 0);
});

for (const balance of [{ usdt: 0n }, { gas: 9n }, { allowance: 0n }])
  test('insufficient ' + Object.keys(balance)[0], t => {
    const f = setup(t); f.pending();
    assert.throws(() => f.app.receive(invoice.id, quote, 1, { ...funds, ...balance }), /insufficient/);
    assert.equal(f.wallet.count(), 0);
  });

for (const report of ['expired', 'failed'] as const)
  test(report + ' then late fill requires independent exact receipt', t => {
    const f = setup(t); f.pending();
    f.app.receive(invoice.id, quote, 1, funds);
    const id = f.app.swap(invoice.id, 2, funds);
    assert.equal(f.app.read(invoice.id).swap?.data, tag(batch, code));
    f.app.reconcileSwap(invoice.id, report);
    f.restart();
    f.app.reconcileSwap(invoice.id, 'filled');
    assert.equal(f.app.read(invoice.id).state, 'needs_reconciliation');
    assert.throws(() => f.app.swap(invoice.id, 3, funds), /already attempted/);
    f.wallet.settle(id, { ...swapReceipt, amount: '1' });
    f.app.reconcileSwap(invoice.id, 'filled');
    assert.equal(f.app.read(invoice.id).state, 'needs_reconciliation');
    f.wallet.settle(id, swapReceipt);
    f.app.reconcileSwap(invoice.id, 'filled');
    assert.equal(f.app.read(invoice.id).state, 'converted');
    assert.equal(f.wallet.count(), 1);
  });

test('wrong recipient payout rejects', t => {
  const f = setup(t); f.pending(); f.converted();
  assert.throws(() => f.app.payout(invoice.id, tx(cngn, tag(transferData(taker), code)), 3, funds), /recipient/);
  assert.equal(f.wallet.count(), 1);
});

test('payout crash, restart, duplicate retry and eventual payment', t => {
  const f = setup(t); f.pending(); f.converted();
  assert.throws(() => f.app.payout(invoice.id, payoutTx, 3, funds, true), /simulated crash/);
  f.restart();
  const { payoutId } = f.app.read(invoice.id);
  assert(payoutId);
  f.app.reconcilePayout(invoice.id);
  assert.throws(() => f.app.payout(invoice.id, payoutTx, 3, funds), /already claimed/);
  f.wallet.settle(payoutId, { ...swapReceipt, to: recipient });
  f.app.reconcilePayout(invoice.id);
  assert.equal(f.app.read(invoice.id).state, 'paid');
  assert.equal(f.wallet.count(), 2);
});

test('reverted payout after completed conversion preserves conversion and blocks retries', t => {
  const f = setup(t); f.pending(); f.converted();
  const id = f.app.payout(invoice.id, payoutTx, 3, funds);
  f.wallet.settle(id, { ...swapReceipt, to: recipient, ok: false });
  f.app.reconcilePayout(invoice.id);
  f.restart();
  assert(f.app.read(invoice.id).history.includes('converted'));
  assert.equal(f.app.read(invoice.id).state, 'needs_reconciliation');
  assert.throws(() => f.app.swap(invoice.id, 4, funds), /already attempted/);
  assert.throws(() => f.app.payout(invoice.id, payoutTx, 4, funds), /already claimed/);
  assert.equal(f.wallet.count(), 2);
});

test('SDK round trip for approval, identity, batch swap and payout', () => {
  const register = encodeFunctionData({
    abi: parseAbi(['function register(string agentURI) returns (uint256)']),
    functionName: 'register', args: ['ipfs://synthetic-fixture'],
  });
  const wrong = code === 'celo_wrong_fixture' ? 'celo_other_fixture' : 'celo_wrong_fixture';
  for (const raw of [tx(usdt, approvalData(reactor)), tx(registry, register), tx(reactor, batch), tx(cngn, transferData(recipient))]) {
    const tagged = tag(raw.data, code);
    assert(tagged.startsWith(raw.data));
    verifyTag(tagged, code);
    assert.throws(() => verifyTag(raw.data, code), /attribution/);
    assert.throws(() => verifyTag(tagged, wrong), /attribution/);
    assert.throws(() => tag(tagged, code), /already attributed/);
  }
});
