import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appEnabled } from '../apps/web/lib/app-gate.ts';
import { observeRegistration, registration } from '../src/public-registration.ts';
import { reviewDecisions } from '../src/review-decisions.ts';
import { tag } from '../src/invoice-core.ts';
import type { Rpc } from '../src/chain-evidence.ts';

const height = '0x4', blockHash = '0x' + 'af'.repeat(32);
const topic = (s: string) => '0x' + s.padStart(64, '0');
const event = { address: registration.registry, transactionHash: registration.hash, blockHash, data: '0x',
  topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic('0'), topic(registration.wallet.slice(2)), topic(registration.agent.toString(16))] };
const tx = { blockNumber: height, blockHash, from: registration.wallet, to: registration.registry };
function rpc(flags: { missing?: boolean; reorg?: boolean; badToken?: boolean; nonfinal?: boolean } = {}): Rpc {
  let reads = 0;
  return async (method, params) => {
    if (method === 'eth_chainId') return '0xa4ec';
    if (method === 'eth_getTransactionByHash') return { ...tx, hash: registration.hash, value: '0x0', input: tag('0xabcd', 'celo_597f1146c487') };
    if (method === 'eth_getTransactionReceipt') return flags.missing ? null : { ...tx, transactionHash: registration.hash, status: '0x1',
      logs: [{ ...event, ...(flags.badToken ? { address: registration.wallet } : {}) }] };
    return params[0] === 'finalized' ? { number: flags.nonfinal ? '0x3' : '0x5', hash: blockHash }
      : { number: height, hash: flags.reorg && ++reads > 1 ? '0x' + 'ab'.repeat(32) : blockHash };
  };
}

test('public Vercel profile overrides private and preview enable flags', () => {
  for (const env of ['production','preview','development']) assert.equal(appEnabled({
    VERCEL_ENV: env, NODE_ENV: 'development', DAIDAI_PUBLIC_RELEASE: '1', DAIDAI_APP_ENABLED: '1', DAIDAI_PREVIEW_ACCESS: '1',
  }), false);
});
test('public registration requires independent canonical, finalized mint evidence', async () => {
  assert.equal((await observeRegistration({ A: rpc(), B: rpc() })).status, 'independently verified');
  for (const flags of [{ missing: true }, { reorg: true }, { badToken: true }, { nonfinal: true }]) {
    assert.equal((await observeRegistration({ A: rpc(), B: rpc(flags) })).status, 'unresolved');
  }
});
test('quote and payout conclusions stay separate from authorization and unknown attempts', () => {
  const rules = reviewDecisions({ quote: 'over-cap', conversion: 'verified', payout: 'unknown',
    observedAt: 123, correlation: 'invoice-1', provenance: 'invoice projection' });
  assert.deepEqual(rules.map(rule => rule.outcome), ['blocked','unresolved','blocked','unresolved','unresolved','blocked']);
  assert(rules.every(r => r.correlation === 'invoice-1' && r.observedAt === 123));
});
