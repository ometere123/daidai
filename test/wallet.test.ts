import { feeFields, feeLimits, origin, readFixture } from './rpc-fixture.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { fromDataSuffix } from '@celo/attribution-tags';
import { MockChain, Spike, cngn, chain, reactor, registry, tag, usdt, type Tx } from '../src/invoice.ts';
import { fillerAbi, orderAbi, preferredFiller, reactorAbi } from '../src/textile.ts';
import { WalletAdapter, type InjectedProvider } from '../src/wallet.ts';

const sender = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000002';
const maker = '0x0000000000000000000000000000000000000003';
const code = process.env.DAIDAI_ATTRIBUTION_CODE ?? 'celo_daidai_fixture';
const hash: Hex = `0x${'11'.repeat(32)}`;
const otherHash: Hex = `0x${'22'.repeat(32)}`;
const now = Date.parse('2026-11-22T12:00:00Z');
const funds = { usdt: 2000000n, cngn: 1500000000n, gas: 10n, allowance: 2000000n, swapGas: 6n, payoutGas: 4n };
const invoice = {
  id: 'invoice', version: 1, source: 'fixture', nonce: '0123456789abcdef0123456789abcdef',
  chain, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6, buyAmount: '1500000000',
  recipient, maxSell: '1200000', approver: sender, taker: sender, expires: now + 120_000,
};

function wire(boundTaker: Hex = sender) {
  const deadline = (BigInt(now) + 50_000n) / 1_000n;
  const orders = [1n, 2n].map(nonce => ({
    order: encodeAbiParameters(orderAbi, [{
      info: { reactor, swapper: maker, nonce, deadline, validator: preferredFiller,
        validation: encodeAbiParameters(fillerAbi, [[boundTaker], deadline]) },
      input: { token: cngn, amount: 750000000n, maxAmount: 750000000n },
      outputs: [{ token: usdt, amount: 550000n, recipient: maker }],
    }]),
    sig: '0x1234' as Hex,
  }));
  const swap = encodeFunctionData({ abi: reactorAbi, functionName: 'executeBatch', args: [orders] });
  return { data: { status: 'quoted', quote: {
    taker: sender as string, reactor, spender: reactor as string, feeAmount: '220', takerPays: '1100220', buyAmount: '1500000000',
    expiresAt: new Date(now + 45_000).toISOString(), orderDeadline: new Date(now + 50_000).toISOString(),
    latestOrderDeadline: new Date(now + 50_000).toISOString(),
  }, transactions: {
    approval: { to: usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve',
      args: [reactor, 1100220n] }), value: '0', chainId: chain },
    swap: { to: reactor as string, data: swap, value: '0', chainId: chain },
  } } };
}

class MockProvider implements InjectedProvider {
  accounts: string[] = [sender];
  chain = '0xa4ec';
  calls: Parameters<InjectedProvider['request']>[0][] = [];
  listeners = new Map<string, Set<() => void>>();
  outcome: () => Promise<unknown> = async () => hash;
  async request(args: Parameters<InjectedProvider['request']>[0]) {
    this.calls.push(args);
    if (args.method === 'eth_accounts') return this.accounts;
    if (args.method === 'eth_chainId') return this.chain;
    if (args.method === 'eth_sendTransaction') return this.outcome();
    throw Error('unexpected provider method');
  }
  on(event: string, listener: () => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  removeListener(event: string, listener: () => void) { this.listeners.get(event)?.delete(listener); }
  emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener(); }
  sends() { return this.calls.filter(call => call.method === 'eth_sendTransaction'); }
}

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'daidai-adapter-'));
  const file = join(root, 'invoice.db');
  const mockChain = new MockChain(join(root, 'mock.db'));
  const provider = new MockProvider();
  let clock = now;
  const rpc = readFixture(sender, maker, 1500000000n, 1100220n);
  let spike = new Spike(file, mockChain, code);
  const makeAdapter = () => new WalletAdapter({
    sender, spike, provider, clock: () => clock, timeoutMs: 25,
    reader: rpc.reader, fees: feeLimits, origin,
  });
  let adapter = makeAdapter();
  const { digest } = spike.create(invoice);
  spike.authorize(invoice.id, { digest, approver: sender }, { digest, recipient, evidence: 'fixture' }, now);
  t.after(() => { adapter.dispose(); spike.close(); mockChain.close(); rmSync(root, { recursive: true }); });
  return {
    get adapter() { return adapter; }, get spike() { return spike; }, provider,
    clock(value: number) { clock = value; },
    rpc, code(value: Hex) { rpc.state.code = value; },
    debit(value: bigint) { rpc.state.simulatedDebit = value; },
    reopen() { adapter.dispose(); spike.close(); spike = new Spike(file, mockChain, code); adapter = makeAdapter(); },
    quote() { spike.request(invoice.id); adapter.acceptQuote(invoice.id, wire(), funds); },
  };
}

