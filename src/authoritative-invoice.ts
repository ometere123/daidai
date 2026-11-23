import { chain, cngn, commit, usdt, type Invoice } from './invoice.ts';

export type AuthorizationPurpose = 'invoice approval' | 'recipient consent';
export type InvoiceOperation = 'conversion' | 'payout';
export type ViewerGrant = Readonly<{ tenantId: string; invoiceId: string }>;
export type InvoiceBinding = ViewerGrant & Readonly<{ digest: string; revision: number }>;
export type StoredInvoice = Readonly<{
  source: 'invoice-store'; tenantId: string; invoice: Invoice;
  digest: string; revision: number; observedAtMs: number;
}>;
export type ObservedAuthorization = InvoiceBinding & Readonly<{
  source: 'authorization-verifier'; purpose: AuthorizationPurpose; signer: string;
  audience: string; expiresAtMs: number; observedAtMs: number;
}>;
export type StoredAttempt = InvoiceBinding & Readonly<{
  source: 'attempt-store'; operation: InvoiceOperation; id: string; hash: string | null;
}>;
export type ObservedTransaction = InvoiceBinding & Readonly<{
  source: 'transaction-verifier'; operation: InvoiceOperation; attemptId: string;
  hash: string; chainId: number; buyToken: string; sellToken: string; sender: string;
  recipient: string; amountAtomic: string; debitAtomic: string; blockNumber: string;
  blockHash: string; success: boolean; observedAtMs: number;
}>;
export type CanonicalBlockObservation = Readonly<{
  source: 'canonical-chain-reader'; chainId: number; blockNumber: string; blockHash: string;
  finalizedBlockNumber: string; finalizedBlockHash: string; observedAtMs: number;
}>;

/** Ports are supplied only by trusted server composition; never accept adapter results from clients. */
export interface ProjectionSources<Viewer = unknown> {
  authorize(viewer: Viewer, invoiceId: string): Promise<ViewerGrant | null>;
  readInvoice(grant: ViewerGrant): Promise<StoredInvoice | null>;
  observeAuthorization(binding: InvoiceBinding, purpose: AuthorizationPurpose): Promise<ObservedAuthorization | null>;
  readAttempt(binding: InvoiceBinding, operation: InvoiceOperation): Promise<StoredAttempt | null>;
  observeTransaction(attempt: StoredAttempt): Promise<ObservedTransaction | null>;
  observeCanonicalBlock(chainId: number, blockNumber: string): Promise<CanonicalBlockObservation | null>;
}

