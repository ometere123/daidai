import { chain, cngn, commit, usdt, type Invoice } from './invoice.ts';
import { isAttested } from './evidence-attestation.ts';
import type { AttemptLineage, AuthorizationFingerprint } from './attempt-lineage.ts';

export type AuthorizationPurpose = 'invoice approval' | 'recipient consent';
export type InvoiceOperation = 'conversion' | 'payout';
export type ViewerGrant = Readonly<{ tenantId: string; invoiceId: string }>;
export type InvoiceBinding = ViewerGrant & Readonly<{ digest: string; revision: number }>;
export type CommitmentBinding = ViewerGrant & Readonly<{ digest: string }>;
export type StoredInvoice = Readonly<{
  source: 'invoice-store'; tenantId: string; invoice: Invoice;
  digest: string; revision: number; observedAtMs: number;
}>;
/** An EIP-712 signature binds the commitment digest, not a storage revision, so authorization is bound per commitment. */
export type ObservedAuthorization = CommitmentBinding & Readonly<{
  source: 'authorization-verifier'; purpose: AuthorizationPurpose; signer: string;
  audience: string; expiresAtMs: number; observedAtMs: number;
}>;
export type StoredAttempt = AttemptLineage;
/** Transaction evidence is bound to the attempt and to the revision that attempt was recorded at. */
export type ObservedTransaction = CommitmentBinding & Readonly<{
  source: 'transaction-verifier'; revision: number; operation: InvoiceOperation; attemptId: string;
  hash: string; chainId: number; buyToken: string; sellToken: string; sender: string;
  recipient: string; amountAtomic: string; debitAtomic: string; blockNumber: string;
  blockHash: string; success: boolean; observedAtMs: number;
}>;
export type CanonicalBlockObservation = Readonly<{
  source: 'canonical-chain-reader'; chainId: number; blockNumber: string; blockHash: string; blockTimestampMs: number;
  finalizedBlockNumber: string; finalizedBlockHash: string; observedAtMs: number;
}>;

/**
 * Ports are supplied only by trusted server composition; never accept adapter results from clients.
 * Every returned record must also carry the in-process attestation brand (see evidence-attestation.ts):
 * a `source` label alone never establishes authority.
 */
export interface ProjectionSources<Viewer = unknown> {
  authorize(viewer: Viewer, invoiceId: string): Promise<ViewerGrant | null>;
  readInvoice(grant: ViewerGrant): Promise<StoredInvoice | null>;
  observeAuthorization(binding: CommitmentBinding, purpose: AuthorizationPurpose): Promise<ObservedAuthorization | null>;
  readAttempts(binding: CommitmentBinding, operation: InvoiceOperation): Promise<readonly StoredAttempt[]>;
  observeTransaction(attempt: StoredAttempt, invoice: Invoice): Promise<ObservedTransaction | null>;
  observeCanonicalBlock(chainId: number, blockNumber: string): Promise<CanonicalBlockObservation | null>;
}

export type ProjectionOptions = Readonly<{ nowMs: number; maxObservationAgeMs: number; expectedAudience: string }>;
type AuthorizationEvidence = Readonly<Pick<ObservedAuthorization, 'source' | 'signer' | 'audience' | 'digest' | 'expiresAtMs' | 'observedAtMs'>>;
/**
 * verified: verified and currently unexpired.
 * verified-at-execution: verified, now expired, but provably valid when both finalized operations executed
 *   (canonical block timestamps before expiry) and bound to the authorization each attempt was claimed under.
 * stale: expired without such proof, or the observation itself is too old.
 * unverified: missing or not matching the invoice, signer, audience or attempt.
 */
