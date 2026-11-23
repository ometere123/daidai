import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chain, cngn, commit, usdt, type Invoice } from '../src/invoice.ts';
import { isAuthoritativeInvoiceProjection, readAuthoritativeInvoice, type ProjectionSources } from '../src/authoritative-invoice.ts';

const nowMs = 2_000_000;
const options = { nowMs, maxObservationAgeMs: 1_000, expectedAudience: 'https://daidai.example' };
const viewer = 'viewer-a';
const recipient = '0x' + '22'.repeat(20);
const taker = '0x' + '33'.repeat(20);
const approver = '0x' + '44'.repeat(20);
const invoice: Invoice = {
  id: 'invoice-a', version: 1, source: 'invoice-source', nonce: '12'.repeat(16),
  chain, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6,
  buyAmount: '1500000000', recipient, maxSell: '1200000', approver, taker, expires: nowMs + 500,
};
const digest = commit(invoice).digest;
const binding = { tenantId: 'tenant-a', invoiceId: invoice.id, revision: 7, digest };
const block = '0x' + 'bb'.repeat(32);
const final = '0x' + 'cc'.repeat(32);
const conversionHash = '0x' + '55'.repeat(32);
const payoutHash = '0x' + '66'.repeat(32);

function harness() {
  const calls: string[] = [];
  const ports = {
    async authorize() {
      calls.push('authorize');
      return { tenantId: binding.tenantId, invoiceId: invoice.id };
    },
    async readInvoice() {
      calls.push('read');
      return { source: 'invoice-store', tenantId: binding.tenantId, invoice, digest, revision: 7, observedAtMs: nowMs };
    },
    async observeAuthorization(_: unknown, purpose: 'invoice approval' | 'recipient consent') {
      return { source: 'authorization-verifier', ...binding, purpose, signer: purpose === 'invoice approval' ? approver : recipient,
        audience: options.expectedAudience, expiresAtMs: nowMs + 500, observedAtMs: nowMs };
    },
    async readAttempt(_: unknown, operation: 'conversion' | 'payout') {
      return { source: 'attempt-store', ...binding, operation, id: operation + '-a', hash: operation === 'conversion' ? conversionHash : payoutHash };
    },
    async observeTransaction(attempt: { operation: 'conversion' | 'payout'; id: string; hash: string }) {
      const payout = attempt.operation === 'payout';
      return { source: 'transaction-verifier', ...binding, operation: attempt.operation, attemptId: attempt.id, hash: attempt.hash,
        chainId: chain, buyToken: cngn, sellToken: usdt, sender: taker, recipient: payout ? recipient : taker,
        amountAtomic: invoice.buyAmount, debitAtomic: payout ? '0' : invoice.maxSell,
        blockNumber: '100', blockHash: block, success: true, observedAtMs: nowMs };
    },
    async observeCanonicalBlock() {
      return { source: 'canonical-chain-reader', chainId: chain, blockNumber: '100', blockHash: block,
        finalizedBlockNumber: '101', finalizedBlockHash: final, observedAtMs: nowMs };
    },
  };
  return { ports, calls };
}

function read(ports: unknown, invoiceId = invoice.id) {
  // Deliberately bypass the static types to exercise untrusted runtime input.
  return readAuthoritativeInvoice({ viewer, invoiceId }, ports as ProjectionSources<string>, options);
}

test('authorization precedes access and absent or cross-invoice grants read nothing', async () => {
  const a = harness();
  assert.equal(await read(a.ports, 'another-invoice'), null);
  assert.deepEqual(a.calls, ['authorize']);
  const b = harness();
  assert.equal(await read({ ...b.ports, authorize: async () => null }), null);
  assert.deepEqual(b.calls, []);
});

test('server snapshot binds digest and tenant and rejects fixture data', async () => {
  for (const patch of [{ source: 'fixture' }, { tenantId: 'tenant-b' }, { digest: '0'.repeat(64) }]) {
    const { ports } = harness();
    assert.equal(await read({ ...ports, readInvoice: async () => ({ ...await ports.readInvoice(), ...patch }) }), null);
  }
});

test('matching independently finalized conversion and payout can settle', async () => {
  const result = await read(harness().ports);
  assert(result);
  assert.equal(result.source, 'authoritative');
  assert.equal(result.execution, 'disabled');
  assert.equal(result.targetAtomic, invoice.buyAmount);
  assert.equal(result.maxDebitAtomic, invoice.maxSell);
  assert.equal(result.digest, digest);
  assert.equal(result.revision, 7);
  assert.equal(result.settlement, 'settled');
  const wire = JSON.parse(JSON.stringify(result));
  assert(isAuthoritativeInvoiceProjection(wire));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, targetAtomic: '01500000000' }));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, source: 'fixture' }));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, payout: { state: 'unknown', reason: 'missing-hash', attemptId: 'payout-a' } }));
});

