import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { authorizationMessage, verifyAuthorization } from '../src/authorization.ts';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf } from '../src/attempt-lineage.ts';
import { readAuthoritativeInvoice, type CommitmentBinding, type ProjectionSources } from '../src/authoritative-invoice.ts';
import {
  authorizationObserver, canonicalBlockReader, invoiceSnapshotReader, readOnlyRpc, transactionVerifier,
} from '../src/evidence-adapters.ts';
import { chain, cngn, commit, reactor, Spike, tag, usdt, type Invoice } from '../src/invoice.ts';
import { authenticateViewer, invoiceViewerAuthorizer, isAuthenticatedViewer, type PermissionStore } from '../src/viewer-access.ts';

const code = 'daidai';
const audience = 'https://daidai.example';
const approverKey = privateKeyToAccount(generatePrivateKey());
const recipientKey = privateKeyToAccount(generatePrivateKey());
const taker = '0x' + '33'.repeat(20);
const recipient = recipientKey.address.toLowerCase();
const T0 = 1_800_000_000_000;
const invoice: Invoice = {
  id: 'invoice-a', version: 1, source: 'invoice-source', nonce: '12'.repeat(16),
  chain, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6,
  buyAmount: '150000000000', recipient, maxSell: '105000000', approver: approverKey.address.toLowerCase(), taker, expires: T0 + 3_600_000,
};
const { digest } = commit(invoice);

// ------------------------------------------------------------------ fake chain behind the read-only guard

const transferLog = (token: string, from: string, to: string, value: bigint, txHash: Hex, blockHash: Hex, index: number) => ({
  address: token, removed: false, transactionHash: txHash, blockHash, logIndex: ('0x' + index.toString(16)) as Hex,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }) as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
type FakeTx = { hash: Hex; to: string; input: Hex; from: string; blockNumber: bigint; logs: ReturnType<typeof transferLog>[]; status?: string };
function fakeChain(opts: { finalized: bigint; blocks: Record<string, { hash: Hex; timestampS: number }>; txs: FakeTx[]; chainId?: string }) {
  const calls: string[] = [];
  const rpc = async (method: string, params: readonly unknown[]) => {
    calls.push(method);
    if (method === 'eth_chainId') return opts.chainId ?? '0xa4ec';
    const findTx = (h: unknown) => opts.txs.find(t => t.hash === h);
    const blockHashOf = (n: bigint) => opts.blocks[n.toString()]?.hash;
    if (method === 'eth_getTransactionByHash') {
      const t = findTx(params[0]); if (!t) return null;
      return { hash: t.hash, blockHash: blockHashOf(t.blockNumber), blockNumber: '0x' + t.blockNumber.toString(16), chainId: '0xa4ec',
        from: t.from, to: t.to, input: t.input, value: '0x0' };
    }
    if (method === 'eth_getTransactionReceipt') {
      const t = findTx(params[0]); if (!t) return null;
      return { transactionHash: t.hash, blockHash: blockHashOf(t.blockNumber), blockNumber: '0x' + t.blockNumber.toString(16),
        from: t.from, to: t.to, status: t.status ?? '0x1', logs: t.logs };
    }
    if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? opts.finalized : BigInt(String(params[0]));
      const b = opts.blocks[n.toString()]; if (!b) return null;
      return { number: '0x' + n.toString(16), hash: b.hash, timestamp: '0x' + b.timestampS.toString(16) };
    }
    throw Error('unexpected method ' + method);
  };
  return { rpc, calls };
}

// ------------------------------------------------------------------ server composition used by the tests

const permissions = (grants: Record<string, string[]>, owners: Record<string, string>): PermissionStore => ({
  async canReadInvoice(tenantId, viewerId, invoiceId) { return (grants[tenantId + '/' + viewerId] ?? []).includes(invoiceId); },
  async tenantOfInvoice(invoiceId) { return owners[invoiceId] ?? null; },
});
const sessions = { async verify(credential: string, nowMs: number) {
  const known: Record<string, { viewerId: string; tenantId: string }> = {
    'session-alice': { viewerId: 'alice', tenantId: 'tenant-a' }, 'session-mallory': { viewerId: 'mallory', tenantId: 'tenant-b' },
    'session-bob': { viewerId: 'bob', tenantId: 'tenant-a' },
  };
  const s = known[credential]; return s ? { ...s, authenticatedAtMs: nowMs - 1, expiresAtMs: nowMs + 60_000 } : null;
} };