export type AuthorizationSummary = Readonly<{
  purpose: AuthorizationPurpose; state: 'unverified' | 'stale' | 'verified' | 'verified-at-execution';
  reason?: 'missing' | 'mismatch' | 'expired' | 'observation-stale';
  evidence?: AuthorizationEvidence; executedAtMs?: number;
}>;
export type ProjectedTransactionEvidence = Readonly<{
  source: 'transaction-verifier'; canonicalSource: 'canonical-chain-reader';
  hash: string; blockNumber: string; blockHash: string; blockTimestampMs: number; finalizedBlockNumber: string; finalizedBlockHash: string;
  observedAtMs: number; canonicalObservedAtMs: number; amountAtomic: string; debitAtomic: string;
}>;
export type OperationReason = 'missing' | 'missing-hash' | 'unavailable' | 'mismatch' | 'not-final' | 'observation-stale' |
  'lineage-unresolved' | 'multiple-attempts';
export type OperationProjection = Readonly<{
  state: 'unverified' | 'stale' | 'unknown' | 'reconciliation-required' | 'verified';
  reason?: OperationReason; attemptId?: string; recordedRevision?: number; evidence?: ProjectedTransactionEvidence;
}>;
export type AuthoritativeInvoiceProjection = Readonly<{
  schemaVersion: 2; source: 'authoritative'; execution: 'disabled'; id: string; digest: string; revision: number;
  chainId: 42220; tokens: Readonly<{ buy: Readonly<{ address: string; decimals: 6 }>; sell: Readonly<{ address: string; decimals: 6 }> }>;
  targetAtomic: string; maxDebitAtomic: string; recipient: string; taker: string;
  observedAtMs: number; provenance: Readonly<{ invoice: 'invoice-store' }>;
  approval: AuthorizationSummary; consent: AuthorizationSummary;
  conversion: OperationProjection; payout: OperationProjection;
  settlement: 'unverified' | 'reconciliation-required' | 'settled';
}>;

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const uint = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const observationTime = (value: unknown): value is number => uint(value) && value > 0 && value <= 8_640_000_000_000_000;
const digestValue = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^0x[a-f0-9]{64}$/.test(value);
const address = (value: unknown): value is string => typeof value === 'string' && /^0x[a-f0-9]{40}$/.test(value) && value !== '0x' + '0'.repeat(40);
const atoms = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const positive = (value: unknown): value is string => atoms(value) && value !== '0';
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch { return false; }
}

const sameCommitment = (value: CommitmentBinding, binding: CommitmentBinding) =>
  value.tenantId === binding.tenantId && value.invoiceId === binding.invoiceId && value.digest === binding.digest;

function fresh(observed: unknown, opts: ProjectionOptions) {
  return observationTime(observed) && observed <= opts.nowMs && opts.nowMs - observed <= opts.maxObservationAgeMs;
}

type Selected = Readonly<{ attempt: StoredAttempt | null; projection: OperationProjection }>;

/** Chooses the single attempt that can carry evidence for an operation, or explains why none can. Fails closed. */
export function selectAttempt(binding: InvoiceBinding, operation: InvoiceOperation, attempts: readonly unknown[]):
    Readonly<{ attempt: StoredAttempt } | { projection: OperationProjection }> {
  if (!Array.isArray(attempts)) return { projection: { state: 'reconciliation-required', reason: 'unavailable' } };
  for (const a of attempts as StoredAttempt[]) {
    if (!isAttested(a) || a.source !== 'attempt-store' || !sameCommitment(a, binding) || a.operation !== operation || !id(a.id)) {
      return { projection: { state: 'reconciliation-required', reason: 'mismatch' } };
    }
  }
  const active = (attempts as StoredAttempt[]).filter(a => a.closed !== 'reconciled-not-landed');
  if (active.length === 0) return { projection: { state: 'unverified', reason: 'missing' } };
  const unresolved = active.find(a => a.lineage !== 'recorded' || a.recordedRevision === null || !a.authorization || !a.envelope);
  if (unresolved) return { projection: { state: 'reconciliation-required', reason: 'lineage-unresolved', attemptId: unresolved.id } };
  if (active.length > 1) return { projection: { state: 'reconciliation-required', reason: 'multiple-attempts', attemptId: active[0].id } };
  const attempt = active[0];
  if (!uint(attempt.recordedRevision) || attempt.recordedRevision > binding.revision) {
    return { projection: { state: 'reconciliation-required', reason: 'mismatch', attemptId: attempt.id } };
  }
  return { attempt };
}

