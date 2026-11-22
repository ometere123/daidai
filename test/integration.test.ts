import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { browserWallet, type InjectedProvider, type RpcRequest } from '../src/browser-wallet.ts';
import { proofWindowMs, takerTypedData, takerWalletRequest, type TakerChallenge } from '../src/taker-schema.ts';
import { proveTextileTaker } from '../src/taker-proof.ts';
import { startWalletHost } from '../src/wallet-host.ts';

test('official Textile scope fixes domain, type order, chain, nonce and millisecond time', async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const taker = owner.address.toLowerCase();
  let now = Date.now();
  const seen: TakerChallenge[] = [];
  const sign = async (challenge: TakerChallenge) => {
    seen.push(challenge);
    return owner.signTypedData(takerTypedData(challenge));
  };
  const first = await proveTextileTaker(taker, sign, () => now);
  const second = await proveTextileTaker(taker, sign, () => now);
  assert.match(first.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(first.issuedAt, now);
  assert.deepEqual(Object.keys(first), ['nonce', 'issuedAt', 'signature']);
  const [wallet, json] = takerWalletRequest(seen[0]).params;
  const data = JSON.parse(json);
  assert.equal(wallet, taker);
  assert.deepEqual(data.domain, { name: 'Textile Taker Control', version: '1', chainId: 42220 });
  assert.deepEqual(data.types.TakerControl.map((field: { name: string; type: string }) => [field.name, field.type]),
    [['taker', 'address'], ['chainId', 'uint256'], ['nonce', 'bytes32'], ['issuedAt', 'uint256']]);
  assert.equal(data.message.issuedAt, String(now));
  await assert.rejects(proveTextileTaker(taker,
    c => other.signTypedData(takerTypedData(c)), () => now), /signer mismatch/);
  await assert.rejects(proveTextileTaker(taker,
    c => owner.signTypedData(takerTypedData({ ...c, nonce: second.nonce })), () => now), /signer mismatch/);
  await assert.rejects(proveTextileTaker(taker,
    c => owner.signTypedData({ ...takerTypedData(c), domain: { ...takerTypedData(c).domain, chainId: 1 } }),
    () => now), /signer mismatch/);
  await assert.rejects(proveTextileTaker(taker, async c => {
    now += proofWindowMs;
    return sign(c);
  }, () => now), /stale/);
});

test('real localhost bootstrap and mock proof run deny foreign origin, replay and generic signing', async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const sender = owner.address.toLowerCase();
  const host = await startWalletHost(sender);
  const bootstrap = new URL(host.bootstrapUrl).hash.slice(1);
  const open = (secret: string, origin = host.origin) => fetch(host.origin + '/bootstrap', {
    method: 'POST', headers: { origin, authorization: 'Bearer ' + secret },
  });
  try {
    const document = await fetch(host.origin);
    assert.match(document.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal((await fetch(host.origin + '/browser-wallet.ts')).status, 200);
    assert.equal((await fetch(host.origin + '/taker-schema.ts')).status, 200);
    assert.equal((await open('bad')).status, 403);
    assert.equal((await open(bootstrap, 'https://example.com')).status, 403);
    const response = await open(bootstrap);
    assert.equal(response.status, 200);
    assert.equal((await open(bootstrap)).status, 403);
    const { token } = await response.json() as { token: string };
    await assert.rejects(host.provider.request({ method: 'personal_sign' }), /denied/);
    await assert.rejects(host.provider.request({ method: 'eth_signTypedData_v4' }), /denied/);
    await assert.rejects(host.provider.request({ method: 'eth_sendTransaction',
      params: [{ from: '0x0000000000000000000000000000000000000001', chainId: '0xa4ec', data: '0x1234' }] }), /pinned/);
    const calls: RpcRequest[] = [];
    const provider: InjectedProvider = {
      on() {}, removeListener() {},
      async request(r) {
        calls.push(r);
        if (r.method === 'eth_accounts') return [sender];
        if (r.method === 'eth_chainId') return '0xa4ec';
        if (r.method !== 'eth_signTypedData_v4') throw Error('unexpected provider call');
        const message = JSON.parse(String(r.params?.[1])).message;
        return owner.signTypedData(takerTypedData({ taker: message.taker, nonce: message.nonce,
          issuedAt: Number(message.issuedAt) }));
      },
    };
    const transport: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('origin', host.origin);
      return fetch(url, { ...init, headers });
    };
    let captured: string | undefined;
    const client = browserWallet({ sender, token, endpoint: host.origin + '/wallet', provider, transport,
      review: async job => {
        captured = job.id;
        job.request.params![1] = 'substituted';
        return true;
      } });
    try {
      const proof = proveTextileTaker(sender, host.signTaker);
      await client.step();
      assert.equal((await proof).signature.length, 132);
      assert(!JSON.stringify(calls).includes('substituted'));
      assert.deepEqual(calls.map(call => call.method), ['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4']);
      const replay = await transport(host.origin + '/wallet', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ action: 'complete', id: captured, result: 'replay' }),
      });
      assert.equal(replay.status, 409);
    } finally { client.dispose(); }
  } finally { await host.close(); }
});

test('delayed browser confirmation refuses a stale swap job before any provider send', async () => {
  const sender = '0x0000000000000000000000000000000000000001';
  const host = await startWalletHost(sender);
  let clock = Date.now();
  const calls: RpcRequest[] = [];
  let delay = 0;
  try {
    const bootstrap = new URL(host.bootstrapUrl).hash.slice(1);
    const transport: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('origin', host.origin);
      return fetch(url, { ...init, headers });
    };
    const response = await transport(host.origin + '/bootstrap', {
      method: 'POST', headers: { authorization: 'Bearer ' + bootstrap },
    });
    const { token } = await response.json() as { token: string };
    const client = browserWallet({ sender, token, endpoint: host.origin + '/wallet', clock: () => clock, transport,
      provider: { on() {}, removeListener() {}, async request(r) { calls.push(r); if (r.method === 'eth_accounts') return [sender]; if (r.method === 'eth_chainId') return '0xa4ec'; if (r.method === 'eth_sendTransaction') return 'mock hash'; throw Error('unexpected wallet method'); } },
      review: async job => { clock += delay; (job.request.params![0] as { data: string }).data = '0x9999'; return true; },
    });
    try {
      const request = { method: 'eth_sendTransaction', params: [{ from: sender, chainId: '0xa4ec', data: '0x1234' }] };
      const timely = host.provider.request(request, clock + 20_000);
      await client.step();
      assert.equal(await timely, 'mock hash');
      assert.deepEqual(calls[2], request);
      delay = 25_000;
      const send = host.provider.request(request, clock + 20_000);
      const reject = assert.rejects(send, /declined or disconnected/);
      await client.step();
      await reject;
      assert.equal(calls.filter(call => call.method === 'eth_sendTransaction').length, 1);
    } finally { client.dispose(); }
  } finally { await host.close(); }
});