test('real RFQ shape binds exact-out taker to selected sender', async t => {
  const f = setup(t);
  const request = await f.adapter.prepareRfq(invoice.id);
  assert.deepEqual(request, { chainId: chain, sellToken: usdt, buyToken: cngn, buyAmount: '1500000000', taker: sender });
  assert.deepEqual(f.provider.calls.map(call => call.method), ['eth_accounts', 'eth_chainId']);
});

for (const fault of ['sender', 'chain', 'accountsChanged', 'chainChanged', 'disconnect', 'smart account']) {
  test(`provider rejects ${fault} before send`, async t => {
    const f = setup(t);
    const prepared = f.adapter.prepareRegistration('ipfs://fixture', now + 60_000);
    if (fault === 'sender') f.provider.accounts = [recipient];
    else if (fault === 'chain') f.provider.chain = '0x1';
    else if (fault === 'smart account') f.code('0xef0100');
    else f.provider.emit(fault);
    await assert.rejects(f.adapter.submit(prepared), /sender|chain|changed|disconnected|smart/);
    assert.equal(f.provider.sends().length, 0);
  });
}

for (const [name, modify, error] of [
  ['taker', (w: ReturnType<typeof wire>) => { w.data.quote.taker = recipient; }, /taker/],
  ['spender', (w: ReturnType<typeof wire>) => { w.data.quote.spender = recipient; }, /spender/],
  ['output', (w: ReturnType<typeof wire>) => { w.data.quote.buyAmount = '1499999999'; }, /exact output/],
  ['cap', (w: ReturnType<typeof wire>) => { w.data.quote.takerPays = '1200001'; }, /cap/],
  ['target', (w: ReturnType<typeof wire>) => { w.data.transactions.swap.to = usdt; }, /envelope/],
  ['chain', (w: ReturnType<typeof wire>) => { w.data.transactions.swap.chainId = 1; }, /envelope/],
  ['approval bytes', (w: ReturnType<typeof wire>) => { w.data.transactions.approval.data = '0x1234'; }, /approval/],
  ['hidden debit', (w: ReturnType<typeof wire>) => { w.data.quote.feeAmount = '1'; }, /order totals/],
  ['deadline', (w: ReturnType<typeof wire>) => { w.data.quote.orderDeadline = new Date(now + 49_000).toISOString(); }, /deadlines/],
  ['double suffix', (w: ReturnType<typeof wire>) => { w.data.transactions.swap.data = tag(w.data.transactions.swap.data, code); }, /noncanonical/],
] as const) {
  test(`Textile response rejects ${name}`, t => {
    const f = setup(t);
    f.spike.request(invoice.id);
    const bad = wire();
    modify(bad);
    assert.throws(() => f.adapter.acceptQuote(invoice.id, bad, funds), error);
    assert.equal(f.provider.sends().length, 0);
  });
}

test('pre-quote approval enforces cap and encodes exact spender, sender and tag', async t => {
  const f = setup(t);
  assert.throws(() => f.adapter.prepareApproval(invoice.id, 1200001n), /cap/);
  const prepared = f.adapter.prepareApproval(invoice.id, 1200000n);
  const raw = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [reactor, 1200000n] });
  assert.deepEqual(prepared.request, { from: sender, to: usdt, data: tag(raw, code), value: '0x0', chainId: '0xa4ec' });
  await assert.rejects(f.adapter.submit({ ...prepared }), /unrecognized/);
  assert.deepEqual(await f.adapter.submit(prepared), { status: 'hash_returned', hash });
  assert.deepEqual(f.provider.sends()[0].params, [{ ...prepared.request, ...feeFields }]);
  assert.deepEqual(fromDataSuffix(prepared.request.data)?.codes, [code]);
  f.reopen();
  await assert.rejects(f.adapter.submit(f.adapter.prepareApproval(invoice.id, 1200000n)), /duplicate/);
  assert.equal(f.provider.sends().length, 1);
});

test('ERC-8004 registration uses direct wallet and one tagged register call', async t => {
  const f = setup(t);
  const prepared = f.adapter.prepareRegistration('ipfs://fixture', now + 30_000);
  assert.equal(prepared.request.to, registry);
  assert.equal(prepared.request.from, sender);
  assert.equal(prepared.request.data.slice(0, 10), '0xf2c298be');
  assert.deepEqual(fromDataSuffix(prepared.request.data)?.codes, [code]);
  await f.adapter.submit(prepared);
  assert.deepEqual(f.provider.sends()[0].params, [{ ...prepared.request, ...feeFields }]);
});

test('swap requires matching simulation and freshly valid quote before handoff', async t => {
  const f = setup(t);
  f.quote();
  const prepared = f.adapter.prepareSwap(invoice.id, funds);
  f.debit(1100221n);
  await assert.rejects(f.adapter.submit(prepared), /simulation mismatch/);
  f.debit(1100220n);
  f.clock(now + 41_000);
  await assert.rejects(f.adapter.submit(prepared), /headroom/);
  assert.equal(f.provider.sends().length, 0);
  assert.equal(f.spike.read(invoice.id).state, 'quoted');
});