function transactionMatches(tx: ObservedTransaction, invoice: Invoice, binding: InvoiceBinding, attempt: StoredAttempt, operation: InvoiceOperation) {
  const receiving = operation === 'conversion' ? invoice.taker : invoice.recipient;
  return isAttested(tx) && tx.source === 'transaction-verifier' && sameCommitment(tx, binding) &&
    tx.revision === attempt.recordedRevision && tx.operation === operation &&
    tx.attemptId === attempt.id && tx.hash === attempt.hash && tx.chainId === invoice.chain &&
    tx.buyToken === invoice.buy && tx.sellToken === invoice.sell && tx.sender === invoice.taker && tx.recipient === receiving &&
    positive(tx.amountAtomic) && tx.amountAtomic === invoice.buyAmount && atoms(tx.debitAtomic) &&
    (operation === 'conversion' ? positive(tx.debitAtomic) && BigInt(tx.debitAtomic) <= BigInt(invoice.maxSell) : tx.debitAtomic === '0') &&
    positive(tx.blockNumber) && hash(tx.blockHash) && tx.success === true;
}

export function projectOperation(
  binding: InvoiceBinding, invoice: Invoice, operation: InvoiceOperation, attempt: StoredAttempt,
  tx: ObservedTransaction | null, canonical: CanonicalBlockObservation | null, opts: ProjectionOptions,
): OperationProjection {
  const attemptId = attempt.id;
  const recordedRevision = attempt.recordedRevision as number;
  if (attempt.hash === null) return { state: 'unknown', reason: 'missing-hash', attemptId, recordedRevision };
  if (!hash(attempt.hash)) return { state: 'reconciliation-required', reason: 'mismatch', attemptId, recordedRevision };
  if (!tx) return { state: 'unknown', reason: 'unavailable', attemptId, recordedRevision };
  if (!transactionMatches(tx, invoice, binding, attempt, operation)) return { state: 'reconciliation-required', reason: 'mismatch', attemptId, recordedRevision };
  if (!canonical) return { state: 'unknown', reason: 'unavailable', attemptId, recordedRevision };
  if (!isAttested(canonical) || canonical.source !== 'canonical-chain-reader' || canonical.chainId !== invoice.chain ||
      canonical.blockNumber !== tx.blockNumber || canonical.blockHash !== tx.blockHash || !observationTime(canonical.blockTimestampMs) ||
      !positive(canonical.finalizedBlockNumber) || !hash(canonical.finalizedBlockHash) ||
      (canonical.finalizedBlockNumber === canonical.blockNumber && canonical.finalizedBlockHash !== canonical.blockHash)) {
    return { state: 'reconciliation-required', reason: 'mismatch', attemptId, recordedRevision };
  }
  if (!fresh(tx.observedAtMs, opts) || !fresh(canonical.observedAtMs, opts)) {
    return { state: 'stale', reason: 'observation-stale', attemptId, recordedRevision };
  }
  if (BigInt(canonical.finalizedBlockNumber) < BigInt(tx.blockNumber)) {
    return { state: 'reconciliation-required', reason: 'not-final', attemptId, recordedRevision };
  }
  return {
    state: 'verified', attemptId, recordedRevision,
    evidence: {
      source: tx.source, canonicalSource: canonical.source, hash: tx.hash,
      blockNumber: tx.blockNumber, blockHash: tx.blockHash, blockTimestampMs: canonical.blockTimestampMs,
      finalizedBlockNumber: canonical.finalizedBlockNumber, finalizedBlockHash: canonical.finalizedBlockHash,
      observedAtMs: tx.observedAtMs, canonicalObservedAtMs: canonical.observedAtMs,
      amountAtomic: tx.amountAtomic, debitAtomic: tx.debitAtomic,
    },
  };
}

