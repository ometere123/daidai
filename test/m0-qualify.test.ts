// M0 qualification script, tested against a fake fetch. No network. Verifies the gates, not any real provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error the script is plain ESM JavaScript
import { qualify, REGISTRATION_TX } from '../scripts/m0-qualify.mjs';

type Behaviour = { chain?: string; simulate?: 'logs' | 'no-method' | 'no-logs' | 'revert'; hashSalt?: string; l1Fee?: boolean; leakInError?: boolean };
const A = 'https://rpc.node-a.invalid/v2/SECRETTOKENAAA111';
const B = 'https://celo-mainnet.g.alchemy.com/v2/SECRETTOKENBBB222';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const h = (salt: string, n: bigint) => '0x' + (salt + n.toString(16)).padEnd(64, '0').slice(0, 64);

function network(behaviours: Record<string, Behaviour>) {
  return async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (url.endsWith('/v2/openapi.json')) return new Response(JSON.stringify({ openapi: '3.1.0', info: { version: '2.0' }, paths: { '/v2/rfq/request': {}, '/v2/rfq/preview': {}, '/v2/other': {} } }));
    const b = behaviours[url] ?? {};
    const { method, params, id } = JSON.parse(String(init?.body));
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const fail = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    if (b.leakInError && method === 'eth_getBlockByNumber') return fail(-32000, `upstream refused ${url}`);
    const salt = b.hashSalt ?? 'aa';
    switch (method) {
      case 'eth_chainId': return reply(b.chain ?? '0xa4ec');
      case 'eth_getBlockByNumber': {
        const n = params[0] === 'latest' ? 0x20n : params[0] === 'finalized' ? 0x10n : BigInt(params[0]);
        return reply({ number: '0x' + n.toString(16), hash: h(salt, n), baseFeePerGas: '0x1', timestamp: '0x65000000' });
      }
      case 'eth_getTransactionByHash': return reply({ hash: REGISTRATION_TX });
      case 'eth_getTransactionReceipt': return reply({ status: '0x1', blockNumber: '0x5', blockHash: h(salt, 5n), logs: [] });
      case 'eth_simulateV1':
        if (b.simulate === 'no-method') return fail(-32601, 'the method eth_simulateV1 does not exist/is not available');
        return reply([{ calls: [{ status: b.simulate === 'revert' ? '0x0' : '0x1', logs: b.simulate === 'no-logs' ? undefined : [{ topics: [TRANSFER] }] }] }]);
      case 'eth_gasPrice': return reply('0x5');
      case 'eth_call': return b.l1Fee === false ? fail(-32000, 'execution reverted') : reply('0x' + '0'.repeat(63) + '7');
      default: return fail(-32601, 'unknown method');
    }
  };
}
const run = (urls: string[], behaviours: Record<string, Behaviour>) => qualify({ urls, fetchImpl: network(behaviours) });

test('M0-1: two independent providers with simulation logs, finality and agreement are live-ready, and no credential is printed', async () => {
  const report = await run([A, B], {});
  assert.equal(report.liveReady, true);
  assert.deepEqual(report.gates, { simulationWithTransferLogs: true, finality: true, twoProviderAgreement: true, feeEstimation: true, textileSchemaReadable: true });
  assert.equal(report.credentialsPrinted, false);
  const text = JSON.stringify(report);
  assert(!/SECRETTOKEN/.test(text) && !text.includes('node-a.invalid') && !text.includes('/v2/SECRET'), 'provider URLs and keys must never appear');
  assert.deepEqual(report.providers.map((p: { label: string; vendor: string }) => [p.label, p.vendor]), [['provider-1', 'other'], ['provider-2', 'alchemy']]);
  assert.deepEqual(report.textile.rfqPaths, ['/v2/rfq/preview', '/v2/rfq/request']);
});

test('M0-2: a provider that refuses eth_simulateV1 does not qualify for simulation, and is reported honestly', async () => {
  const lone = await run([A], { [A]: { simulate: 'no-method' } });
  assert.equal(lone.providers[0].simulation.status, 'method-not-supported');
  assert.equal(lone.gates.simulationWithTransferLogs, false);
  assert.equal(lone.liveReady, false);
  const mixed = await run([A, B], { [A]: { simulate: 'no-method' } });
  assert.equal(mixed.gates.simulationWithTransferLogs, true, 'one provider supporting simulation is enough for the simulation gate');
  assert.equal(mixed.liveReady, true);
});

test('M0-3: simulation that returns no transfer logs, or reverts, is not a pass', async () => {
  for (const simulate of ['no-logs', 'revert'] as const) {
    const report = await run([A, B], { [A]: { simulate }, [B]: { simulate } });
    assert.equal(report.gates.simulationWithTransferLogs, false, simulate);
    assert.equal(report.liveReady, false, simulate);
  }
});

test('M0-4: providers that disagree about the canonical block fail the agreement gate', async () => {
  const report = await run([A, B], { [B]: { hashSalt: 'bb' } });
  assert.equal(report.gates.twoProviderAgreement, false);
  assert.equal(report.agreement.registrationBlockAgrees, false);
  assert.equal(report.liveReady, false);
});

test('M0-5: a single provider can never satisfy the two-provider gate', async () => {
  const report = await run([A], {});
  assert.equal(report.agreement.ok, false);
  assert.match(report.agreement.reason, /fewer than two/);
  assert.equal(report.liveReady, false);
});

test('M0-6: the wrong chain is rejected and nothing else is trusted from that provider', async () => {
  const report = await run([A, B], { [A]: { chain: '0x1' } });
  assert.equal(report.providers[0].chainId.ok, false);
  assert.equal(report.providers[0].simulation, undefined);
  assert.equal(report.gates.twoProviderAgreement, false);
});

test('M0-7: provider errors that echo the URL are scrubbed from the report', async () => {
  const report = await run([A, B], { [A]: { leakInError: true } });
  const text = JSON.stringify(report);
  assert(!text.includes('SECRETTOKENAAA111') && !text.includes('node-a.invalid'));
  assert.equal(report.providers[0].finality.ok, false);
});

test('M0-8: a missing fee oracle fails the fee gate', async () => {
  const report = await run([A, B], { [A]: { l1Fee: false }, [B]: { l1Fee: false } });
  assert.equal(report.gates.feeEstimation, false);
  assert.equal(report.liveReady, false);
});

test('M0-9: no URLs configured is an error, not an empty pass', async () => {
  await assert.rejects(qualify({ urls: [], fetchImpl: network({}) }), /DAIDAI_RPC_URLS/);
});