test('wallet rejection journals the attempt and blocks automatic replay', async t => {
  const f = setup(t);
  f.quote();
  f.provider.outcome = async () => { throw { code: 4001 }; };
  assert.deepEqual(await f.adapter.submit(f.adapter.prepareSwap(invoice.id, funds)), { status: 'user_rejected' });
  assert.equal(f.spike.read(invoice.id).state, 'needs_reconciliation');
  f.reopen();
  assert.throws(() => f.adapter.prepareSwap(invoice.id, funds), /already attempted/);
  assert.equal(f.provider.sends().length, 1);
});

test('ambiguous swap requires late independent exact receipt, then sends one exact payout', async t => {
  const f = setup(t);
  f.quote();
  const prepared = f.adapter.prepareSwap(invoice.id, funds);
  assert.equal(prepared.request.data, tag(wire().data.transactions.swap.data, code));
  assert.deepEqual(await f.adapter.submit(prepared), { status: 'hash_returned', hash });
  f.reopen();
  await f.adapter.reconcileSwap(invoice.id, 'expired');
  await f.adapter.reconcileSwap(invoice.id, 'filled');
  assert.equal(f.spike.read(invoice.id).state, 'needs_reconciliation');
  assert.throws(() => f.spike.claimPayout(invoice.id), /transition/);
  const swap = f.spike.read(invoice.id).swap!;
  f.rpc.mine(hash, swap, sender, 1499999999n);
  await f.adapter.reconcileSwap(invoice.id, 'filled');
  assert.equal(f.spike.read(invoice.id).state, 'needs_reconciliation');
  f.rpc.mine(hash, swap, sender);
  await f.adapter.reconcileSwap(invoice.id, 'filled');
  f.spike.claimPayout(invoice.id);
  const payout = f.adapter.preparePayout(invoice.id, funds);
  assert.equal(payout.request.to, cngn);
  assert.equal(payout.request.from, sender);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: payout.request.data }).args, [recipient, 1500000000n]);
  assert.deepEqual(fromDataSuffix(payout.request.data)?.codes, [code]);
  f.provider.outcome = async () => otherHash;
  const results = await Promise.allSettled([f.adapter.submit(payout), f.adapter.submit(payout)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
  f.reopen();
  assert.throws(() => f.adapter.preparePayout(invoice.id, funds), /already claimed/);
  f.rpc.mine(hash, f.spike.read(invoice.id).payout!, recipient);
  await f.adapter.reconcilePayout(invoice.id);
  assert.equal(f.spike.read(invoice.id).state, 'needs_reconciliation');
  f.rpc.mine(otherHash, f.spike.read(invoice.id).payout!, recipient);
  await f.adapter.reconcilePayout(invoice.id);
  assert.equal(f.spike.read(invoice.id).state, 'paid');
  assert.equal(f.provider.sends().length, 2);
});

test('signed filler mismatch rejects even when quote metadata names the pinned taker', t => {
  const f = setup(t);
  f.spike.request(invoice.id);
  assert.throws(() => f.adapter.acceptQuote(invoice.id, wire(recipient), funds), /restricted to taker/);
  assert.equal(f.provider.sends().length, 0);
});

test('account changes during an asynchronous wallet check invalidate the session', async t => {
  const f = setup(t);
  const original = f.provider.request.bind(f.provider);
  f.provider.request = async args => {
    const result = await original(args);
    if (args.method === 'eth_chainId') f.provider.emit('accountsChanged');
    return result;
  };
  await assert.rejects(f.adapter.prepareRfq(invoice.id), /changed/);
  assert.equal(f.provider.sends().length, 0);
});

test('wallet timeout without a hash blocks settlement and resend after restart', async t => {
  const f = setup(t);
  f.quote();
  f.provider.outcome = () => new Promise(() => {});
  assert.deepEqual(await f.adapter.submit(f.adapter.prepareSwap(invoice.id, funds)), { status: 'needs_reconciliation' });
  const swap = f.spike.read(invoice.id).swap!;
  f.rpc.mine(hash, swap, sender);
  f.reopen();
  await f.adapter.reconcileSwap(invoice.id, 'filled');
  assert.equal(f.spike.read(invoice.id).state, 'needs_reconciliation');
  assert(!f.rpc.calls.includes('eth_getTransactionReceipt'));
  assert.throws(() => f.adapter.prepareSwap(invoice.id, funds), /already attempted/);
});


test('a caller-supplied receipt object cannot promote an invoice', async t => {
  const f = setup(t);
  f.quote();
  await f.adapter.submit(f.adapter.prepareSwap(invoice.id, funds));
  const forged = { hash, receipt: { ok: true, finalized: true, chain, from: sender, to: sender,
    token: cngn, amount: '1500000000', debit: '1100220', tx: f.spike.read(invoice.id).swap! } };
  f.spike.reconcileSwap(invoice.id, 'filled', forged);
  assert.equal(f.spike.read(invoice.id).state, 'needs_reconciliation');
});