const fingerprintMatches = (f: AuthorizationFingerprint | null, invoice: Invoice, digest: string, expiresAtMs: number) =>
  !!f && f.digest === digest && f.approvalSigner === invoice.approver && f.consentSigner === invoice.recipient && f.expiresAtMs === expiresAtMs;

export function projectAuthorization(
  binding: InvoiceBinding, purpose: AuthorizationPurpose, invoice: Invoice,
  observed: ObservedAuthorization | null, operations: readonly Selected[], opts: ProjectionOptions,
): AuthorizationSummary {
  const expectedSigner = purpose === 'invoice approval' ? invoice.approver : invoice.recipient;
  if (!observed) return { purpose, state: 'unverified', reason: 'missing' };
  if (!isAttested(observed) || observed.source !== 'authorization-verifier' || !sameCommitment(observed, binding) ||
      observed.purpose !== purpose || observed.signer !== expectedSigner || observed.audience !== opts.expectedAudience ||
      observed.expiresAtMs !== invoice.expires || !observationTime(observed.observedAtMs)) {
    return { purpose, state: 'unverified', reason: 'mismatch' };
  }
  // Every claimed attempt must have been claimed under exactly this authorization, before it expired.
  for (const s of operations) {
    if (s.attempt && (!fingerprintMatches(s.attempt.authorization, invoice, binding.digest, observed.expiresAtMs) ||
        s.attempt.createdAtMs >= observed.expiresAtMs)) {
      return { purpose, state: 'unverified', reason: 'mismatch' };
    }
  }
  if (!fresh(observed.observedAtMs, opts)) return { purpose, state: 'stale', reason: 'observation-stale' };
  const { source, signer, audience, digest, expiresAtMs, observedAtMs } = observed;
  const evidence = { source, signer, audience, digest, expiresAtMs, observedAtMs };
  if (observed.expiresAtMs > opts.nowMs) return { purpose, state: 'verified', evidence };
  // Expired now. It remains valid for a historical payment only if both operations are independently finalized and
  // both executed (canonical block time) before expiry, under the authorization each attempt recorded.
  const [conversion, payout] = operations;
  const c = conversion?.projection.evidence, p = payout?.projection.evidence;
  if (conversion?.projection.state === 'verified' && payout?.projection.state === 'verified' && c && p &&
      conversion.attempt && payout.attempt) {
    const executedAtMs = Math.max(c.blockTimestampMs, p.blockTimestampMs);
    if (executedAtMs < observed.expiresAtMs) return { purpose, state: 'verified-at-execution', evidence, executedAtMs };
  }
  return { purpose, state: 'stale', reason: 'expired' };
}

const authorized = (a: AuthorizationSummary) => a.state === 'verified' || a.state === 'verified-at-execution';
function settlementState(approval: AuthorizationSummary, consent: AuthorizationSummary, conversion: OperationProjection, payout: OperationProjection) {
  const unresolved = (op: OperationProjection) => op.state === 'unknown' || op.state === 'stale' || op.state === 'reconciliation-required';
  if (unresolved(conversion) || unresolved(payout)) return 'reconciliation-required';
  if (payout.state !== 'verified') return 'unverified';
  if (!conversion.evidence || !payout.evidence || conversion.state !== 'verified' ||
      !authorized(approval) || !authorized(consent) ||
      conversion.attemptId === payout.attemptId || conversion.evidence.hash === payout.evidence.hash ||
      BigInt(payout.evidence.blockNumber) < BigInt(conversion.evidence.blockNumber) ||
      (payout.evidence.blockNumber === conversion.evidence.blockNumber && payout.evidence.blockHash !== conversion.evidence.blockHash) ||
      (payout.evidence.finalizedBlockNumber === conversion.evidence.finalizedBlockNumber &&
        payout.evidence.finalizedBlockHash !== conversion.evidence.finalizedBlockHash)) {
    return 'reconciliation-required';
  }
  return 'settled';
}