function world(t: { after: (fn: () => void) => void }, scenario: { executeAtS?: number; payoutAmount?: bigint } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'daidai-p103-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Invoice store: the real harness. Revisions advance as the record moves.
  const spike = new Spike(join(dir, 'invoices.db'), undefined, code);
  spike.create(invoice);
  return { dir, spike, async build(now: number) {
    const sigs = {
      approval: await approverKey.signTypedData(authorizationMessage(invoice, digest, 'invoice approval', audience)),
      consent: await recipientKey.signTypedData(authorizationMessage(invoice, digest, 'recipient consent', audience)),
    };
    return sigs;
  } };
}

// ------------------------------------------------------------------ viewer access

test('viewer access: only server-minted viewers with an explicit, same-tenant permission get a grant', async () => {
  const now = T0;
  const authorize = invoiceViewerAuthorizer(permissions({ 'tenant-a/alice': ['invoice-a'], 'tenant-b/mallory': ['invoice-a'] },
    { 'invoice-a': 'tenant-a' }), () => now);
  const alice = await authenticateViewer(sessions, 'session-alice', now);
  const bob = await authenticateViewer(sessions, 'session-bob', now);
  const mallory = await authenticateViewer(sessions, 'session-mallory', now);
  assert(alice && bob && mallory && isAuthenticatedViewer(alice));
  assert.deepEqual(await authorize(alice, 'invoice-a'), { tenantId: 'tenant-a', invoiceId: 'invoice-a' });
  assert.equal(await authorize(bob, 'invoice-a'), null, 'same tenant without a permission');
  assert.equal(await authorize(mallory, 'invoice-a'), null, 'cross-tenant even with a stray grant row');
  assert.equal(await authorize(alice, 'invoice-b'), null, 'unknown invoice');
  // Client-built look-alikes, JSON round trips and wallet/consent artefacts are not viewers.
  assert.equal(await authorize({ ...alice }, 'invoice-a'), null);
  assert.equal(await authorize(JSON.parse(JSON.stringify(alice)), 'invoice-a'), null);
  assert.equal(await authorize({ tenantId: 'tenant-a', invoiceId: 'invoice-a' }, 'invoice-a'), null);
  assert.equal(await authorize({ address: invoice.approver, signature: '0x' + '11'.repeat(65) }, 'invoice-a'), null);
  assert.equal(await authenticateViewer(sessions, 'forged-session', now), null);
  assert.equal(await authenticateViewer(sessions, { viewerId: 'alice' } as unknown as string, now), null);
  // Expired sessions stop working.
  const later = invoiceViewerAuthorizer(permissions({ 'tenant-a/alice': ['invoice-a'] }, { 'invoice-a': 'tenant-a' }), () => now + 60_001);
  assert.equal(await later(alice, 'invoice-a'), null);
  // A failing permission store fails closed.
  const broken = invoiceViewerAuthorizer({ canReadInvoice: async () => { throw Error('down'); }, tenantOfInvoice: async () => 'tenant-a' }, () => now);
  assert.equal(await broken(alice, 'invoice-a'), null);
});

test('unauthorized and cross-tenant reads never touch invoice data', async () => {
  const now = T0;
  const reads: string[] = [];
  const sources = {
    authorize: invoiceViewerAuthorizer(permissions({ 'tenant-a/alice': ['invoice-a'] }, { 'invoice-a': 'tenant-a' }), () => now),
    readInvoice: async () => { reads.push('invoice'); return null; },
    observeAuthorization: async () => { reads.push('auth'); return null; },
    readAttempts: async () => { reads.push('attempts'); return []; },
    observeTransaction: async () => { reads.push('tx'); return null; },
    observeCanonicalBlock: async () => { reads.push('block'); return null; },
  } as unknown as ProjectionSources<unknown>;
  const opts = { nowMs: now, maxObservationAgeMs: 60_000, expectedAudience: audience };
  for (const viewer of [await authenticateViewer(sessions, 'session-mallory', now), await authenticateViewer(sessions, 'session-bob', now),
    { viewerId: 'alice', tenantId: 'tenant-a' }, null, 'alice']) {
    assert.equal(await readAuthoritativeInvoice({ viewer, invoiceId: 'invoice-a' }, sources, opts), null);
  }
  assert.deepEqual(reads, []);
});

