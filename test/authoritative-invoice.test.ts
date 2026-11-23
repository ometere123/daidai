import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chain, cngn, commit, usdt, type Invoice } from '../src/invoice.ts';
import { attest } from '../src/evidence-attestation.ts';
import {
  isAuthoritativeInvoiceProjection, readAuthoritativeInvoice, type ProjectionSources, type StoredAttempt,
} from '../src/authoritative-invoice.ts';

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
const commitment = { tenantId: 'tenant-a', invoiceId: invoice.id, digest };
const fingerprint = { digest, approvalSigner: approver, consentSigner: recipient, expiresAtMs: invoice.expires };
const envelope = { chainId: chain, to: cngn, dataSha256: 'ab'.repeat(32), value: '0' };
const block = '0x' + 'bb'.repeat(32);
const final = '0x' + 'cc'.repeat(32);
const conversionHash = '0x' + '55'.repeat(32);
const payoutHash = '0x' + '66'.repeat(32);

type Op = 'conversion' | 'payout';
export function attempt(operation: Op, patch: Partial<StoredAttempt> = {}): StoredAttempt {
  return attest<StoredAttempt>({
    source: 'attempt-store', ...commitment, operation, id: operation + '-a', lineage: 'recorded', recordedRevision: 7,
    authorization: fingerprint, envelope, hash: operation === 'conversion' ? conversionHash : payoutHash,
    dispatch: 'hash-recorded', closed: null, createdAtMs: nowMs - 100, history: [], ...patch,
  });
}

function harness(revision = 7) {
  const calls: string[] = [];
  const ports = {
    async authorize() {
      calls.push('authorize');
      return { tenantId: commitment.tenantId, invoiceId: invoice.id };
    },
    async readInvoice() {
      calls.push('read');
      return attest({ source: 'invoice-store' as const, tenantId: commitment.tenantId, invoice, digest, revision, observedAtMs: nowMs });
    },
    async observeAuthorization(_: unknown, purpose: 'invoice approval' | 'recipient consent') {
      return attest({ source: 'authorization-verifier' as const, ...commitment, purpose, signer: purpose === 'invoice approval' ? approver : recipient,
        audience: options.expectedAudience, expiresAtMs: invoice.expires, observedAtMs: nowMs });
    },
    async readAttempts(_: unknown, operation: Op): Promise<StoredAttempt[]> {
      return [attempt(operation)];
    },
    async observeTransaction(a: StoredAttempt) {
      const payout = a.operation === 'payout';
      return attest({ source: 'transaction-verifier' as const, ...commitment, revision: a.recordedRevision as number, operation: a.operation,
        attemptId: a.id, hash: a.hash as string, chainId: chain, buyToken: cngn, sellToken: usdt, sender: taker,
        recipient: payout ? recipient : taker, amountAtomic: invoice.buyAmount, debitAtomic: payout ? '0' : invoice.maxSell,
        blockNumber: '100', blockHash: block, success: true, observedAtMs: nowMs });
    },
    async observeCanonicalBlock() {
      return attest({ source: 'canonical-chain-reader' as const, chainId: chain, blockNumber: '100', blockHash: block, blockTimestampMs: nowMs - 50,
        finalizedBlockNumber: '101', finalizedBlockHash: final, observedAtMs: nowMs });
    },
  };
  return { ports, calls };
}
type Ports = ReturnType<typeof harness>['ports'];

function read(ports: unknown, invoiceId = invoice.id, opts = options) {
  // Deliberately bypass the static types to exercise untrusted runtime input.
  return readAuthoritativeInvoice({ viewer, invoiceId }, ports as ProjectionSources<string>, opts);
}
const withTx = (ports: Ports, op: Op | 'both', patch: Record<string, unknown>) => ({
  ...ports,
  observeTransaction: async (a: StoredAttempt) => {
    const base = await ports.observeTransaction(a);
    return op === 'both' || a.operation === op ? attest({ ...base, ...patch }) : base;
  },
});

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
    assert.equal(await read({ ...ports, readInvoice: async () => attest({ ...await ports.readInvoice(), ...patch }) }), null);
  }
});

