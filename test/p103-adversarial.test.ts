/**
 * P10.3 adversarial tests. Deterministic: explicit clocks, in-memory fake RPC, temp SQLite under /tmp/daidai-adv.
 * Tests named "FIXED (adversarial finding): ..." encoded defects found during P10.3 review; they now pass as regression tests.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { verifyFinal } from './lineage-fixtures.ts';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chain, cngn, commit, reactor, tag, usdt, type Invoice } from '../src/invoice.ts';
import { attest, isAttested } from '../src/evidence-attestation.ts';
import { authorizationMessage } from '../src/authorization.ts';
import {
  readAuthoritativeInvoice, type AuthoritativeInvoiceProjection, type ProjectionSources, type StoredAttempt,
} from '../src/authoritative-invoice.ts';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf, type NewAttempt } from '../src/attempt-lineage.ts';
import { authenticateViewer, invoiceViewerAuthorizer, isAuthenticatedViewer, type PermissionStore } from '../src/viewer-access.ts';
import {
  authorizationObserver, canonicalBlockReader, invoiceSnapshotReader, readOnlyRpc, transactionVerifier,
} from '../src/evidence-adapters.ts';

mkdirSync('/tmp/daidai-adv', { recursive: true });
const tmp = () => mkdtempSync('/tmp/daidai-adv/t-');

// ------------------------------------------------------------------ fixtures
const nowMs = 2_000_000;
const options = { nowMs, maxObservationAgeMs: 1_000, expectedAudience: 'https://daidai.example' };
const approverAccount = privateKeyToAccount(('0x' + '11'.repeat(32)) as Hex);
const recipientAccount = privateKeyToAccount(('0x' + '12'.repeat(32)) as Hex);
const approver = approverAccount.address.toLowerCase();
const recipient = recipientAccount.address.toLowerCase();
const taker = '0x' + '33'.repeat(20);
const invoice: Invoice = {
  id: 'invoice-a', version: 1, source: 'invoice-source', nonce: '12'.repeat(16),
  chain, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6,
  buyAmount: '1500000000', recipient, maxSell: '1200000', approver, taker, expires: nowMs + 500,
};
const digest = commit(invoice).digest;
const commitment = { tenantId: 'tenant-a', invoiceId: invoice.id, digest };
const fingerprint = { digest, approvalSigner: approver, consentSigner: recipient, expiresAtMs: invoice.expires };
const block = '0x' + 'bb'.repeat(32);
const final = '0x' + 'cc'.repeat(32);
const hashes = { conversion: '0x' + '55'.repeat(32), payout: '0x' + '66'.repeat(32) } as const;
type Op = 'conversion' | 'payout';
type Purpose = 'invoice approval' | 'recipient consent';

function attempt(operation: Op, patch: Record<string, unknown> = {}): StoredAttempt {
  return attest({
    source: 'attempt-store', ...commitment, operation, id: operation + '-a', lineage: 'recorded', recordedRevision: 7,
    authorization: fingerprint, envelope: { chainId: chain, to: operation === 'conversion' ? reactor : cngn, dataSha256: 'ab'.repeat(32), value: '0' },
    hash: hashes[operation], dispatch: 'hash-recorded', closed: null, createdAtMs: nowMs - 100, history: [], ...patch,
  }) as StoredAttempt;
}

type AnyPorts = Record<string, (...args: any[]) => Promise<any>>;
function ports(over: Partial<{ now: number; txPatch: Partial<Record<Op, Record<string, unknown>>>; canonPatch: Partial<Record<Op, Record<string, unknown>>>;
  authPatch: Partial<Record<Purpose, Record<string, unknown>>> }> = {}) {
  const obs = over.now ?? nowMs;
  const calls: string[] = [];
  const p: AnyPorts = {
    async authorize() { calls.push('authorize'); return { tenantId: commitment.tenantId, invoiceId: invoice.id }; },
    async readInvoice() { calls.push('read'); return attest({ source: 'invoice-store', tenantId: commitment.tenantId, invoice, digest, revision: 7, observedAtMs: obs }); },
    async observeAuthorization(_b: unknown, purpose: Purpose) {
      return attest({ source: 'authorization-verifier', ...commitment, purpose, signer: purpose === 'invoice approval' ? approver : recipient,
        audience: options.expectedAudience, expiresAtMs: invoice.expires, observedAtMs: obs, ...over.authPatch?.[purpose] });
    },
    async readAttempts(_b: unknown, operation: Op) { return [attempt(operation)]; },
    async observeTransaction(a: StoredAttempt) {
      const payout = a.operation === 'payout';
      return attest({ source: 'transaction-verifier', ...commitment, revision: a.recordedRevision, operation: a.operation,
        attemptId: a.id, hash: a.hash, chainId: chain, buyToken: cngn, sellToken: usdt, sender: taker,
        recipient: payout ? recipient : taker, amountAtomic: invoice.buyAmount, debitAtomic: payout ? '0' : invoice.maxSell,
        blockNumber: payout ? '101' : '100', blockHash: payout ? final : block, success: true, observedAtMs: obs, ...over.txPatch?.[a.operation as Op] });
    },
    async observeCanonicalBlock(_c: number, n: string) {
      const op: Op = n === '101' ? 'payout' : 'conversion';
      return attest({ source: 'canonical-chain-reader', chainId: chain, blockNumber: n, blockHash: n === '101' ? final : block,
        blockTimestampMs: nowMs - 50, finalizedBlockNumber: '101', finalizedBlockHash: final, observedAtMs: obs, ...over.canonPatch?.[op] });
    },
  };
  return { p, calls };
}
const read = (p: AnyPorts, opts = options, invoiceId = invoice.id) =>
  readAuthoritativeInvoice({ viewer: 'v', invoiceId }, p as unknown as ProjectionSources<string>, opts);
async function notSettled(p: AnyPorts, label: string, opts = options) {
  const r = await read(p, opts);
  if (r) assert.notEqual(r.settlement, 'settled', label);
  return r;
}

// ================================================================== 1. settlement
test('baseline: fully verified harness settles (sanity)', async () => {
  const r = await read(ports().p);
  assert.equal(r?.settlement, 'settled');
});

for (const [label, op, patch] of [
  ['conversion debit zero', 'conversion', { debitAtomic: '0' }],
  ['conversion debit over cap', 'conversion', { debitAtomic: '1200001' }],
  ['payout carries a debit', 'payout', { debitAtomic: '1' }],
  ['output one atom short', 'payout', { amountAtomic: '1499999999' }],
  ['output one atom over', 'conversion', { amountAtomic: '1500000001' }],
  ['negative amount', 'payout', { amountAtomic: '-1500000000' }],
  ['leading zero amount', 'payout', { amountAtomic: '01500000000' }],
  ['hex amount', 'payout', { amountAtomic: '0x59682f00' }],
  ['huge debit >= 2^256', 'conversion', { debitAtomic: (2n ** 256n).toString() }],
  ['numeric (not string) amount', 'payout', { amountAtomic: 1500000000 }],
  ['uppercase recipient', 'payout', { recipient: recipient.toUpperCase().replace('0X', '0x') }],
  ['non-lowercase block hash', 'payout', { blockHash: '0x' + 'BB'.repeat(32) }],
  ['hash of the other attempt', 'payout', { hash: hashes.conversion }],
  ['other tenant', 'payout', { tenantId: 'tenant-b' }],
  ['other digest', 'conversion', { digest: 'f'.repeat(64) }],
  ['other operation label', 'payout', { operation: 'conversion' }],
  ['success false', 'conversion', { success: false }],
  ['success truthy string', 'conversion', { success: 'true' }],
  ['wrong sender', 'payout', { sender: approver }],
  ['conversion delivered to recipient instead of taker', 'conversion', { recipient }],
] as const) {
  test(`settlement refused: ${label}`, async () => {
    await notSettled(ports({ txPatch: { [op]: patch } }).p, label);
  });
}

test('settlement refused: payout finalized before conversion, same-height fork, not final', async () => {
  await notSettled(ports({ txPatch: { payout: { blockNumber: '99' } }, canonPatch: { payout: { blockNumber: '99' } } }).p, 'order');
  await notSettled(ports({ canonPatch: { conversion: { finalizedBlockNumber: '99' } } }).p, 'not final');
  await notSettled(ports({ canonPatch: { payout: { finalizedBlockNumber: '101', finalizedBlockHash: '0x' + 'dd'.repeat(32) } } }).p, 'fork at final');
  await notSettled(ports({ canonPatch: { conversion: { blockHash: '0x' + 'ee'.repeat(32) } } }).p, 'canonical hash mismatch');
  await notSettled(ports({ canonPatch: { payout: { chainId: 1 } } }).p, 'canonical chain');
});

test('settlement refused: same attempt or hash used for both operations', async () => {
  const { p } = ports();
  p.readAttempts = async (_b, op: Op) => [attempt(op, { id: 'shared' })];
  await notSettled(p, 'same attempt id');
});

test('settlement refused: attempt recorded at a revision newer than the invoice, or tx relabelled to newest revision', async () => {
  const a = ports(); a.p.readAttempts = async (_b, op: Op) => [attempt(op, { recordedRevision: 8 })];
  await notSettled(a.p, 'future revision');
  const b = ports(); b.p.readAttempts = async (_b, op: Op) => [attempt(op, { recordedRevision: 3 })];
  b.p.observeTransaction = async (x: StoredAttempt) => attest({ ...(await ports().p.observeTransaction(x)), revision: 7 });
  await notSettled(b.p, 'relabelled');
});

test('settlement refused: missing authorizations or wrong audience/signer/expiry', async () => {
  for (const patch of [{ audience: 'https://evil.example' }, { signer: taker }, { expiresAtMs: invoice.expires + 1 }, { purpose: 'invoice approval' }, { tenantId: 'tenant-b' }]) {
    await notSettled(ports({ authPatch: { 'recipient consent': patch } }).p, JSON.stringify(patch));
  }
  const { p } = ports(); p.observeAuthorization = async () => null;
  await notSettled(p, 'missing');
  const t = ports(); t.p.observeAuthorization = async () => { throw Error('down'); };
  await notSettled(t.p, 'throws');
});

// ================================================================== 2. forged evidence
const forgeries: Record<string, (v: any) => any> = {
  json: v => JSON.parse(JSON.stringify(v)),
  structuredClone: v => structuredClone(v),
  spread: v => ({ ...v }),
  frozenCopy: v => Object.freeze({ ...v }),
  objectCreate: v => Object.create(v),
  proxy: v => new Proxy(v, {}),
  reattestedProxyTarget: v => new Proxy(attest({ ...v }), { get: (t, k) => Reflect.get(t, k) }),
};
test('forgeries of attested records lose the brand', async () => {
  const real = await ports().p.observeTransaction(attempt('payout'));
  assert(isAttested(real));
  for (const [name, f] of Object.entries(forgeries)) assert(!isAttested(f(real)), name);
});
for (const [name, f] of Object.entries(forgeries)) {
  test(`forged (${name}) evidence never settles or reads`, async () => {
    for (const port of ['observeTransaction', 'observeCanonicalBlock', 'observeAuthorization'] as const) {
      const base = ports().p;
      const p = { ...base, [port]: async (...a: any[]) => f(await base[port](...a)) };
      await notSettled(p, port);
    }
    const base = ports().p;
    await notSettled({ ...base, readAttempts: async (b: unknown, op: Op) => (await base.readAttempts(b, op)).map(f) }, 'attempts');
    assert.equal(await read({ ...base, readInvoice: async () => f(await base.readInvoice()) }), null, 'invoice');
  });
}

test('attested array of attempts with extra properties / non-array is not accepted as evidence', async () => {
  const base = ports().p;
  await notSettled({ ...base, readAttempts: async (_b: unknown, op: Op) => ({ 0: attempt(op), length: 1 }) }, 'array-like');
  await notSettled({ ...base, readAttempts: async (_b: unknown, op: Op) => [attempt(op), attempt(op, { id: op + '-b' })] }, 'two open');
});

test('prototype pollution does not create authority', async () => {
  const proto = Object.prototype as any;
  try {
    proto.source = 'transaction-verifier'; proto.success = true; proto.closed = 'reconciled-not-landed';
    const base = ports().p;
    await notSettled({ ...base, observeTransaction: async (a: StoredAttempt) => {
      const { source: _s, ...rest } = await base.observeTransaction(a); return rest; } }, 'polluted');
    const r = await read(base);
    // Polluted `closed` must not hide attested attempts (they have own closed: null).
    assert.equal(r?.settlement, 'settled');
  } finally { delete proto.source; delete proto.success; delete proto.closed; }
});

test('attested record with a value-changing accessor cannot yield an inconsistent settled projection', async () => {
  const base = ports().p;
  const p = { ...base, observeTransaction: async (a: StoredAttempt) => {
    const plain = { ...(await base.observeTransaction(a)) };
    if (a.operation !== 'conversion') return attest(plain);
    let reads = 0;
    Object.defineProperty(plain, 'debitAtomic', { enumerable: true, get: () => (++reads <= 2 ? invoice.maxSell : '9999999999') });
    return attest(plain);
  } };
  const r = await read(p);
  if (r) {
    assert(r.conversion.state !== 'verified' || BigInt(r.conversion.evidence!.debitAtomic) <= BigInt(invoice.maxSell));
  }
});

// ================================================================== 3. historical authorization
const later = { ...options, nowMs: invoice.expires + 10_000 };
function expiredPorts(tsConv: number, tsPay: number, attemptPatch: Record<string, unknown> = {}) {
  const { p } = ports({ now: later.nowMs, canonPatch: { conversion: { blockTimestampMs: tsConv }, payout: { blockTimestampMs: tsPay } } });
  p.readAttempts = async (_b, op: Op) => [attempt(op, attemptPatch)];
  return p;
}
test('historical: both before expiry -> verified-at-execution and settled (sanity)', async () => {
  const r = await read(expiredPorts(invoice.expires - 2, invoice.expires - 1), later);
  assert.equal(r?.approval.state, 'verified-at-execution');
  assert.equal(r?.settlement, 'settled');
});
test('historical: execution exactly at expiry, or only one side manipulated, stays stale', async () => {
  for (const [c, p] of [[invoice.expires, invoice.expires], [invoice.expires - 1, invoice.expires], [invoice.expires, invoice.expires - 1], [1, invoice.expires + 5]]) {
    const r = await read(expiredPorts(c, p), later);
    assert.equal(r?.approval.state, 'stale', `${c},${p}`);
    assert.equal(r?.consent.state, 'stale');
    assert.notEqual(r?.settlement, 'settled');
  }
});
test('historical: only one operation verified gives no verified-at-execution', async () => {
  const p = expiredPorts(invoice.expires - 2, invoice.expires - 1);
  const base = p.readAttempts;
  p.readAttempts = async (b, op: Op) => op === 'payout' ? [attempt('payout', { hash: null, dispatch: 'claimed' })] : base(b, op);
  const r = await read(p, later);
  assert.equal(r?.approval.state, 'stale');
  assert.notEqual(r?.settlement, 'settled');
});
test('historical: attempt claimed under a different fingerprint / after expiry is unverified', async () => {
  for (const patch of [
    { authorization: { ...fingerprint, expiresAtMs: invoice.expires + 1 } },
    { authorization: { ...fingerprint, consentSigner: taker } },
    { authorization: null },
    { createdAtMs: invoice.expires },
  ]) {
    const r = await read(expiredPorts(invoice.expires - 2, invoice.expires - 1, patch), later);
    assert.notEqual(r?.approval.state, 'verified-at-execution', JSON.stringify(patch));
    assert.notEqual(r?.settlement, 'settled');
  }
});
test('historical: authorization observation older than maxObservationAgeMs is stale', async () => {
  const { p } = ports({ authPatch: { 'invoice approval': { observedAtMs: nowMs - 1_001 } } });
  const r = await read(p);
  assert.equal(r?.approval.state, 'stale');
  assert.notEqual(r?.settlement, 'settled');
});

// ================================================================== 4. lineage store
const newAttempt = (patch: Partial<NewAttempt> = {}): NewAttempt => ({
  attemptId: 'att-1', ...commitment, recordedRevision: 7, operation: 'payout', createdAtMs: 1_000,
  authorization: fingerprint, envelope: envelopeOf({ chainId: chain, to: cngn, data: '0xabcd', value: '0' }), ...patch,
});
test('lineage: SQL cannot mutate identity, rewrite hash, reopen, or delete', () => {
  const file = join(tmp(), 'l.db');
  const s = new AttemptLineageStore(file);
  s.recordAttempt(newAttempt());
  s.recordHash('att-1', hashes.payout, 1_001);
  assert.throws(() => s.recordHash('att-1', hashes.conversion, 1_002));
  for (const sql of [
    "UPDATE attempts SET tenant_id = 'tenant-b'", 'UPDATE attempts SET recorded_revision = 8', "UPDATE attempts SET digest = 'x'",
    "UPDATE attempts SET lineage = 'unresolved'", "UPDATE attempts SET authorization = '{}'", 'UPDATE attempts SET hash = NULL',
    `UPDATE attempts SET hash = '${hashes.conversion}'`, 'DELETE FROM attempts', 'DELETE FROM attempt_events', "UPDATE attempt_events SET kind = 'closed'",
  ]) assert.throws(() => s.db.exec(sql), sql);
  verifyFinal(s, 'att-1', 1_002);
  s.close('att-1', 'verified-final', 1_003, 'op-1');
  assert.throws(() => s.db.exec('UPDATE attempts SET closed = NULL'), /attempt closure is final/);
  assert.throws(() => s.close('att-1', 'reconciled-not-landed', 1_004, 'op-1'));
  const r = new AttemptLineageReader(file);
  const [a] = r.attempts(commitment, 'payout');
  assert.equal(a.hash, hashes.payout); assert.equal(a.closed, 'verified-final'); assert.equal(a.recordedRevision, 7);
  r.close(); s.close_db();
});
test('settlement refused: attempt with non-canonical (uppercase) hash', async () => {
  const { p } = ports();
  p.readAttempts = async (_b, op: Op) => [attempt(op, op === 'payout' ? { hash: '0x' + 'AB'.repeat(32) } : {})];
  p.observeTransaction = async (a: StoredAttempt) => attest({ ...(await ports().p.observeTransaction(a)), hash: a.hash });
  await notSettled(p, 'uppercase attempt hash');
});
test('FIXED (adversarial finding): lineage INSERT OR REPLACE bypasses identity-immutable and no-delete triggers', () => {
  const file = join(tmp(), 'l.db');
  const s = new AttemptLineageStore(file);
  s.recordAttempt(newAttempt());
  s.recordHash('att-1', hashes.payout, 1_001);
  let rewrote = true;
  try {
    s.db.exec(`INSERT OR REPLACE INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
      created_at_ms, authorization, envelope, hash, dispatch, closed)
      SELECT attempt_id, tenant_id, invoice_id, digest, 9, lineage, operation, created_at_ms, authorization, envelope,
      '${hashes.conversion}', dispatch, NULL FROM attempts WHERE attempt_id = 'att-1'`);
  } catch { rewrote = false; }
  const r = new AttemptLineageReader(file);
  const [a] = r.attempts(commitment, 'payout');
  r.close(); s.close_db();
  assert(!rewrote && a.recordedRevision === 7 && a.hash === hashes.payout,
    `identity rewritten: recordedRevision=${a.recordedRevision} hash=${a.hash}`);
});
test('FIXED (adversarial finding): lineage INSERT OR REPLACE rewrites append-only event history', () => {
  const file = join(tmp(), 'l.db');
  const s = new AttemptLineageStore(file);
  s.recordAttempt(newAttempt());
  let rewrote = true;
  try { s.db.exec(`INSERT OR REPLACE INTO attempt_events (seq, attempt_id, kind, at_ms, detail) VALUES (1, 'att-1', 'legacy-import', 1, '{}')`); }
  catch { rewrote = false; }
  const r = new AttemptLineageReader(file);
  const [a] = r.attempts(commitment, 'payout');
  r.close(); s.close_db();
  assert(!rewrote && a.history[0].kind === 'claimed', `history[0] is now ${a.history[0].kind}`);
});
test('lineage: two writers on one file cannot both open an attempt for the same operation', () => {
  const file = join(tmp(), 'l.db');
  const a = new AttemptLineageStore(file), b = new AttemptLineageStore(file);
  assert.equal(a.recordAttempt(newAttempt({ attemptId: 'att-a' })), 'created');
  assert.throws(() => b.recordAttempt(newAttempt({ attemptId: 'att-b' })), /already open/);
  assert.throws(() => b.db.exec(`INSERT INTO attempts SELECT 'att-c', tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
    created_at_ms, authorization, envelope, NULL, dispatch, NULL FROM attempts WHERE attempt_id = 'att-a'`));
  assert.throws(() => a.recordAttempt(newAttempt({ attemptId: 'att-a', recordedRevision: 8 })), /conflict/);
  a.close_db(); b.close_db();
});
test('lineage: reader cannot write, even after turning query_only off', () => {
  const file = join(tmp(), 'l.db');
  const s = new AttemptLineageStore(file); s.recordAttempt(newAttempt());
  const r = new AttemptLineageReader(file);
  assert.throws(() => r.db.exec("UPDATE attempts SET dispatch = 'claimed'"));
  r.db.exec('PRAGMA query_only = OFF');
  assert.throws(() => r.db.exec("INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES ('att-1', 'closed', 1, '{}')"));
  r.close(); s.close_db();
});
test('lineage: legacy import is unresolved, blocks settlement, and cannot be promoted', async () => {
  const file = join(tmp(), 'l.db');
  const s = new AttemptLineageStore(file);
  s.importLegacy('tenant-a', { digest, invoiceId: invoice.id, swapId: 'legacy-swap', payoutId: 'legacy-pay' }, 1_000);
  assert.throws(() => s.db.exec("UPDATE attempts SET lineage = 'recorded', recorded_revision = 7"));
  assert.throws(() => s.recordAttempt(newAttempt({ attemptId: 'legacy-pay' })), /conflict/);
  const r = new AttemptLineageReader(file);
  const all = r.attempts(commitment, 'payout');
  assert.equal(all[0].lineage, 'unresolved'); assert.equal(all[0].recordedRevision, null);
  const { p } = ports(); p.readAttempts = async (b, op: Op) => r.attempts(b as typeof commitment, op);
  const out = await read(p);
  assert.equal(out?.payout.reason, 'lineage-unresolved'); assert.notEqual(out?.settlement, 'settled');
  r.close(); s.close_db();
});
test('lineage: invalid new attempts are refused', () => {
  const s = new AttemptLineageStore(join(tmp(), 'l.db'));
  for (const patch of [{ attemptId: '../x' }, { recordedRevision: -1 }, { digest: 'F'.repeat(64) },
    { authorization: { ...fingerprint, consentSigner: approver } }, { authorization: { ...fingerprint, digest: '0'.repeat(64) } },
    { envelope: { chainId: chain, to: cngn, dataSha256: 'ab'.repeat(32), value: '01' } }, { createdAtMs: 0 }, { operation: 'mint' as never }]) {
    assert.throws(() => s.recordAttempt(newAttempt(patch as Partial<NewAttempt>)), JSON.stringify(patch));
  }
  s.close_db();
});

// ================================================================== 5. viewer access
const authn = (r: unknown) => ({ verify: async () => r as never });
const goodViewer = { viewerId: 'viewer-a', tenantId: 'tenant-a', authenticatedAtMs: 1_000, expiresAtMs: 5_000 };
const perms = (over: Partial<PermissionStore> = {}, log: string[] = []): PermissionStore => ({
  async canReadInvoice(t, v, i) { log.push('can'); return t === 'tenant-a' && v === 'viewer-a' && i === 'invoice-a'; },
  async tenantOfInvoice(i) { log.push('dir'); return i === 'invoice-a' ? 'tenant-a' : 'tenant-b'; }, ...over,
});
test('viewer: forged, JSON-ed, or expired viewers get no grant', async () => {
  const v = await authenticateViewer(authn(goodViewer), 'cred', 2_000);
  assert(v && isAuthenticatedViewer(v));
  const authorize = invoiceViewerAuthorizer(perms(), () => 2_000);
  assert.deepEqual(await authorize(v, 'invoice-a'), { tenantId: 'tenant-a', invoiceId: 'invoice-a' });
  for (const forged of [{ ...v }, JSON.parse(JSON.stringify(v)), Object.create(v), new Proxy(v, {}), Object.freeze({ ...v })]) {
    assert.equal(await authorize(forged, 'invoice-a'), null);
  }
  assert.equal(await invoiceViewerAuthorizer(perms(), () => 5_000)(v, 'invoice-a'), null, 'expired at boundary');
  assert.equal(await authenticateViewer(authn({ ...goodViewer, expiresAtMs: 2_000 }), 'cred', 2_000), null);
  assert.equal(await authenticateViewer(authn({ ...goodViewer, authenticatedAtMs: 2_001 }), 'cred', 2_000), null);
  assert.equal(await authenticateViewer(authn({ ...goodViewer, tenantId: 'a/b' }), 'cred', 2_000), null);
  assert.equal(await authenticateViewer({ verify: async () => { throw Error('x'); } }, 'cred', 2_000), null);
  assert.equal(await authenticateViewer(authn(goodViewer), { toString: () => 'cred' }, 2_000), null);
});
test('viewer: cross-tenant, throwing store, odd invoice ids are refused', async () => {
  const v = await authenticateViewer(authn(goodViewer), 'cred', 2_000);
  const clock = () => 2_000;
  assert.equal(await invoiceViewerAuthorizer(perms({ tenantOfInvoice: async () => 'tenant-b' }), clock)(v, 'invoice-a'), null);
  assert.equal(await invoiceViewerAuthorizer(perms({ tenantOfInvoice: async () => null }), clock)(v, 'invoice-a'), null);
  assert.equal(await invoiceViewerAuthorizer(perms({ canReadInvoice: async () => 'yes' as never }), clock)(v, 'invoice-a'), null);
  assert.equal(await invoiceViewerAuthorizer(perms({ canReadInvoice: async () => { throw Error('db'); } }), clock)(v, 'invoice-a'), null);
  const log: string[] = [];
  for (const odd of ['', '../invoice-a', 'invoice-a\n', 'invoice-a ', 'a'.repeat(129), '%2e', 'invoice-a\u0000']) {
    assert.equal(await invoiceViewerAuthorizer(perms({}, log), clock)(v, odd), null, JSON.stringify(odd));
  }
  assert.deepEqual(log, [], 'no store access for malformed ids');
});
test('viewer: readInvoice is never called when unauthorized (composed with projector)', async () => {
  const v = await authenticateViewer(authn(goodViewer), 'cred', 2_000);
  for (const [viewer, store] of [[{ ...v }, perms()], [v, perms({ tenantOfInvoice: async () => 'tenant-b' })],
    [v, perms({ canReadInvoice: async () => false })]] as const) {
    const { p, calls } = ports();
    p.authorize = invoiceViewerAuthorizer(store, () => 2_000);
    assert.equal(await readAuthoritativeInvoice({ viewer, invoiceId: 'invoice-a' }, p as unknown as ProjectionSources<unknown>, options), null);
    assert(!calls.includes('read'));
  }
});
test('FIXED (adversarial finding): viewer authorizer fails open when the clock returns NaN (expiry check `expiresAtMs <= NaN` is false)', async () => {
  const v = await authenticateViewer(authn(goodViewer), 'cred', 2_000);
  assert.equal(await invoiceViewerAuthorizer(perms(), () => Number.NaN)(v, 'invoice-a'), null);
});
test('FIXED (adversarial finding): authenticateViewer re-reads authenticator fields after validation (TOCTOU via accessors)', async () => {
  let n = 0;
  const shifty = { authenticatedAtMs: 1_000, expiresAtMs: 5_000, viewerId: 'viewer-a',
    get tenantId() { return ++n === 1 ? 'tenant-a' : '../tenant b'; } };
  const v = await authenticateViewer(authn(shifty), 'cred', 2_000);
  assert(v === null || /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.tenantId), `minted viewer with tenantId ${v?.tenantId}`);
});

// ================================================================== 6. adapters
const code = 'daidai';
test('readOnlyRpc refuses every write/sign method before reaching the transport', async () => {
  const seen: string[] = [];
  const rpc = readOnlyRpc(async m => { seen.push(m); return null; });
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData',
    'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'eth_accounts', 'ETH_CHAINID', 'eth_chainId ', 'constructor', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(rpc(m, []), /not allowed/, m);
  }
  assert.deepEqual(seen, []);
  await rpc('eth_chainId', []);
  assert.deepEqual(seen, ['eth_chainId']);
});

const transferLog = (token: string, from: string, to: string, value: bigint, patch: Record<string, unknown> = {}) => ({
  address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]), removed: false, logIndex: '0x0', ...patch,
});
const txHash = '0x' + '77'.repeat(32);
const rcptBlock = '0x' + '88'.repeat(32);
function chainFixture(op: Op, mut: { tx?: Record<string, unknown>; rcpt?: Record<string, unknown>; logs?: any[]; chainId?: string; data?: Hex } = {}) {
  const data = mut.data ?? tag('0xdeadbeef', code);
  const to = op === 'conversion' ? reactor : cngn;
  const env = envelopeOf({ chainId: chain, to, data: tag('0xdeadbeef', code), value: '0' });
  const a = attempt(op, { envelope: env, hash: txHash });
  const logs = (mut.logs ?? (op === 'conversion'
    ? [transferLog(cngn, reactor, taker, 1_500_000_000n, { logIndex: '0x0' }), transferLog(usdt, taker, reactor, 1_000_000n, { logIndex: '0x1' })]
    : [transferLog(cngn, taker, recipient, 1_500_000_000n)])).map(l => ({ transactionHash: txHash, blockHash: rcptBlock, ...l }));
  const tx = { hash: txHash, blockHash: rcptBlock, blockNumber: '0x64', chainId: '0xa4ec', from: taker, to, input: data, value: '0x0', ...mut.tx };
  const rcpt = { transactionHash: txHash, blockHash: rcptBlock, blockNumber: '0x64', from: taker, to, status: '0x1', logs, ...mut.rcpt };
  const methods: string[] = [];
  const rpc = async (m: string) => {
    methods.push(m);
    if (m === 'eth_chainId') return mut.chainId ?? '0xa4ec';
    if (m === 'eth_getTransactionByHash') return tx;
    if (m === 'eth_getTransactionReceipt') return rcpt;
    throw Error('unexpected ' + m);
  };
  return { a, observe: transactionVerifier(rpc, code, () => nowMs), methods };
}
const committed = commit(invoice).invoice as Invoice;

test('transactionVerifier accepts an honest conversion and payout (sanity) using only read methods', async () => {
  for (const op of ['conversion', 'payout'] as const) {
    const f = chainFixture(op);
    const r = await f.observe(f.a, committed);
    assert(r && isAttested(r), op);
    assert.equal(r.amountAtomic, invoice.buyAmount);
    assert.equal(r.debitAtomic, op === 'conversion' ? '1000000' : '0');
    assert(f.methods.every(m => ['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(m)));
  }
});
const conv = (from: string, to: string, v: bigint, i: string, p: Record<string, unknown> = {}) => transferLog(cngn, from, to, v, { logIndex: i, ...p });
const dbt = (v: bigint, i: string) => transferLog(usdt, taker, reactor, v, { logIndex: i });
for (const [label, op, mut] of [
  ['wrong rpc chain id', 'payout', { chainId: '0x1' }],
  ['wrong tx chain id', 'payout', { tx: { chainId: '0x1' } }],
  ['wrong sender', 'payout', { tx: { from: approver }, rcpt: { from: approver } }],
  ['wrong to', 'payout', { tx: { to: usdt }, rcpt: { to: usdt } }],
  ['data digest mismatch', 'payout', { tx: { input: tag('0xdeadbeee', code) } }],
  ['missing attribution', 'payout', { data: '0xdeadbeef' }],
  ['wrong attribution code', 'payout', { data: tag('0xdeadbeef', 'other') }],
  ['nonzero value', 'payout', { tx: { value: '0x1' } }],
  ['failed status', 'payout', { rcpt: { status: '0x0' } }],
  ['receipt for another tx', 'payout', { rcpt: { transactionHash: '0x' + '99'.repeat(32) } }],
  ['tx/receipt block mismatch', 'payout', { tx: { blockHash: '0x' + '99'.repeat(32) } }],
  ['removed log', 'payout', { logs: [transferLog(cngn, taker, recipient, 1_500_000_000n, { removed: true })] }],
  ['log from another tx', 'payout', { logs: [transferLog(cngn, taker, recipient, 1_500_000_000n, { transactionHash: '0x' + '99'.repeat(32) })] }],
  ['log from another block', 'payout', { logs: [transferLog(cngn, taker, recipient, 1_500_000_000n, { blockHash: '0x' + '99'.repeat(32) })] }],
  ['log without index', 'payout', { logs: [transferLog(cngn, taker, recipient, 1_500_000_000n, { logIndex: undefined })] }],
  ['duplicate log index', 'payout', { logs: [conv(taker, recipient, 750_000_000n, '0x1'), conv(taker, recipient, 750_000_000n, '0x1')] }],
  ['extra unexpected transfer (payout leaks USDt)', 'payout', { logs: [conv(taker, recipient, 1_500_000_000n, '0x0'), transferLog(usdt, taker, approver, 1n, { logIndex: '0x1' })] }],
  ['payout under output', 'payout', { logs: [conv(taker, recipient, 1_499_999_999n, '0x0')] }],
  ['payout over output', 'payout', { logs: [conv(taker, recipient, 1_500_000_001n, '0x0')] }],
  ['payout to someone else', 'payout', { logs: [conv(taker, approver, 1_500_000_000n, '0x0')] }],
  ['conversion over-cap debit', 'conversion', { logs: [conv(reactor, taker, 1_500_000_000n, '0x0'), dbt(1_200_001n, '0x1')] }],
  ['conversion zero debit', 'conversion', { logs: [conv(reactor, taker, 1_500_000_000n, '0x0')] }],
  ['conversion under output', 'conversion', { logs: [conv(reactor, taker, 1_499_999_999n, '0x0'), dbt(1n, '0x1')] }],
  ['conversion taker sends cNGN out', 'conversion', { logs: [conv(reactor, taker, 1_500_000_000n, '0x0'), dbt(1n, '0x1'), conv(taker, approver, 1n, '0x2')] }],
] as const) {
  test(`transactionVerifier rejects: ${label}`, async () => {
    const f = chainFixture(op, mut as any);
    let r: unknown = null;
    try { r = await f.observe(f.a, committed); } catch { r = null; }
    assert.equal(r, null);
  });
}
test('transactionVerifier refuses attempts without recorded lineage or hash, before any RPC', async () => {
  for (const patch of [{ lineage: 'unresolved' }, { hash: null }, { envelope: null }, { recordedRevision: null }, { hash: '0x' + 'AB'.repeat(32) }]) {
    const f = chainFixture('payout');
    assert.equal(await f.observe(attempt('payout', { ...patch }), committed), null);
    assert.deepEqual(f.methods, []);
  }
});
test('FIXED (adversarial finding): transactionVerifier duplicate-log-index check is bypassed by non-canonical index encoding (0x1 vs 0x01)', async () => {
  const f = chainFixture('payout', { logs: [conv(taker, recipient, 750_000_000n, '0x1'), conv(taker, recipient, 750_000_000n, '0x01')] });
  let r: unknown = null;
  try { r = await f.observe(f.a, committed); } catch { r = null; }
  assert.equal(r, null, 'one 750M transfer reported twice was accepted as the full 1.5B output');
});

function blockRpc(blockNum: string, b: Record<string, unknown> | null, fin: Record<string, unknown> | null, chainId = '0xa4ec') {
  return async (m: string, params: readonly unknown[]) => {
    if (m === 'eth_chainId') return chainId;
    if (m === 'eth_getBlockByNumber') return params[0] === 'finalized' ? fin : (params[0] === blockNum ? b : null);
    throw Error('unexpected ' + m);
  };
}
test('canonicalBlockReader: honest block (sanity) and rejection of mismatched height/hash/timestamps', async () => {
  const fin = { number: '0x65', hash: final, timestamp: '0x7d0' };
  const ok = await canonicalBlockReader(blockRpc('0x64', { number: '0x64', hash: block, timestamp: '0x7d0' }, fin), () => nowMs)(chain, '100');
  assert(ok && isAttested(ok)); assert.equal(ok.blockTimestampMs, 2_000_000);
  for (const [label, b, f, n, cid] of [
    ['height mismatch', { number: '0x63', hash: block, timestamp: '0x1' }, fin, '100', '0xa4ec'],
    ['padded height', { number: '0x064', hash: block, timestamp: '0x1' }, fin, '100', '0xa4ec'],
    ['bad hash', { number: '0x64', hash: '0x1234', timestamp: '0x1' }, fin, '100', '0xa4ec'],
    ['zero timestamp', { number: '0x64', hash: block, timestamp: '0x0' }, fin, '100', '0xa4ec'],
    ['leading-zero timestamp', { number: '0x64', hash: block, timestamp: '0x01' }, fin, '100', '0xa4ec'],
    ['decimal timestamp', { number: '0x64', hash: block, timestamp: '2000' }, fin, '100', '0xa4ec'],
    ['negative timestamp', { number: '0x64', hash: block, timestamp: '-0x1' }, fin, '100', '0xa4ec'],
    ['huge timestamp', { number: '0x64', hash: block, timestamp: '0x' + 'f'.repeat(30) }, fin, '100', '0xa4ec'],
    ['missing block', null, fin, '100', '0xa4ec'],
    ['missing finalized', { number: '0x64', hash: block, timestamp: '0x1' }, null, '100', '0xa4ec'],
    ['bad finalized number', { number: '0x64', hash: block, timestamp: '0x1' }, { ...fin, number: 'latest' }, '100', '0xa4ec'],
    ['leading-zero height', { number: '0x64', hash: block, timestamp: '0x1' }, fin, '0100', '0xa4ec'],
    ['wrong chain', { number: '0x64', hash: block, timestamp: '0x1' }, fin, '100', '0x1'],
  ] as const) {
    let r: unknown = null;
    try { r = await canonicalBlockReader(blockRpc('0x64', b as any, f as any, cid), () => nowMs)(chain, n); } catch { r = null; }
    assert.equal(r, null, label);
  }
  assert.equal(await canonicalBlockReader(blockRpc('0x64', null, fin), () => nowMs)(1, '100'), null);
});

test('invoiceSnapshotReader rejects tampered digest, revision mismatch and cross-tenant; never writes', async () => {
  const file = join(tmp(), 'inv.db');
  const w = new DatabaseSync(file);
  w.exec('CREATE TABLE invoices (id TEXT PRIMARY KEY, body TEXT, revision INTEGER)');
  const c = commit(invoice);
  const put = (id: string, body: unknown, rev: number) => w.prepare('INSERT INTO invoices VALUES (?, ?, ?)').run(id, JSON.stringify(body), rev);
  put('invoice-a', { commitment: c, revision: 7 }, 7);
  put('invoice-t', { commitment: { invoice: { ...c.invoice, id: 'invoice-t', buyAmount: '1' }, digest: c.digest }, revision: 1 }, 1);
  put('invoice-r', { commitment: { ...c, invoice: { ...c.invoice, id: 'invoice-r' }, digest: commit({ ...invoice, id: 'invoice-r' }).digest }, revision: 2 }, 3);
  w.close();
  const reader = invoiceSnapshotReader(file, async id => (id === 'invoice-x' ? 'tenant-b' : 'tenant-a'), () => nowMs);
  const ok = await reader.readInvoice({ tenantId: 'tenant-a', invoiceId: 'invoice-a' });
  assert(ok && isAttested(ok)); assert.equal(ok.digest, digest);
  assert.equal(await reader.readInvoice({ tenantId: 'tenant-b', invoiceId: 'invoice-a' }), null);
  assert.equal(await reader.readInvoice({ tenantId: 'tenant-a', invoiceId: 'invoice-t' }), null);
  assert.equal(await reader.readInvoice({ tenantId: 'tenant-a', invoiceId: 'invoice-r' }), null);
  reader.close();
});

test('authorizationObserver recovers only the expected signer for the expected audience and purpose', async () => {
  const c = commit(invoice);
  const stored = attest({ source: 'invoice-store' as const, tenantId: 'tenant-a', invoice: c.invoice as Invoice, digest: c.digest, revision: 7, observedAtMs: nowMs });
  const sign = (acct: typeof approverAccount, purpose: Purpose, aud = options.expectedAudience) =>
    acct.signTypedData(authorizationMessage(c.invoice as Invoice, c.digest, purpose, aud) as any);
  const good = { approval: await sign(approverAccount, 'invoice approval'), consent: await sign(recipientAccount, 'recipient consent') };
  const obs = (sig: typeof good, snap = stored) => authorizationObserver(async () => sig, async () => snap, options.expectedAudience, () => nowMs);
  const a = await obs(good)(commitment, 'invoice approval');
  assert(a && isAttested(a)); assert.equal(a.signer, approver);
  assert.equal((await obs(good)(commitment, 'recipient consent'))?.signer, recipient);
  // swapped purposes, wrong audience, wrong signer, cross-tenant snapshot, malformed signature
  assert.equal(await obs({ approval: good.consent, consent: good.approval })(commitment, 'invoice approval'), null);
  assert.equal(await obs({ ...good, approval: await sign(approverAccount, 'invoice approval', 'https://evil.example') })(commitment, 'invoice approval'), null);
  assert.equal(await obs({ ...good, consent: await sign(approverAccount, 'recipient consent') })(commitment, 'recipient consent'), null);
  assert.equal(await obs(good)({ ...commitment, tenantId: 'tenant-b' }, 'invoice approval'), null);
  assert.equal(await obs({ ...good, approval: '0x1234' as Hex })(commitment, 'invoice approval'), null);
  assert.equal(await obs(good)({ ...commitment, digest: '0'.repeat(64) }, 'invoice approval'), null);
});

// type anchor so unused-import checks stay quiet
export type _P = AuthoritativeInvoiceProjection;
