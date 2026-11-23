import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizationMessage, verifyAuthorization } from '../src/authorization.ts';
import { cngn, chain, commit, reactor, usdt } from '../src/invoice.ts';
import { fillerAbi, orderAbi, preferredFiller, reactorAbi } from '../src/textile.ts';
import { readFirmFixture, reviewConversion, reviewPayout, verifyConversion, verifyPayout } from '../src/settlement-review.ts';
import { feeLimits, origin, readFixture, transactionHash } from './rpc-fixture.ts';

const addr = (digit: string) => ('0x' + digit.repeat(40)) as Hex;
const key = (digit: string) => ('0x' + digit.repeat(64)) as Hex;
const approver = privateKeyToAccount(key('1')), recipient = privateKeyToAccount(key('2'));
const taker = addr('3'), maker = addr('4'), payoutHash = key('5');
const now = 1_800_000_000_000, debit = 1_001_000n, target = 1_500_000_000n;
const { invoice, digest } = commit({ id: 'p12-test', version: 1, nonce: '1'.repeat(32), source: 'fixture',
  chain, sell: usdt, buy: cngn, sellDecimals: 6, buyDecimals: 6, buyAmount: String(target), maxSell: '1100000',
  approver: approver.address, recipient: recipient.address, taker, expires: now + 60_000 });
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
async function setup() {
  const proof = await verifyAuthorization(invoice, digest, origin, {
    approval: await approver.signTypedData(authorizationMessage(invoice, digest, 'invoice approval', origin)),
    consent: await recipient.signTypedData(authorizationMessage(invoice, digest, 'recipient consent', origin)),
  }, now);
  const rpc = readFixture(taker, maker, target, debit);
  let clock = now;
  const funds = { chain, wallet: taker, sellToken: usdt, buyToken: cngn, spender: reactor, observedAt: now,
    allowance: debit, usdt: 1_100_000n, cngn: target, native: 2n * feeLimits.totalWei };
  const ports = { clock: () => clock, balances: async () => ({ ...funds }), reader: rpc.reader };
  return { proof, rpc, ports, funds, tick: (offset: number) => { clock = now + offset; funds.observedAt = clock; } };
}

test('firm fixture interface binds exact output and prepares conversion and separate payout evidence', async () => {
  const { proof, rpc, ports } = await setup();
  const wire = await readFirmFixture(invoice, async req => {
    assert.deepEqual(req, { chainId: 42220, sellToken: usdt, buyToken: cngn, buyAmount: String(target), taker });
    return quote();
  });
  const review = await reviewConversion(invoice, proof, wire, ports, policy);
  assert.equal(review.kind, 'review');
  if (review.kind !== 'review') throw Error('missing review');
  assert.equal(review.debit, debit);
  assert.equal(review.fee, 1000n);
  await assert.rejects(reviewPayout(invoice, proof, { digest, hash: transactionHash }, ports, policy), /finalized conversion/);
  rpc.mine(transactionHash, review.candidate.tx, taker);
  rpc.state.finalized = '0x1';
  assert.equal(await verifyConversion(review.candidate, transactionHash, rpc.reader), null);
  rpc.state.finalized = '0x3';
  const conversion = await verifyConversion(review.candidate, transactionHash, rpc.reader);
  assert(conversion);
  rpc.state.payoutRecipient = invoice.recipient as Hex;
  const payout = await reviewPayout(invoice, proof, conversion, ports, policy);
  assert.equal(payout.recipient, invoice.recipient);
  assert.equal(payout.debit, 0n);
  assert.equal(await verifyPayout(payout, payoutHash, rpc.reader), null);
  rpc.mine(payoutHash, payout.tx, invoice.recipient as Hex, target - 1n);
  assert.equal(await verifyPayout(payout, payoutHash, rpc.reader), null);
  rpc.mine(payoutHash, payout.tx, invoice.recipient as Hex);
  const original = rpc.receipts.get(payoutHash)!;
  const logs = original.logs as { logIndex: string }[];
  rpc.receipts.set(payoutHash, { ...original, logs: logs.map(log => ({ ...log, logIndex: '0x00' })) });
  assert.equal(await verifyPayout(payout, payoutHash, rpc.reader), null);
  rpc.receipts.set(payoutHash, original);
  assert(await verifyPayout(payout, payoutHash, rpc.reader));
  assert(!rpc.calls.some(method => /send|sign/i.test(method)));
});

test('rejects incorrect fee accounting, envelope, balance, allowance cap, stale quote and stale simulation', async () => {
  const { proof, rpc, ports, funds, tick } = await setup();
  const fee = quote(); fee.data.quote.feeAmount = '999';
  await assert.rejects(reviewConversion(invoice, proof, fee, ports, policy), /signed order totals/);
  const envelope = quote(); envelope.data.transactions.swap.chainId = 1;
  await assert.rejects(reviewConversion(invoice, proof, envelope, ports, policy), /envelope/);
  funds.native = 1n;
  await assert.rejects(reviewConversion(invoice, proof, quote(), ports, policy), /balance/);
  funds.native = 2n * feeLimits.totalWei;
  funds.allowance = 1_100_001n;
  await assert.rejects(reviewConversion(invoice, proof, quote(), ports, policy), /allowance exceeds/);
  funds.allowance = 0n;
  assert.equal((await reviewConversion(invoice, proof, quote(), ports, policy)).kind, 'allowance-required');
  funds.allowance = debit;
  const first = await reviewConversion(invoice, proof, quote(), ports, policy);
  assert.equal(first.kind, 'review');
  rpc.state.simulatedDebit -= 1n;
  await assert.rejects(reviewConversion(invoice, proof, quote(), ports, policy), /simulation mismatch/);
  tick(36_000);
  await assert.rejects(reviewConversion(invoice, proof, quote(), ports, policy), /fresh/);
  tick(0); rpc.state.simulatedDebit = debit;
  rpc.state.afterSimulation = () => tick(36_000);
  await assert.rejects(reviewConversion(invoice, proof, quote(), ports, policy), /fresh/);
});