export type ProjectionOptions = Readonly<{ nowMs: number; maxObservationAgeMs: number; expectedAudience: string }>;
export type AuthorizationSummary = Readonly<{
  purpose: AuthorizationPurpose; state: 'unverified' | 'stale' | 'verified';
  reason?: 'missing' | 'mismatch' | 'expired' | 'observation-stale';
  evidence?: Readonly<Pick<ObservedAuthorization, 'source' | 'signer' | 'audience' | 'digest' | 'expiresAtMs' | 'observedAtMs'>>;
}>;
export type ProjectedTransactionEvidence = Readonly<{
  source: 'transaction-verifier'; canonicalSource: 'canonical-chain-reader';
  hash: string; blockNumber: string; blockHash: string; finalizedBlockNumber: string; finalizedBlockHash: string;
  observedAtMs: number; canonicalObservedAtMs: number; amountAtomic: string; debitAtomic: string;
}>;
export type OperationProjection = Readonly<{
  state: 'unverified' | 'stale' | 'unknown' | 'reconciliation-required' | 'verified';
  reason?: 'missing' | 'missing-hash' | 'unavailable' | 'mismatch' | 'not-final' | 'observation-stale';
  attemptId?: string; evidence?: ProjectedTransactionEvidence;
}>;
export type AuthoritativeInvoiceProjection = Readonly<{
  schemaVersion: 1; source: 'authoritative'; execution: 'disabled'; id: string; digest: string; revision: number;
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

function bound(value: InvoiceBinding, binding: InvoiceBinding) {
  return value.tenantId === binding.tenantId && value.invoiceId === binding.invoiceId &&
    value.digest === binding.digest && value.revision === binding.revision;
}

function fresh(observed: unknown, opts: ProjectionOptions) {
  return observationTime(observed) && observed <= opts.nowMs && opts.nowMs - observed <= opts.maxObservationAgeMs;
}

export function projectAuthorization(
  binding: InvoiceBinding, purpose: AuthorizationPurpose, expectedSigner: string, invoiceExpiry: number,
  observed: ObservedAuthorization | null, opts: ProjectionOptions,
): AuthorizationSummary {
  if (!observed) return { purpose, state: 'unverified', reason: 'missing' };
  if (observed.source !== 'authorization-verifier' || !bound(observed, binding) || observed.purpose !== purpose ||
      observed.signer !== expectedSigner || observed.audience !== opts.expectedAudience || observed.expiresAtMs !== invoiceExpiry ||
      !observationTime(observed.observedAtMs) || observed.observedAtMs >= observed.expiresAtMs) {
    return { purpose, state: 'unverified', reason: 'mismatch' };
  }
  if (observed.expiresAtMs <= opts.nowMs) return { purpose, state: 'stale', reason: 'expired' };
  if (!fresh(observed.observedAtMs, opts)) return { purpose, state: 'stale', reason: 'observation-stale' };
  const { source, signer, audience, digest, expiresAtMs, observedAtMs } = observed;
  return { purpose, state: 'verified', evidence: { source, signer, audience, digest, expiresAtMs, observedAtMs } };
}

function attemptMatches(attempt: StoredAttempt, binding: InvoiceBinding, operation: InvoiceOperation) {
  return attempt.source === 'attempt-store' && bound(attempt, binding) && attempt.operation === operation && id(attempt.id);
}

function transactionMatches(tx: ObservedTransaction, invoice: Invoice, binding: InvoiceBinding, attempt: StoredAttempt, operation: InvoiceOperation) {
  const receiving = operation === 'conversion' ? invoice.taker : invoice.recipient;
  return tx.source === 'transaction-verifier' && bound(tx, binding) && tx.operation === operation &&
    tx.attemptId === attempt.id && tx.hash === attempt.hash && tx.chainId === invoice.chain &&
    tx.buyToken === invoice.buy && tx.sellToken === invoice.sell && tx.sender === invoice.taker && tx.recipient === receiving &&
    positive(tx.amountAtomic) && tx.amountAtomic === invoice.buyAmount && atoms(tx.debitAtomic) &&
    (operation === 'conversion' ? positive(tx.debitAtomic) && BigInt(tx.debitAtomic) <= BigInt(invoice.maxSell) : tx.debitAtomic === '0') &&
    positive(tx.blockNumber) && hash(tx.blockHash) && tx.success === true;
}

export function projectOperation(
  binding: InvoiceBinding, invoice: Invoice, operation: InvoiceOperation, attempt: StoredAttempt | null,
  tx: ObservedTransaction | null, canonical: CanonicalBlockObservation | null, opts: ProjectionOptions,
): OperationProjection {
  if (!attempt) return { state: 'unverified', reason: 'missing' };
  if (!attemptMatches(attempt, binding, operation)) return { state: 'reconciliation-required', reason: 'mismatch' };
  const attemptId = attempt.id;
  if (attempt.hash === null) return { state: 'unknown', reason: 'missing-hash', attemptId };
  if (!hash(attempt.hash)) return { state: 'reconciliation-required', reason: 'mismatch', attemptId };
  if (!tx) return { state: 'unknown', reason: 'unavailable', attemptId };
  if (!transactionMatches(tx, invoice, binding, attempt, operation)) return { state: 'reconciliation-required', reason: 'mismatch', attemptId };
  if (!canonical) return { state: 'unknown', reason: 'unavailable', attemptId };
  if (canonical.source !== 'canonical-chain-reader' || canonical.chainId !== invoice.chain ||
      canonical.blockNumber !== tx.blockNumber || canonical.blockHash !== tx.blockHash ||
      !positive(canonical.finalizedBlockNumber) || !hash(canonical.finalizedBlockHash) ||
      (canonical.finalizedBlockNumber === canonical.blockNumber && canonical.finalizedBlockHash !== canonical.blockHash)) {
    return { state: 'reconciliation-required', reason: 'mismatch', attemptId };
  }
  if (!fresh(tx.observedAtMs, opts) || !fresh(canonical.observedAtMs, opts)) {
    return { state: 'stale', reason: 'observation-stale', attemptId };
  }
  if (BigInt(canonical.finalizedBlockNumber) < BigInt(tx.blockNumber)) {
    return { state: 'reconciliation-required', reason: 'not-final', attemptId };
  }
  return {
    state: 'verified', attemptId,
    evidence: {
      source: tx.source, canonicalSource: canonical.source, hash: tx.hash,
      blockNumber: tx.blockNumber, blockHash: tx.blockHash, finalizedBlockNumber: canonical.finalizedBlockNumber,
      finalizedBlockHash: canonical.finalizedBlockHash, observedAtMs: tx.observedAtMs, canonicalObservedAtMs: canonical.observedAtMs,
      amountAtomic: tx.amountAtomic, debitAtomic: tx.debitAtomic,
    },
  };
}

function settlementState(approval: AuthorizationSummary, consent: AuthorizationSummary, conversion: OperationProjection, payout: OperationProjection) {
  const unresolved = (op: OperationProjection) => op.state === 'unknown' || op.state === 'stale' || op.state === 'reconciliation-required';
  if (unresolved(conversion) || unresolved(payout)) return 'reconciliation-required';
  if (payout.state !== 'verified') return 'unverified';
  if (!conversion.evidence || !payout.evidence || conversion.state !== 'verified' ||
      approval.state !== 'verified' || consent.state !== 'verified' ||
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
): Promise<OperationProjection> {
  let attempt: StoredAttempt | null;
  try { attempt = await sources.readAttempt(binding, operation); }
  catch { return { state: 'reconciliation-required', reason: 'unavailable' }; }
  let tx: ObservedTransaction | null = null;
  let canonical: CanonicalBlockObservation | null = null;
  if (attempt && attemptMatches(attempt, binding, operation) && hash(attempt.hash)) {
    try {
      tx = await sources.observeTransaction(attempt);
      if (tx && transactionMatches(tx, invoice, binding, attempt, operation)) {
        canonical = await sources.observeCanonicalBlock(invoice.chain, tx.blockNumber);
      }
    } catch { /* The projector represents unavailable evidence as unresolved. */ }
  }
  return projectOperation(binding, invoice, operation, attempt, tx, canonical, opts);
}

/** Internal query, never an HTTP handler. An unauthorized or mismatched record yields no invoice. */
export async function readAuthoritativeInvoice<Viewer>(
  request: Readonly<{ viewer: Viewer; invoiceId: string }>, sources: ProjectionSources<Viewer>, opts: ProjectionOptions,
): Promise<AuthoritativeInvoiceProjection | null> {
  const invoiceId = request.invoiceId;
  if (!id(invoiceId) || !observationTime(opts.nowMs) || !uint(opts.maxObservationAgeMs) ||
      opts.maxObservationAgeMs === 0 || !origin(opts.expectedAudience)) return null;

  let stored: StoredInvoice | null;
  let tenantId: string;
  let invoice: Invoice;
  let binding: InvoiceBinding;
  try {
    const grant = await sources.authorize(request.viewer, invoiceId);
    if (!grant || grant.invoiceId !== invoiceId || !id(grant.tenantId)) return null;
    tenantId = grant.tenantId;
    stored = await sources.readInvoice(Object.freeze({ tenantId, invoiceId }));
    if (!stored || stored.source !== 'invoice-store' || stored.tenantId !== tenantId ||
        stored.invoice.id !== invoiceId || !uint(stored.revision) || !fresh(stored.observedAtMs, opts) ||
        !digestValue(stored.digest) || !positive(stored.invoice.buyAmount) || !positive(stored.invoice.maxSell)) return null;
    const commitment = commit(stored.invoice);
    invoice = commitment.invoice;
    if (commitment.digest !== stored.digest || invoice.approver === invoice.recipient ||
        invoice.recipient === invoice.taker || !observationTime(invoice.expires)) return null;
    binding = Object.freeze({ tenantId, invoiceId, digest: stored.digest, revision: stored.revision });
  } catch { return null; }

  const summarize = async (purpose: AuthorizationPurpose, signer: string) => {
    let observed: ObservedAuthorization | null = null;
    try { observed = await sources.observeAuthorization(binding, purpose); }
    catch { /* No evidence of authorization is equivalent to an unverified summary. */ }
    return projectAuthorization(binding, purpose, signer, invoice.expires, observed, opts);
  };
  const [approval, consent, conversion, payout] = await Promise.all([
    summarize('invoice approval', invoice.approver),
    summarize('recipient consent', invoice.recipient),
    guardedOperation(sources, binding, invoice, 'conversion', opts),
    guardedOperation(sources, binding, invoice, 'payout', opts),
  ]);
  const projection: AuthoritativeInvoiceProjection = {
    schemaVersion: 1, source: 'authoritative', execution: 'disabled', id: invoiceId,
    digest: binding.digest, revision: binding.revision, chainId: chain,
    tokens: { buy: { address: cngn, decimals: 6 }, sell: { address: usdt, decimals: 6 } },
    targetAtomic: invoice.buyAmount, maxDebitAtomic: invoice.maxSell, recipient: invoice.recipient, taker: invoice.taker,
    observedAtMs: stored.observedAtMs, provenance: { invoice: 'invoice-store' },
    approval, consent, conversion, payout, settlement: settlementState(approval, consent, conversion, payout),
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

function authorizationWire(value: unknown, purpose: AuthorizationPurpose, digest: string, signer?: string) {
  if (!keys(value, ['state', 'purpose'], ['reason', 'evidence']) || value.purpose !== purpose) return false;
  if (value.state === 'verified') {
    const e = value.evidence;
    return !Object.hasOwn(value, 'reason') && keys(e, ['source', 'signer', 'audience', 'digest', 'expiresAtMs', 'observedAtMs']) &&
      e.source === 'authorization-verifier' && address(e.signer) && (!signer || signer === e.signer) &&
      origin(e.audience) && e.digest === digest && observationTime(e.expiresAtMs) &&
      observationTime(e.observedAtMs) && e.observedAtMs < e.expiresAtMs;
  }
  return !Object.hasOwn(value, 'evidence') && (
    (value.state === 'unverified' && oneOf(value.reason, ['missing', 'mismatch'])) ||
    (value.state === 'stale' && oneOf(value.reason, ['expired', 'observation-stale']))
  );
}

function operationWire(value: unknown, target: string, cap: string, operation: InvoiceOperation) {
  if (!keys(value, ['state'], ['reason', 'attemptId', 'evidence']) ||
      (Object.hasOwn(value, 'attemptId') && !id(value.attemptId))) return false;
  if (value.state === 'verified') {
    const e = value.evidence;
    return id(value.attemptId) && !Object.hasOwn(value, 'reason') && keys(e, [
      'source', 'canonicalSource', 'hash', 'blockNumber', 'blockHash', 'finalizedBlockNumber', 'finalizedBlockHash',
      'observedAtMs', 'canonicalObservedAtMs', 'amountAtomic', 'debitAtomic',
    ]) && e.source === 'transaction-verifier' && e.canonicalSource === 'canonical-chain-reader' &&
      hash(e.hash) && positive(e.blockNumber) && hash(e.blockHash) && positive(e.finalizedBlockNumber) &&
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
    case 'reconciliation-required': return oneOf(value.reason, ['mismatch', 'not-final', 'unavailable']);
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
  ]) || value.schemaVersion !== 1 || value.source !== 'authoritative' || value.execution !== 'disabled' || !id(value.id) ||
      !digestValue(value.digest) || !uint(value.revision) || value.chainId !== chain || !keys(value.tokens, ['buy', 'sell']) ||
      !tokenWire(value.tokens.buy, cngn) || !tokenWire(value.tokens.sell, usdt) || !positive(value.targetAtomic) ||
      !positive(value.maxDebitAtomic) || !address(value.recipient) || !address(value.taker) || value.recipient === value.taker ||
      !observationTime(value.observedAtMs) || !keys(value.provenance, ['invoice']) || value.provenance.invoice !== 'invoice-store' ||
      !authorizationWire(value.approval, 'invoice approval', value.digest) ||
      !authorizationWire(value.consent, 'recipient consent', value.digest, value.recipient) ||
      !operationWire(value.conversion, value.targetAtomic, value.maxDebitAtomic, 'conversion') ||
      !operationWire(value.payout, value.targetAtomic, value.maxDebitAtomic, 'payout')) return false;
  const { approval, consent, conversion, payout, settlement } = value as AuthoritativeInvoiceProjection;
  return settlement === settlementState(approval, consent, conversion, payout);
}