// ------------------------------------------------------------------ adapters

test('the RPC guard refuses every write, signing or wallet method', async () => {
  const seen: string[] = [];
  const guarded = readOnlyRpc(async m => { seen.push(m); return null; });
  for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4',
    'wallet_switchEthereumChain', 'eth_requestAccounts', 'eth_call', 'eth_estimateGas']) {
    await assert.rejects(guarded(method, []), /read-only RPC/);
  }
  assert.deepEqual(seen, []);
  await guarded('eth_chainId', []);
  assert.deepEqual(seen, ['eth_chainId']);
});

test('authorization observer recovers real EIP-712 signers and rejects swapped, foreign or wrong-audience signatures', async t => {
  const w = world(t);
  const sigs = await w.build(T0);
  const snapshot = invoiceSnapshotReader(join(w.dir, 'invoices.db'), async () => 'tenant-a', () => T0);
  t.after(() => snapshot.close());
  const binding: CommitmentBinding = { tenantId: 'tenant-a', invoiceId: invoice.id, digest };
  const snap = (b: CommitmentBinding) => snapshot.readInvoice(b);
  const observe = authorizationObserver(async () => sigs, snap, audience, () => T0);
  const approval = await observe(binding, 'invoice approval');
  const consent = await observe(binding, 'recipient consent');
  assert.equal(approval?.signer, invoice.approver);
  assert.equal(consent?.signer, recipient);
  assert.equal(consent?.expiresAtMs, invoice.expires);
  // Swapped signatures, a stranger's signature, another audience, another digest: all rejected.
  assert.equal(await authorizationObserver(async () => ({ approval: sigs.consent, consent: sigs.approval }), snap, audience, () => T0)(binding, 'invoice approval'), null);
  const stranger = privateKeyToAccount(generatePrivateKey());
  const strangerSig = await stranger.signTypedData(authorizationMessage(invoice, digest, 'recipient consent', audience));
  assert.equal(await authorizationObserver(async () => ({ ...sigs, consent: strangerSig }), snap, audience, () => T0)(binding, 'recipient consent'), null);
  assert.equal(await authorizationObserver(async () => sigs, snap, 'https://evil.example', () => T0)(binding, 'recipient consent'), null);
  assert.equal(await observe({ ...binding, digest: 'ef'.repeat(32) }, 'recipient consent'), null);
  assert.equal(await observe({ ...binding, tenantId: 'tenant-b' }, 'recipient consent'), null);
});

test('invoice snapshot reader re-derives the commitment and refuses other tenants', async t => {
  const w = world(t);
  const reader = invoiceSnapshotReader(join(w.dir, 'invoices.db'), async id => id === 'invoice-a' ? 'tenant-a' : null, () => T0);
  t.after(() => reader.close());
  const s = await reader.readInvoice({ tenantId: 'tenant-a', invoiceId: 'invoice-a' });
  assert.equal(s?.digest, digest);
  assert.equal(s?.revision, 0);
  assert.equal(await reader.readInvoice({ tenantId: 'tenant-b', invoiceId: 'invoice-a' }), null);
  assert.equal(await reader.readInvoice({ tenantId: 'tenant-a', invoiceId: 'invoice-z' }), null);
});

// ------------------------------------------------------------------ end to end (read-only; nothing is dispatched)