async function guardedOperation<Viewer>(
  sources: ProjectionSources<Viewer>, binding: InvoiceBinding, invoice: Invoice, operation: InvoiceOperation, opts: ProjectionOptions,
): Promise<Selected> {
  let attempts: readonly StoredAttempt[];
  try { attempts = await sources.readAttempts(Object.freeze({ tenantId: binding.tenantId, invoiceId: binding.invoiceId, digest: binding.digest }), operation); }
  catch { return { attempt: null, projection: { state: 'reconciliation-required', reason: 'unavailable' } }; }
  const selected = selectAttempt(binding, operation, attempts);
  if ('projection' in selected) return { attempt: null, projection: selected.projection };
  const attempt = selected.attempt;
  let tx: ObservedTransaction | null = null;
  let canonical: CanonicalBlockObservation | null = null;
  if (hash(attempt.hash)) {
    try {
      tx = await sources.observeTransaction(attempt, invoice);
      if (tx && transactionMatches(tx, invoice, binding, attempt, operation)) {
        canonical = await sources.observeCanonicalBlock(invoice.chain, tx.blockNumber);
      }
    } catch { /* The projector represents unavailable evidence as unresolved. */ }
  }
  return { attempt, projection: projectOperation(binding, invoice, operation, attempt, tx, canonical, opts) };
}

/** Internal query, never an HTTP handler. An unauthorized or mismatched record yields no invoice. */
export async function readAuthoritativeInvoice<Viewer>(
  request: Readonly<{ viewer: Viewer; invoiceId: string }>, sources: ProjectionSources<Viewer>, opts: ProjectionOptions,
): Promise<AuthoritativeInvoiceProjection | null> {
  const invoiceId = request.invoiceId;
  if (!id(invoiceId) || !observationTime(opts.nowMs) || !uint(opts.maxObservationAgeMs) ||
      opts.maxObservationAgeMs === 0 || !origin(opts.expectedAudience)) return null;

  let stored: StoredInvoice | null;
  let invoice: Invoice;
  let binding: InvoiceBinding;
  try {
    const grant = await sources.authorize(request.viewer, invoiceId);
    if (!grant || grant.invoiceId !== invoiceId || !id(grant.tenantId)) return null;
    const tenantId = grant.tenantId;
    stored = await sources.readInvoice(Object.freeze({ tenantId, invoiceId }));
    if (!stored || !isAttested(stored) || stored.source !== 'invoice-store' || stored.tenantId !== tenantId ||
        stored.invoice.id !== invoiceId || !uint(stored.revision) || !fresh(stored.observedAtMs, opts) ||
        !digestValue(stored.digest) || !positive(stored.invoice.buyAmount) || !positive(stored.invoice.maxSell)) return null;
    const commitment = commit(stored.invoice);
    invoice = commitment.invoice;
    if (commitment.digest !== stored.digest || invoice.approver === invoice.recipient ||
        invoice.recipient === invoice.taker || !observationTime(invoice.expires)) return null;
    binding = Object.freeze({ tenantId, invoiceId, digest: stored.digest, revision: stored.revision });
  } catch { return null; }

  const observe = async (purpose: AuthorizationPurpose) => {
    try { return await sources.observeAuthorization(Object.freeze({ tenantId: binding.tenantId, invoiceId, digest: binding.digest }), purpose); }
    catch { return null; /* No evidence of authorization is equivalent to an unverified summary. */ }
  };
  const [approvalObserved, consentObserved, conversion, payout] = await Promise.all([
    observe('invoice approval'), observe('recipient consent'),
    guardedOperation(sources, binding, invoice, 'conversion', opts),
    guardedOperation(sources, binding, invoice, 'payout', opts),
  ]);
  const approval = projectAuthorization(binding, 'invoice approval', invoice, approvalObserved, [conversion, payout], opts);
  const consent = projectAuthorization(binding, 'recipient consent', invoice, consentObserved, [conversion, payout], opts);
  const projection: AuthoritativeInvoiceProjection = {
    schemaVersion: 2, source: 'authoritative', execution: 'disabled', id: invoiceId,
    digest: binding.digest, revision: binding.revision, chainId: chain,
    tokens: { buy: { address: cngn, decimals: 6 }, sell: { address: usdt, decimals: 6 } },
    targetAtomic: invoice.buyAmount, maxDebitAtomic: invoice.maxSell, recipient: invoice.recipient, taker: invoice.taker,
    observedAtMs: stored.observedAtMs, provenance: { invoice: 'invoice-store' },
    approval, consent, conversion: conversion.projection, payout: payout.projection,
    settlement: settlementState(approval, consent, conversion.projection, payout.projection),
  };
  return isAuthoritativeInvoiceProjection(projection) ? projection : null;
}