test('matching independently finalized conversion and payout can settle', async () => {
  const result = await read(harness().ports);
  assert(result);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.source, 'authoritative');
  assert.equal(result.execution, 'disabled');
  assert.equal(result.targetAtomic, invoice.buyAmount);
  assert.equal(result.maxDebitAtomic, invoice.maxSell);
  assert.equal(result.digest, digest);
  assert.equal(result.revision, 7);
  assert.equal(result.approval.state, 'verified');
  assert.equal(result.settlement, 'settled');
  const wire = JSON.parse(JSON.stringify(result));
  assert(isAuthoritativeInvoiceProjection(wire));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, targetAtomic: '01500000000' }));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, source: 'fixture' }));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, schemaVersion: 1 }));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, payout: { state: 'unknown', reason: 'missing-hash', attemptId: 'payout-a' } }));
});

for (const [name, patch] of Object.entries({
  wrongChain: { chainId: 1 }, wrongToken: { buyToken: usdt }, wrongRecipient: { recipient: approver },
  wrongAmount: { amountAtomic: '1499999999' }, wrongRecordedRevision: { revision: 8 }, wrongAttempt: { attemptId: 'another' },
  fixtureEvidence: { source: 'fixture' }, malformedAtomic: { amountAtomic: '01500000000' },
})) {
  test(name + ' evidence cannot establish paid status', async () => {
    const result = await read(withTx(harness().ports, 'payout', patch));
    assert(result);
    assert.notEqual(result.settlement, 'settled');
  });
}

test('over-cap conversion cannot establish settlement', async () => {
  const result = await read(withTx(harness().ports, 'conversion', { debitAtomic: '1200001' }));
  assert(result);
  assert.notEqual(result.settlement, 'settled');
});

test('a source label without the in-process attestation never establishes authority', async () => {
  const { ports } = harness();
  // Same fields, same labels, but plain objects (e.g. parsed from JSON or supplied by a client).
  const plain = <T>(v: T) => JSON.parse(JSON.stringify(v)) as T;
  assert.equal(await read({ ...ports, readInvoice: async () => plain(await ports.readInvoice()) }), null);
  for (const port of ['observeTransaction', 'observeCanonicalBlock', 'observeAuthorization', 'readAttempts'] as const) {
    const forged = { ...ports, [port]: async (...args: unknown[]) => plain(await (ports[port] as (...a: unknown[]) => Promise<unknown>)(...args)) };
    const result = await read(forged);
    assert(result, port);
    assert.notEqual(result.settlement, 'settled', port);
  }
});

for (const [name, patch] of Object.entries({
  reorg: { blockHash: conversionHash }, notFinalized: { finalizedBlockNumber: '99' }, stale: { observedAtMs: nowMs - 1001 },
})) {
  test(name + ' chain observation cannot establish settlement', async () => {
    const { ports } = harness();
    const result = await read({ ...ports, observeCanonicalBlock: async () => attest({ ...await ports.observeCanonicalBlock(), ...patch }) });
    assert(result);
    assert.notEqual(result.settlement, 'settled');
  });
}

test('wrong-purpose consent cannot establish settlement', async () => {
  const { ports } = harness();
  const result = await read({ ...ports, observeAuthorization: async (b: unknown, purpose: 'invoice approval' | 'recipient consent') =>
    attest({ ...await ports.observeAuthorization(b, purpose), ...(purpose === 'recipient consent' ? { purpose: 'invoice approval' } : {}) }) });
  assert(result);
  assert.equal(result.consent.state, 'unverified');
  assert.notEqual(result.settlement, 'settled');
});

test('missing payout hash retains attempt and does not ask for payout transaction proof or settle', async () => {
  const { ports } = harness();
  const result = await read({
    ...ports,
    readAttempts: async (_: unknown, operation: Op) => [attempt(operation, operation === 'payout' ? { hash: null, dispatch: 'outcome-unknown' } : {})],
    observeTransaction: async (a: StoredAttempt) => {
      assert.equal(a.operation, 'conversion');
      return ports.observeTransaction(a);
    },
  });
  assert(result);
  assert.equal(result.payout.state, 'unknown');
  assert.equal(result.payout.reason, 'missing-hash');
  assert.equal(result.settlement, 'reconciliation-required');
  assert.match(JSON.stringify(result.payout), /payout-a/);
});

