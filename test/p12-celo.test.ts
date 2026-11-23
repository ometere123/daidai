import { test } from 'node:test';
import assert from 'node:assert/strict';
import { celoQuorum } from '../src/celo-quorum.ts';
import type { Rpc } from '../src/chain-evidence.ts';

const block = (number: string, byte = 'ab') => ({ number, hash: '0x' + byte.repeat(32), timestamp: '0x4' });
const reader = (head: string, opts: { chain?: string; canonical?: string; result?: unknown; timeout?: boolean } = {}): Rpc =>
  async (m, args) => {
    if (opts.timeout) throw Error('timeout');
    if (m === 'eth_chainId') return opts.chain ?? '0xa4ec';
    if (m === 'eth_getBlockByNumber') return args[0] === 'finalized' ? block(head) : block(String(args[0]), opts.canonical);
    return Object.hasOwn(opts, 'result') ? opts.result : { status: '0x1', logs: [] };
  };
test('uses the lowest agreed canonical finalized head across different provider heights', async () => {
  const rpc = celoQuorum([reader('0xa'), reader('0xb')]);
  assert.equal(await rpc('eth_chainId', []), '0xa4ec');
  assert.deepEqual(await rpc('eth_getBlockByNumber', ['finalized', false]), block('0xa'));
});
test('rejects missing receipt, timeout, conflicting logs, wrong chain and canonical reorg independently', async () => {
  const good = reader('0xa');
  for (const bad of [reader('0xa', { result: null }), reader('0xa', { result: { status: '0x1', logs: [{ address: 'wrong' }] } }), reader('0xa', { timeout: true })]) {
    await assert.rejects(celoQuorum([good, bad])('eth_getTransactionReceipt', []));
  }
  await assert.rejects(celoQuorum([good, reader('0xa', { chain: '0x1' })])('eth_chainId', []), /wrong chain/);
  await assert.rejects(celoQuorum([good, reader('0xa', { canonical: 'ff' })])('eth_getBlockByNumber', ['finalized', false]));
  await assert.rejects(celoQuorum([good, reader('0xa')])('eth_sendTransaction', []), /not allowed/);
});