for (const [name, patch] of Object.entries({
  wrongChain: { chainId: 1 }, wrongToken: { buyToken: usdt }, wrongRecipient: { recipient: approver },
  wrongAmount: { amountAtomic: '1499999999' }, mixedRevision: { revision: 8 }, wrongAttempt: { attemptId: 'another' },
  fixtureEvidence: { source: 'fixture' }, malformedAtomic: { amountAtomic: '01500000000' },
})) {
  test(name + ' evidence cannot establish paid status', async () => {
    const { ports } = harness();
    const result = await read({ ...ports, observeTransaction: async (attempt: Parameters<typeof ports.observeTransaction>[0]) => ({
      ...await ports.observeTransaction(attempt), ...(attempt.operation === 'payout' ? patch : {}),
    }) });
    assert(result);
    assert.notEqual(result.settlement, 'settled');
  });
}

test('over-cap conversion cannot establish settlement', async () => {
  const { ports } = harness();
  const result = await read({ ...ports, observeTransaction: async (attempt: Parameters<typeof ports.observeTransaction>[0]) => ({
    ...await ports.observeTransaction(attempt), ...(attempt.operation === 'conversion' ? { debitAtomic: '1200001' } : {}),
  }) });
  assert(result);
  assert.notEqual(result.settlement, 'settled');
});

for (const [name, patch] of Object.entries({
  reorg: { blockHash: conversionHash }, notFinalized: { finalizedBlockNumber: '99' }, stale: { observedAtMs: nowMs - 1001 },
})) {
  test(name + ' chain observation cannot establish settlement', async () => {
    const { ports } = harness();
    const result = await read({ ...ports, observeCanonicalBlock: async () => ({ ...await ports.observeCanonicalBlock(), ...patch }) });
    assert(result);
    assert.notEqual(result.settlement, 'settled');
  });
}

test('expired or wrong-purpose consent cannot establish settlement', async () => {
  for (const patch of [{ expiresAtMs: nowMs }, { purpose: 'invoice approval' }]) {
    const { ports } = harness();
    const result = await read({ ...ports, observeAuthorization: async (b: unknown, purpose: 'invoice approval' | 'recipient consent') => ({
      ...await ports.observeAuthorization(b, purpose), ...(purpose === 'recipient consent' ? patch : {}),
    }) });
    assert(result);
    assert.notEqual(result.settlement, 'settled');
  }
});

test('missing payout hash retains attempt and does not ask for payout transaction proof or settle', async () => {
  const { ports } = harness();
  const result = await read({
    ...ports,
    readAttempt: async (b: unknown, operation: 'conversion' | 'payout') => ({
      ...await ports.readAttempt(b, operation), ...(operation === 'payout' ? { hash: null } : {}),
    }),
    observeTransaction: async (attempt: Parameters<typeof ports.observeTransaction>[0]) => {
      assert.equal(attempt.operation, 'conversion');
      return ports.observeTransaction(attempt);
    },
  });
  assert(result);
  assert.notEqual(result.settlement, 'settled');
  assert.match(JSON.stringify(result.payout), /payout-a/);
});

test('projection does not forward private payloads from any source', async () => {
  const { ports } = harness();
  const result = await read({
    ...ports,
    readInvoice: async () => ({ ...await ports.readInvoice(), privateConfig: 'private-invoice-marker' }),
    observeAuthorization: async (b: unknown, purpose: 'invoice approval' | 'recipient consent') => ({
      ...await ports.observeAuthorization(b, purpose), signature: 'private-signature-marker',
    }),
    observeTransaction: async (attempt: Parameters<typeof ports.observeTransaction>[0]) => ({
      ...await ports.observeTransaction(attempt), calldata: 'private-calldata-marker',
    }),
  });
  assert(result);
  assert.doesNotMatch(JSON.stringify(result), /private-.*-marker/);
});

test('an actually expired commitment is stale at the expiry boundary', async () => {
  const result = await readAuthoritativeInvoice({ viewer, invoiceId: invoice.id },
    harness().ports as unknown as ProjectionSources<string>, { ...options, nowMs: invoice.expires });
  assert(result);
  assert.equal(result.consent.state, 'stale');
  assert.equal(result.consent.reason, 'expired');
  assert.notEqual(result.settlement, 'settled');
});