async function endToEnd(t: { after: (fn: () => void) => void }, o: {
  nowMs: number; executeAtMs: number; payoutAmount?: bigint; conversionDebit?: bigint; payoutBlock?: bigint; finalized?: bigint;
  tamperPayoutData?: boolean; noAttribution?: boolean;
}) {
  const w = world(t);
  const sigs = await w.build(o.nowMs);
  // Advance the invoice record through verified authorization (revision 1) and a quote request (revision 2).
  const verifiedAuth = await verifyAuthorization(commit(invoice).invoice, digest, audience, sigs, T0);
  w.spike.authorizeVerified(invoice.id, verifiedAuth, T0);
  const conversionRevision = w.spike.read(invoice.id).revision; // 1
  w.spike.request(invoice.id);
  const payoutRevision = w.spike.read(invoice.id).revision;     // 2
  // Transactions the attempts were claimed for (attributed with the Daidai code).
  const swapData = o.noAttribution ? '0xdeadbeef' as Hex : tag('0xdeadbeef', code);
  const payoutCall = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient as Hex, BigInt(invoice.buyAmount)] });
  const payoutData = tag(payoutCall, code);
  const convHash = ('0x' + 'a1'.repeat(32)) as Hex, payHash = ('0x' + 'b2'.repeat(32)) as Hex;
  const blocks: Record<string, { hash: Hex; timestampS: number }> = {
    '100': { hash: ('0x' + '10'.repeat(32)) as Hex, timestampS: Math.floor(o.executeAtMs / 1000) - 10 },
    [(o.payoutBlock ?? 105n).toString()]: { hash: ('0x' + '15'.repeat(32)) as Hex, timestampS: Math.floor(o.executeAtMs / 1000) },
    [(o.finalized ?? 120n).toString()]: { hash: ('0x' + '20'.repeat(32)) as Hex, timestampS: Math.floor(o.executeAtMs / 1000) + 60 },
  };
  const payoutBlock = o.payoutBlock ?? 105n;
  const chainFake = fakeChain({ finalized: o.finalized ?? 120n, blocks, txs: [
    { hash: convHash, to: reactor, input: swapData, from: taker, blockNumber: 100n, logs: [
      transferLog(usdt, taker, reactor, o.conversionDebit ?? 102_480_000n, convHash, blocks['100'].hash, 0),
      transferLog(cngn, reactor, taker, BigInt(invoice.buyAmount), convHash, blocks['100'].hash, 1),
    ] },
    { hash: payHash, to: cngn, input: o.tamperPayoutData ? tag(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [taker as Hex, 1n] }), code) : payoutData,
      from: taker, blockNumber: payoutBlock, logs: [
        transferLog(cngn, taker, recipient, o.payoutAmount ?? BigInt(invoice.buyAmount), payHash, blocks[payoutBlock.toString()].hash, 0),
      ] },
  ] });
  // Lineage: each attempt is recorded at the revision current when it was claimed.
  const lineageFile = join(w.dir, 'lineage.db');
  const store = new AttemptLineageStore(lineageFile);
  t.after(() => store.close_db());
  const fp = { digest, approvalSigner: invoice.approver, consentSigner: recipient, expiresAtMs: invoice.expires };
  store.recordAttempt({ attemptId: 'conv-1', tenantId: 'tenant-a', invoiceId: invoice.id, digest, recordedRevision: conversionRevision,
    operation: 'conversion', createdAtMs: T0 + 1, authorization: fp, envelope: envelopeOf({ chainId: chain, to: reactor, data: swapData, value: '0' }) });
  store.recordHash('conv-1', convHash, T0 + 2);
  store.recordAttempt({ attemptId: 'pay-1', tenantId: 'tenant-a', invoiceId: invoice.id, digest, recordedRevision: payoutRevision,
    operation: 'payout', createdAtMs: T0 + 3, authorization: fp, envelope: envelopeOf({ chainId: chain, to: cngn, data: payoutData, value: '0' }) });
  store.recordHash('pay-1', payHash, T0 + 4);
  const lineage = new AttemptLineageReader(lineageFile);
  t.after(() => lineage.close());
  const tenants = async (id: string) => id === invoice.id ? 'tenant-a' : null;
  const snapshot = invoiceSnapshotReader(join(w.dir, 'invoices.db'), tenants, () => o.nowMs);
  t.after(() => snapshot.close());
  const sources: ProjectionSources<unknown> = {
    authorize: invoiceViewerAuthorizer(permissions({ 'tenant-a/alice': [invoice.id] }, { [invoice.id]: 'tenant-a' }), () => o.nowMs),
    readInvoice: g => snapshot.readInvoice(g),
    observeAuthorization: authorizationObserver(async () => sigs, b => snapshot.readInvoice(b), audience, () => o.nowMs),
    readAttempts: async (b, op) => lineage.attempts(b, op),
    observeTransaction: transactionVerifier(chainFake.rpc, code, () => o.nowMs),
    observeCanonicalBlock: canonicalBlockReader(chainFake.rpc, () => o.nowMs),
  };
  const viewer = await authenticateViewer(sessions, 'session-alice', o.nowMs);
  const result = await readAuthoritativeInvoice({ viewer, invoiceId: invoice.id }, sources,
    { nowMs: o.nowMs, maxObservationAgeMs: 60_000, expectedAudience: audience });
  return { result, calls: chainFake.calls, payoutRevision, conversionRevision };
}

