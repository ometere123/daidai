import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cngn, usdt } from '../src/invoice-core.ts';
import type { Revision } from '../src/product-contract.ts';
import { preparePreview, simulatedTextilePreview } from '../src/product-quote.ts';

const now = 100_000;
const invoice: Revision = { id: 'ab'.repeat(16), revision: 2, state: 'committed', digest: 'ab'.repeat(32), at: now - 1,
  target: '1500000000', cap: '1001000', expiry: now + 60_000, recipient: '0x' + '12'.repeat(20), approver: '0x' + '34'.repeat(20) };
const indicative = { status: 'preview', buyAmount: invoice.target, takerPays: invoice.cap, feeAmount: '1000' };

test('preview binds the exact corridor and target with no signing, taker or transaction fields', async () => {
  const quote = await preparePreview(invoice, async req => {
    assert.deepEqual(req, { chainId: 42220, sellToken: usdt, buyToken: cngn, buyAmount: invoice.target });
    return simulatedTextilePreview(req);
  }, () => now);
  assert.deepEqual(quote, { kind: 'indicative', base: '1000000', debit: '1001000', fee: '1000', reviewUntil: now + 30_000 });
});
for (const [label, data, kind] of [
  ['over-cap all-in debit', { ...indicative, takerPays: '1001001' }, 'over-cap'],
  ['wrong cNGN output', { ...indicative, buyAmount: '1499999999' }, 'invalid'],
  ['fee greater than debit', { ...indicative, feeAmount: '1001001' }, 'invalid'],
  ['firm quote payload', { ...indicative, status: 'quoted' }, 'invalid'],
  ['no maker liquidity', { status: 'no_quote' }, 'unavailable'],
] as const) {
  test(label, async () => assert.deepEqual(await preparePreview(invoice, async () => ({ data }), () => now), { kind }));
}
test('an expired commitment never calls preview and delayed responses are discarded', async () => {
  let calls = 0;
  const expired = { ...invoice, expiry: now };
  assert.deepEqual(await preparePreview(expired, async () => { calls++; }, () => now), { kind: 'expired' });
  assert.equal(calls, 0);
  let t = now;
  assert.deepEqual(await preparePreview(invoice, async () => { t += 30_000; return { data: indicative }; }, () => t), { kind: 'expired' });
});