test('projection does not forward private payloads from any source', async () => {
  const { ports } = harness();
  const result = await read({
    ...ports,
    readInvoice: async () => attest({ ...await ports.readInvoice(), privateConfig: 'private-invoice-marker' }),
    observeAuthorization: async (b: unknown, purpose: 'invoice approval' | 'recipient consent') =>
      attest({ ...await ports.observeAuthorization(b, purpose), signature: 'private-signature-marker' }),
    observeTransaction: async (a: StoredAttempt) => attest({ ...await ports.observeTransaction(a), calldata: 'private-calldata-marker' }),
  });
  assert(result);
  assert.doesNotMatch(JSON.stringify(result), /private-.*-marker/);
});

// ------------------------------------------------------------------ P10.3: lineage

test('mixed revisions: attempts keep their recorded revision while the invoice advances, and still settle', async () => {
  const { ports } = harness(12);
  const result = await read({
    ...ports,
    readAttempts: async (_: unknown, operation: Op) => [attempt(operation, { recordedRevision: operation === 'conversion' ? 4 : 9 })],
  });
  assert(result);
  assert.equal(result.revision, 12);
  assert.equal(result.conversion.recordedRevision, 4);
  assert.equal(result.payout.recordedRevision, 9);
  assert.equal(result.settlement, 'settled');
  assert(isAuthoritativeInvoiceProjection(JSON.parse(JSON.stringify(result))));
});

test('evidence relabelled with the newest revision is rejected (no automatic relabelling of old attempts)', async () => {
  const { ports } = harness(12);
  const result = await read(withTx({ ...ports,
    readAttempts: async (_: unknown, operation: Op) => [attempt(operation, { recordedRevision: 4 })],
  } as Ports, 'both', { revision: 12 }));
  assert(result);
  assert.equal(result.conversion.state, 'reconciliation-required');
  assert.notEqual(result.settlement, 'settled');
});

test('an attempt claiming a revision newer than the committed invoice is a mismatch', async () => {
  const { ports } = harness(3);
  const result = await read({ ...ports, readAttempts: async (_: unknown, operation: Op) => [attempt(operation, { recordedRevision: 7 })] });
  assert(result);
  assert.equal(result.payout.reason, 'mismatch');
  assert.notEqual(result.settlement, 'settled');
});

test('unresolved legacy lineage is retained for reconciliation and never settles', async () => {
  const { ports } = harness();
  const legacy = attempt('payout', { id: 'legacy-payout', lineage: 'unresolved', recordedRevision: null, authorization: null, envelope: null, hash: null, dispatch: 'outcome-unknown' });
  const result = await read({ ...ports, readAttempts: async (_: unknown, operation: Op) => operation === 'payout' ? [legacy] : [attempt('conversion')] });
  assert(result);
  assert.equal(result.payout.state, 'reconciliation-required');
  assert.equal(result.payout.reason, 'lineage-unresolved');
  assert.equal(result.payout.attemptId, 'legacy-payout');
  assert.equal(result.settlement, 'reconciliation-required');
});

test('two open attempts for one operation fail closed as multiple-attempts', async () => {
  const { ports } = harness();
  const result = await read({ ...ports, readAttempts: async (_: unknown, operation: Op) =>
    operation === 'payout' ? [attempt('payout'), attempt('payout', { id: 'payout-b', hash: '0x' + '77'.repeat(32) })] : [attempt('conversion')] });
  assert(result);
  assert.equal(result.payout.reason, 'multiple-attempts');
  assert.equal(result.settlement, 'reconciliation-required');
});

test('a reconciled-not-landed claim is not trusted: the earlier attempt still counts and settlement fails closed', async () => {
  const { ports } = harness();
  const result = await read({ ...ports, readAttempts: async (_: unknown, operation: Op) => operation === 'payout'
    ? [attempt('payout', { id: 'payout-old', hash: null, closed: 'reconciled-not-landed', dispatch: 'outcome-unknown' }), attempt('payout')]
    : [attempt('conversion')] });
  assert(result);
  assert.equal(result.payout.state, 'reconciliation-required');
  assert.equal(result.payout.reason, 'multiple-attempts');
  assert.equal(result.settlement, 'reconciliation-required');
});

