import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { type Hex } from 'viem';
import { authorizationMessage, authorizationPacket, verifyAuthorization } from '../src/authorization.ts';
import { browserWallet, type InjectedProvider } from '../src/browser-wallet.ts';
import { walletBoundary } from '../src/wallet-boundary.ts';
import { type Settlement } from '../src/celo.ts';
import { cngn, commit, reactor, Spike, usdt } from '../src/invoice.ts';
import { feeFields, feeLimits, origin, readFixture, transactionHash, transfer } from './rpc-fixture.ts';

const sender = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000002';
const maker = '0x0000000000000000000000000000000000000003';
const now = Date.parse('2026-11-22T12:00:00Z');
const amount = 1500000000n;
const debit = 1100220n;
const plan: Settlement = {
  hash: transactionHash, action: 'swap', sender, recipient: sender,
  buyToken: cngn, sellToken: usdt, amount, debit, bounds: feeFields,
  tx: { to: reactor, data: '0x1234', chainId: 42220, value: '0' },
};

test('signed approval and separately signed consent bind invoice digest, role, audience and expiry', async () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const payee = privateKeyToAccount(generatePrivateKey());
  const commitment = commit({
    id: 'signed-fixture', version: 1, source: 'offline fixture', nonce: '0123456789abcdef0123456789abcdef',
    chain: 42220, sell: usdt, buy: cngn, sellDecimals: 6, buyDecimals: 6, buyAmount: amount.toString(),
    maxSell: '1200000', recipient: payee.address, approver: payer.address, taker: sender, expires: now + 60_000,
  });
  const { invoice, digest } = commitment;
  const approvalPacket = authorizationPacket(invoice, digest, 'invoice approval', origin);
  const consentPacket = authorizationPacket(invoice, digest, 'recipient consent', origin);
  assert.equal(approvalPacket.signer, invoice.approver);
  assert.equal(consentPacket.signer, invoice.recipient);
  assert.equal(JSON.parse(consentPacket.typedData).message.purpose, 'recipient consent');
  assert.equal(JSON.parse(approvalPacket.typedData).message.invoiceDigest, '0x' + digest);
  const approval = await payer.signTypedData(authorizationMessage(invoice, digest, 'invoice approval', origin));
  const consent = await payee.signTypedData(authorizationMessage(invoice, digest, 'recipient consent', origin));
  const spike = new Spike(':memory:', undefined, 'celo_daidai_fixture');
  try {
    spike.create(invoice);
    assert.throws(() => spike.authorize(invoice.id, { digest, approver: invoice.approver }, undefined, now), /synthetic/);
    assert.throws(() => spike.authorizeVerified(invoice.id, { digest, approver: invoice.approver,
      recipient: invoice.recipient, expires: invoice.expires }, now), /verified authorization/);
    await assert.rejects(verifyAuthorization(invoice, digest, origin, { approval: consent, consent: approval }, now), /signature/);
    await assert.rejects(verifyAuthorization(invoice, '1'.repeat(64), origin, { approval, consent }, now), /signature/);
    await assert.rejects(verifyAuthorization(invoice, digest, 'http://localhost:4321', { approval, consent }, now), /signature/);
    await assert.rejects(verifyAuthorization(invoice, digest, origin, { approval, consent }, invoice.expires), /scope/);
    const authorization = await verifyAuthorization(invoice, digest, origin, { approval, consent }, now);
    spike.authorizeVerified(invoice.id, authorization, now);
    assert.equal(spike.read(invoice.id).state, 'authorized');
    assert.throws(() => spike.authorizeVerified(invoice.id, authorization, now), /transition/);
  } finally { spike.close(); }
});