test('end to end: real adapters, mixed recorded revisions and finalized evidence settle; only read RPC methods are used', async t => {
  const { result, calls, conversionRevision, payoutRevision } = await endToEnd(t, { nowMs: T0 + 600_000, executeAtMs: T0 + 300_000 });
  assert(result);
  assert.equal(result.revision, payoutRevision);
  assert.equal(result.conversion.recordedRevision, conversionRevision);
  assert.notEqual(conversionRevision, payoutRevision);
  assert.equal(result.conversion.evidence?.debitAtomic, '102480000');
  assert.equal(result.payout.evidence?.amountAtomic, invoice.buyAmount);
  assert.equal(result.approval.state, 'verified');
  assert.equal(result.settlement, 'settled');
  assert(calls.every(m => ['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(m)));
});

test('end to end: an authorization that expired after execution is verified-at-execution; one executed after expiry is not', async t => {
  const after = await endToEnd(t, { nowMs: invoice.expires + 86_400_000, executeAtMs: invoice.expires - 60_000 });
  assert(after.result);
  assert.equal(after.result.consent.state, 'verified-at-execution');
  assert.equal(after.result.approval.state, 'verified-at-execution');
  assert.equal(after.result.settlement, 'settled');
  const late = await endToEnd(t, { nowMs: invoice.expires + 86_400_000, executeAtMs: invoice.expires + 1_000 });
  assert(late.result);
  assert.equal(late.result.consent.state, 'stale');
  assert.equal(late.result.consent.reason, 'expired');
  assert.notEqual(late.result.settlement, 'settled');
});

test('end to end: wrong amounts, over-cap debit, non-final blocks, tampered envelopes and missing attribution never settle', async t => {
  const cases = {
    shortPayout: [{ payoutAmount: BigInt(invoice.buyAmount) - 1n }, 'payout', 'unknown'],
    overCap: [{ conversionDebit: BigInt(invoice.maxSell) + 1n }, 'conversion', 'unknown'],
    notFinal: [{ finalized: 102n, payoutBlock: 105n }, 'payout', 'reconciliation-required'],
    tamperedEnvelope: [{ tamperPayoutData: true }, 'payout', 'unknown'],
    noAttribution: [{ noAttribution: true }, 'conversion', 'unknown'],
  } as const;
  for (const [name, [o, failing, state]] of Object.entries(cases)) {
    const { result } = await endToEnd(t, { nowMs: T0 + 600_000, executeAtMs: T0 + 300_000, ...o });
    assert(result, name);
    // The adapter refuses to attest bad evidence (unknown: no verified receipt), or the projector marks it unresolved.
    assert.equal(result[failing].state, state, name + ': ' + JSON.stringify(result[failing]));
    assert.equal(result[failing === 'payout' ? 'conversion' : 'payout'].state, 'verified', name + ' other side');
    assert.equal(result.settlement, 'reconciliation-required', name);
  }
});