test('cross-tenant or cross-commitment attempts are a mismatch', async () => {
  for (const patch of [{ tenantId: 'tenant-b' }, { digest: 'ef'.repeat(32) }, { invoiceId: 'invoice-b' }]) {
    const { ports } = harness();
    const result = await read({ ...ports, readAttempts: async (_: unknown, operation: Op) => [attempt(operation, operation === 'payout' ? patch : {})] });
    assert(result);
    assert.equal(result.payout.reason, 'mismatch');
  }
});

// ------------------------------------------------------------------ P10.3: historical authorization semantics

test('an authorization that expired after both finalized executions is verified-at-execution and settles', async () => {
  const later = { ...options, nowMs: invoice.expires + 10_000 };
  const { ports } = harness();
  const refreshed = {
    ...ports,
    readInvoice: async () => attest({ ...await ports.readInvoice(), observedAtMs: later.nowMs }),
    observeAuthorization: async (b: unknown, p: 'invoice approval' | 'recipient consent') => attest({ ...await ports.observeAuthorization(b, p), observedAtMs: later.nowMs }),
    observeTransaction: async (a: StoredAttempt) => attest({ ...await ports.observeTransaction(a), observedAtMs: later.nowMs }),
    observeCanonicalBlock: async () => attest({ ...await ports.observeCanonicalBlock(), observedAtMs: later.nowMs, blockTimestampMs: invoice.expires - 1 }),
  };
  const result = await read(refreshed, invoice.id, later);
  assert(result);
  assert.equal(result.approval.state, 'verified-at-execution');
  assert.equal(result.consent.state, 'verified-at-execution');
  assert.equal(result.consent.executedAtMs, invoice.expires - 1);
  assert.equal(result.settlement, 'settled');
  assert(isAuthoritativeInvoiceProjection(JSON.parse(JSON.stringify(result))));
  // The wire validator recomputes execution time from the operations; a tampered value is rejected.
  const wire = JSON.parse(JSON.stringify(result));
  assert(!isAuthoritativeInvoiceProjection({ ...wire, consent: { ...wire.consent, executedAtMs: invoice.expires - 1000 } }));
});

test('execution at or after expiry stays stale-expired and cannot settle', async () => {
  const later = { ...options, nowMs: invoice.expires + 10_000 };
  const { ports } = harness();
  const result = await read({
    ...ports,
    readInvoice: async () => attest({ ...await ports.readInvoice(), observedAtMs: later.nowMs }),
    observeAuthorization: async (b: unknown, p: 'invoice approval' | 'recipient consent') => attest({ ...await ports.observeAuthorization(b, p), observedAtMs: later.nowMs }),
    observeTransaction: async (a: StoredAttempt) => attest({ ...await ports.observeTransaction(a), observedAtMs: later.nowMs }),
    observeCanonicalBlock: async () => attest({ ...await ports.observeCanonicalBlock(), observedAtMs: later.nowMs, blockTimestampMs: invoice.expires }),
  }, invoice.id, later);
  assert(result);
  assert.equal(result.consent.state, 'stale');
  assert.equal(result.consent.reason, 'expired');
  assert.notEqual(result.settlement, 'settled');
});

test('an expired authorization without finalized execution evidence is stale, not historical', async () => {
  const result = await readAuthoritativeInvoice({ viewer, invoiceId: invoice.id }, {
    ...harness().ports,
    readAttempts: async (_: unknown, operation: Op) => operation === 'payout' ? [] : [attempt('conversion')],
  } as unknown as ProjectionSources<string>, { ...options, nowMs: invoice.expires });
  assert(result);
  assert.equal(result.consent.state, 'stale');
  assert.equal(result.consent.reason, 'expired');
  assert.notEqual(result.settlement, 'settled');
});

test('an attempt claimed under a different authorization makes the authorization unverified', async () => {
  for (const patch of [
    { authorization: { ...fingerprint, expiresAtMs: invoice.expires + 1 } },
    { authorization: { ...fingerprint, consentSigner: approver } },
    { authorization: null, lineage: 'recorded' as const },
    { createdAtMs: invoice.expires },
  ]) {
    const { ports } = harness();
    const result = await read({ ...ports, readAttempts: async (_: unknown, operation: Op) => [attempt(operation, operation === 'payout' ? patch : {})] });
    assert(result);
    assert.notEqual(result.settlement, 'settled', JSON.stringify(patch));
  }
});