type WireObject = Record<string, unknown>;
function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is WireObject {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function oneOf(value: unknown, choices: readonly string[]) { return typeof value === 'string' && choices.includes(value); }

function authorizationWire(value: unknown, purpose: AuthorizationPurpose, digest: string, executed: number | null, signer?: string) {
  if (!keys(value, ['state', 'purpose'], ['reason', 'evidence', 'executedAtMs']) || value.purpose !== purpose) return false;
  const evidenceOk = (e: unknown): e is WireObject => keys(e, ['source', 'signer', 'audience', 'digest', 'expiresAtMs', 'observedAtMs']) &&
    e.source === 'authorization-verifier' && address(e.signer) && (!signer || signer === e.signer) &&
    origin(e.audience) && e.digest === digest && observationTime(e.expiresAtMs) && observationTime(e.observedAtMs);
  if (value.state === 'verified') {
    return !Object.hasOwn(value, 'reason') && !Object.hasOwn(value, 'executedAtMs') && evidenceOk(value.evidence) &&
      (value.evidence.observedAtMs as number) < (value.evidence.expiresAtMs as number);
  }
  if (value.state === 'verified-at-execution') {
    const e = value.evidence;
    return !Object.hasOwn(value, 'reason') && evidenceOk(e) && observationTime(value.executedAtMs) &&
      executed !== null && value.executedAtMs === executed && (value.executedAtMs as number) < (e.expiresAtMs as number);
  }
  return !Object.hasOwn(value, 'evidence') && !Object.hasOwn(value, 'executedAtMs') && (
    (value.state === 'unverified' && oneOf(value.reason, ['missing', 'mismatch'])) ||
    (value.state === 'stale' && oneOf(value.reason, ['expired', 'observation-stale']))
  );
}

function operationWire(value: unknown, target: string, cap: string, operation: InvoiceOperation, revision: number) {
  if (!keys(value, ['state'], ['reason', 'attemptId', 'recordedRevision', 'evidence']) ||
      (Object.hasOwn(value, 'attemptId') && !id(value.attemptId)) ||
      (Object.hasOwn(value, 'recordedRevision') && (!uint(value.recordedRevision) || value.recordedRevision > revision || !Object.hasOwn(value, 'attemptId')))) return false;
  if (value.state === 'verified') {
    const e = value.evidence;
    return id(value.attemptId) && uint(value.recordedRevision) && !Object.hasOwn(value, 'reason') && keys(e, [
      'source', 'canonicalSource', 'hash', 'blockNumber', 'blockHash', 'blockTimestampMs', 'finalizedBlockNumber', 'finalizedBlockHash',
      'observedAtMs', 'canonicalObservedAtMs', 'amountAtomic', 'debitAtomic',
    ]) && e.source === 'transaction-verifier' && e.canonicalSource === 'canonical-chain-reader' &&
      hash(e.hash) && positive(e.blockNumber) && hash(e.blockHash) && observationTime(e.blockTimestampMs) && positive(e.finalizedBlockNumber) &&
      hash(e.finalizedBlockHash) && BigInt(e.finalizedBlockNumber) >= BigInt(e.blockNumber) &&
      (e.finalizedBlockNumber !== e.blockNumber || e.finalizedBlockHash === e.blockHash) &&
      observationTime(e.observedAtMs) && observationTime(e.canonicalObservedAtMs) &&
      e.amountAtomic === target && atoms(e.debitAtomic) &&
      (operation === 'conversion' ? positive(e.debitAtomic) && BigInt(e.debitAtomic) <= BigInt(cap) : e.debitAtomic === '0');
  }
  if (Object.hasOwn(value, 'evidence')) return false;
  switch (value.state) {
    case 'unverified': return !Object.hasOwn(value, 'attemptId') && value.reason === 'missing';
    case 'stale': return id(value.attemptId) && value.reason === 'observation-stale';
    case 'unknown': return id(value.attemptId) && oneOf(value.reason, ['missing-hash', 'unavailable']);
    case 'reconciliation-required': return oneOf(value.reason, ['mismatch', 'not-final', 'unavailable', 'lineage-unresolved', 'multiple-attempts']) &&
      (value.reason !== 'lineage-unresolved' && value.reason !== 'multiple-attempts' || id(value.attemptId));
    default: return false;
  }
}

function tokenWire(value: unknown, token: string) {
  return keys(value, ['address', 'decimals']) && value.address === token && value.decimals === 6;
}

/** Validates the versioned wire shape and consistency, not the authority of its transport. */
export function isAuthoritativeInvoiceProjection(value: unknown): value is AuthoritativeInvoiceProjection {
  if (!keys(value, [
    'schemaVersion', 'source', 'execution', 'id', 'digest', 'revision', 'chainId', 'tokens', 'targetAtomic',
    'maxDebitAtomic', 'recipient', 'taker', 'observedAtMs', 'provenance', 'approval', 'consent', 'conversion', 'payout', 'settlement',
  ]) || value.schemaVersion !== 2 || value.source !== 'authoritative' || value.execution !== 'disabled' || !id(value.id) ||
      !digestValue(value.digest) || !uint(value.revision) || value.chainId !== chain || !keys(value.tokens, ['buy', 'sell']) ||
      !tokenWire(value.tokens.buy, cngn) || !tokenWire(value.tokens.sell, usdt) || !positive(value.targetAtomic) ||
      !positive(value.maxDebitAtomic) || !address(value.recipient) || !address(value.taker) || value.recipient === value.taker ||
      !observationTime(value.observedAtMs) || !keys(value.provenance, ['invoice']) || value.provenance.invoice !== 'invoice-store' ||
      !operationWire(value.conversion, value.targetAtomic, value.maxDebitAtomic, 'conversion', value.revision) ||
      !operationWire(value.payout, value.targetAtomic, value.maxDebitAtomic, 'payout', value.revision)) return false;
  const c = value.conversion as OperationProjection, p = value.payout as OperationProjection;
  const executed = c.state === 'verified' && p.state === 'verified' && c.evidence && p.evidence
    ? Math.max(c.evidence.blockTimestampMs, p.evidence.blockTimestampMs) : null;
  if (!authorizationWire(value.approval, 'invoice approval', value.digest, executed) ||
      !authorizationWire(value.consent, 'recipient consent', value.digest, executed, value.recipient)) return false;
  const { approval, consent, conversion, payout, settlement } = value as AuthoritativeInvoiceProjection;
  return settlement === settlementState(approval, consent, conversion, payout);
}