test('trusted RPC accepts only a canonical finalized receipt with exact call and ERC-20 movements', async () => {
  const rpc = readFixture(sender, maker, amount, debit);
  const verify = () => rpc.reader.verifySettlement(plan);
  assert.equal(await verify(), undefined);
  rpc.mine(plan.hash, plan.tx, sender);
  const tx = rpc.transactions.get(plan.hash)!;
  const receipt = rpc.receipts.get(plan.hash)!;
  for (const [field, wrong] of [
    ['hash', `0x${'55'.repeat(32)}`], ['from', maker], ['input', '0x4321'], ['nonce', '0x1'],
    ['chainId', '0x1'], ['gas', '0x186a1'], ['maxFeePerGas', '0xb'],
  ]) {
    const original = tx[field];
    tx[field] = wrong;
    assert.equal(await verify(), undefined, field);
    tx[field] = original;
  }
  receipt.status = '0x0';
  assert.equal(await verify(), undefined);
  receipt.status = '0x1';
  const logs = receipt.logs as Record<string, unknown>[];
  function replaceTransfer(token: string, to: Hex) {
    return [logs[0], { ...logs[1], ...transfer(token, maker, to, amount) }];
  }
  receipt.logs = replaceTransfer(cngn, recipient);
  assert.equal(await verify(), undefined);
  receipt.logs = replaceTransfer(maker, sender);
  assert.equal(await verify(), undefined);
  receipt.logs = logs;
  rpc.state.finalized = '0x1';
  assert.equal(await verify(), undefined);
  rpc.state.finalized = '0x3';
  rpc.state.blockHash = `0x${'99'.repeat(32)}`;
  assert.equal(await verify(), undefined);
  rpc.state.blockHash = String(receipt.blockHash) as Hex;
  assert.equal((await verify())?.receipt.amount, amount.toString());
});

test('RPC simulation enforces gas, total fee and network before handoff', async () => {
  const rpc = readFixture(sender, maker, amount, debit);
  const call = { from: sender, to: reactor, data: '0x1234', value: '0x0' } as const;
  assert.deepEqual(await rpc.reader.preflight(call, feeLimits, plan), feeFields);
  rpc.state.gas = '0x186a1';
  await assert.rejects(rpc.reader.preflight(call, feeLimits), /ceiling/);
  rpc.state.gas = '0x5208';
  rpc.state.fee = feeLimits.totalWei + 1n;
  await assert.rejects(rpc.reader.preflight(call, feeLimits), /ceiling/);
  rpc.state.chain = '0x1';
  await assert.rejects(rpc.reader.preflight(call, feeLimits), /chain/);
  assert(!rpc.calls.some(method => /send|sign/i.test(method)));
});

test('authenticated loopback wallet boundary refuses wrong origin, token, replay and changed account', async () => {
  const boundary = walletBoundary(origin);
  const post = (body: object, token = boundary.token, from = origin) => boundary.handle(new Request(origin + '/wallet', {
    method: 'POST', headers: { origin: from, authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  }));
  assert.equal((await post({ action: 'poll' }, 'bad')).status, 403);
  assert.equal((await post({ action: 'poll' }, boundary.token, 'https://example.com')).status, 403);
  const accounts = boundary.provider.request({ method: 'eth_accounts' });
  const job = await (await post({ action: 'poll' })).json() as { id: string };
  assert.equal(await (await post({ action: 'poll' })).json(), null);
  assert.equal((await post({ action: 'complete', id: job.id, result: [sender] })).status, 200);
  assert.deepEqual(await accounts, [sender]);
  assert.equal((await post({ action: 'complete', id: job.id, result: [recipient] })).status, 409);
  const listeners = new Map<string, () => void>();
  const methods: string[] = [];
  const provider: InjectedProvider = {
    async request(args) { methods.push(args.method); return args.method === 'eth_accounts' ? [recipient] : '0xa4ec'; },
    on(event, listener) { listeners.set(event, listener); },
    removeListener(event) { listeners.delete(event); },
  };
  const browser = browserWallet({ sender, provider, token: boundary.token, endpoint: origin + '/wallet',
    transport: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('origin', origin);
      return boundary.handle(new Request(url, { ...init, headers }));
    }, review: async () => true });
  try {
    const send = boundary.provider.request({ method: 'eth_sendTransaction', params: [{ from: sender, chainId: '0xa4ec' }] });
    const rejected = assert.rejects(send, /declined or disconnected/);
    await browser.step();
    await rejected;
    assert.deepEqual(methods, ['eth_accounts', 'eth_chainId']);
  } finally { browser.dispose(); boundary.close(); }
});
