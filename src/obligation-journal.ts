/**
 * The obligation journal (M1): one durable record of an agreement and everything done for it, in a single SQLite file.
 *
 * What it adds to the existing attempt lineage (attempt-lineage.ts), and nothing more:
 *  - `obligations`: the canonical committed invoice and both signatures, immutable once imported;
 *  - `reviewed_envelopes`: the exact calldata that was reviewed, committed in the SAME transaction as the attempt and its
 *    nonce reservation, so a claim never exists without the envelope it was claimed for;
 *  - a state derived only from persisted attempts, never from browser or process memory;
 *  - restart recovery: a fresh process re-verifies the persisted conversion against the chain and offers only the payout.
 *
 * It never dispatches. It has no wallet, no signer and no network of its own: chain reads go through an injected
 * transport (in production a `celoQuorum` of independent providers, which is read-only by construction).
 * An unknown, hashless or unverified attempt is never released, retried or replaced here: the only way forward is
 * evidence. `reconciled-not-landed` stays disabled in the schema.
 */
import { createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { AttemptLineageReader, AttemptLineageStore, envelopeOf, type AttemptLineage, type AttemptOperation, type NewAttempt } from './attempt-lineage.ts';
import { verifyAuthorization, type SignedAuthorization } from './authorization.ts';
import type { CeloReader } from './celo.ts';
import { canonicalBlockReader, transactionVerifier, type Rpc } from './chain-evidence.ts';
import { atomic, chain, check, commit, type Invoice } from './invoice-core.ts';
import { isPreparedCandidate, reverifyConversion, reviewPayout, type Candidate, type PersistedConversion } from './settlement-review.ts';

export const JOURNAL_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS obligations (
  invoice_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, digest TEXT NOT NULL CHECK (length(digest) = 64),
  invoice TEXT NOT NULL, audience TEXT NOT NULL, approval_sig TEXT NOT NULL, consent_sig TEXT NOT NULL,
  imported_at_ms INTEGER NOT NULL
)`,
  `CREATE TRIGGER IF NOT EXISTS obligations_immutable BEFORE UPDATE ON obligations
  BEGIN SELECT RAISE(ABORT, 'obligations are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS obligations_no_delete BEFORE DELETE ON obligations
  BEGIN SELECT RAISE(ABORT, 'obligations are retained'); END`,
  `CREATE TABLE IF NOT EXISTS reviewed_envelopes (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts (attempt_id),
  action TEXT NOT NULL CHECK (action IN ('swap', 'payout')),
  sender TEXT NOT NULL, recipient TEXT NOT NULL, buy_token TEXT NOT NULL, sell_token TEXT NOT NULL,
  amount TEXT NOT NULL, debit TEXT NOT NULL,
  tx_to TEXT NOT NULL, tx_data TEXT NOT NULL, tx_value TEXT NOT NULL, chain_id INTEGER NOT NULL,
  bounds TEXT NOT NULL, reviewed_at_ms INTEGER NOT NULL
)`,
  `CREATE TRIGGER IF NOT EXISTS reviewed_envelopes_immutable BEFORE UPDATE ON reviewed_envelopes
  BEGIN SELECT RAISE(ABORT, 'reviewed envelopes are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS reviewed_envelopes_no_delete BEFORE DELETE ON reviewed_envelopes
  BEGIN SELECT RAISE(ABORT, 'reviewed envelopes are retained'); END`,
]);

export type JournalState =
  | 'AUTHORISED' | 'CONVERSION_CLAIMED' | 'CONVERSION_PENDING' | 'CONVERSION_UNKNOWN' | 'CONVERTED_UNPAID'
  | 'PAYOUT_CLAIMED' | 'PAYOUT_PENDING' | 'PAYOUT_UNKNOWN' | 'SETTLED' | 'RECONCILIATION_REQUIRED';
/** The only things a caller may do next. 'reconcile-*' means: investigate, never send again. */
export type NextAction =
  | 'prepare-conversion' | 'verify-conversion' | 'reconcile-conversion'
  | 'prepare-payout' | 'verify-payout' | 'reconcile-payout' | 'none' | 'escalate';
export type AttemptSummary = Readonly<{ id: string; dispatch: AttemptLineage['dispatch']; hash: string | null; closed: AttemptLineage['closed']; createdAtMs: number }>;
export type Inspection = Readonly<{
  invoiceId: string; digest: string; state: JournalState; nextAction: NextAction; reason: string;
  conversion: AttemptSummary | null; payout: AttemptSummary | null;
}>;

const summary = (a: AttemptLineage | null): AttemptSummary | null =>
  a && Object.freeze({ id: a.id, dispatch: a.dispatch, hash: a.hash, closed: a.closed, createdAtMs: a.createdAtMs });

/**
 * Pure. An attempt that was claimed but has no hash may or may not have reached the wallet, so it is treated as unknown:
 * the next action is to reconcile, never to send. A payout can only exist after a verified-final conversion.
 */
export function deriveState(conversion: AttemptSummary | null, payout: AttemptSummary | null):
    Pick<Inspection, 'state' | 'nextAction' | 'reason'> {
  const final = (a: AttemptSummary | null) => a?.closed === 'verified-final';
  if (payout) {
    if (!final(conversion)) return { state: 'RECONCILIATION_REQUIRED', nextAction: 'escalate', reason: 'a payout exists without a finalized conversion' };
    if (final(payout)) return { state: 'SETTLED', nextAction: 'none', reason: 'conversion and payout are both finalized' };
    if (payout.dispatch === 'outcome-unknown') return { state: 'PAYOUT_UNKNOWN', nextAction: 'reconcile-payout', reason: 'payout outcome unknown; do not resend' };
    if (payout.hash) return { state: 'PAYOUT_PENDING', nextAction: 'verify-payout', reason: 'payout hash recorded, finality not yet verified' };
    return { state: 'PAYOUT_CLAIMED', nextAction: 'reconcile-payout', reason: 'payout claimed without a hash; it may have been sent, do not resend' };
  }
  if (conversion) {
    if (final(conversion)) return { state: 'CONVERTED_UNPAID', nextAction: 'prepare-payout', reason: 'conversion finalized; only the payout remains' };
    if (conversion.dispatch === 'outcome-unknown') return { state: 'CONVERSION_UNKNOWN', nextAction: 'reconcile-conversion', reason: 'conversion outcome unknown; do not resend' };
    if (conversion.hash) return { state: 'CONVERSION_PENDING', nextAction: 'verify-conversion', reason: 'conversion hash recorded, finality not yet verified' };
    return { state: 'CONVERSION_CLAIMED', nextAction: 'reconcile-conversion', reason: 'conversion claimed without a hash; it may have been sent, do not resend' };
  }
  return { state: 'AUTHORISED', nextAction: 'prepare-conversion', reason: 'signed agreement imported; nothing claimed' };
}

type Obligation = Readonly<{ tenantId: string; invoice: Invoice; digest: string; audience: string; signatures: SignedAuthorization }>;
export type ConfirmResult =
  | Readonly<{ kind: 'final'; hash: string; blockNumber: string }>
  | Readonly<{ kind: 'pending'; reason: string }>
  | Readonly<{ kind: 'unverified'; reason: string }>
  | Readonly<{ kind: 'unavailable'; reason: string }>
  | Readonly<{ kind: 'blocked'; reason: string }>;
type Ports = Parameters<typeof reviewPayout>[3];
type Policy = Parameters<typeof reviewPayout>[4];
export type ResumeResult =
  | Readonly<{ kind: 'payout-review'; candidate: Awaited<ReturnType<typeof reviewPayout>> }>
  | Readonly<{ kind: 'blocked'; reason: 'continuation-required' | 'conversion-not-reverified' | 'journal-inconsistent'; detail: string }>
  | Readonly<{ kind: 'not-resumable'; state: JournalState; nextAction: NextAction }>;

const sha = (data: string) => createHash('sha256').update(data.toLowerCase()).digest('hex');

export class ObligationJournal {
  readonly #file: string;
  readonly #store: AttemptLineageStore;
  readonly #clock: () => number;

  constructor(file: string, opts: Readonly<{ clock: () => number }>) {
    this.#file = file; this.#clock = opts.clock;
    this.#store = new AttemptLineageStore(file);
    for (const statement of JOURNAL_SCHEMA_STATEMENTS) this.#store.db.exec(statement);
  }
  close() { this.#store.close_db(); }

  /** Test seam for adversarial raw-SQL checks. Production code never touches it. */
  get db() { return this.#store.db; }

  /**
   * Imports the signed agreement once. Both signatures are verified (role, audience, chain, digest, expiry). One stable
   * invoice id maps to exactly one commitment: re-importing the same terms is idempotent, any other terms are refused.
   */
  async importAgreement(input: Readonly<{ tenantId: string; invoice: Invoice; origin: string; signatures: SignedAuthorization }>) {
    const { invoice, digest } = commit(input.invoice);
    const now = this.#clock();
    await verifyAuthorization(invoice, digest, input.origin, input.signatures, now);
    const existing = this.db.prepare('SELECT digest, tenant_id FROM obligations WHERE invoice_id = ?').get(invoice.id) as { digest: string; tenant_id: string } | undefined;
    if (existing) {
      check(existing.digest === digest && existing.tenant_id === input.tenantId, 'invoice id is already bound to a different commitment');
      return { invoiceId: invoice.id, digest, created: false } as const;
    }
    this.db.prepare(`INSERT INTO obligations (invoice_id, tenant_id, digest, invoice, audience, approval_sig, consent_sig, imported_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(invoice.id, input.tenantId, digest, JSON.stringify(invoice), input.origin,
      input.signatures.approval, input.signatures.consent, now);
    return { invoiceId: invoice.id, digest, created: true } as const;
  }

  #obligation(invoiceId: string): Obligation {
    const r = this.db.prepare('SELECT * FROM obligations WHERE invoice_id = ?').get(invoiceId) as Record<string, string> | undefined;
    check(r, 'unknown obligation');
    const { invoice, digest } = commit(JSON.parse(r.invoice));
    check(digest === r.digest && invoice.id === r.invoice_id, 'stored obligation does not match its commitment');
    return Object.freeze({ tenantId: r.tenant_id, invoice, digest, audience: r.audience,
      signatures: Object.freeze({ approval: r.approval_sig as Hex, consent: r.consent_sig as Hex }) });
  }
  #latest(o: Obligation, operation: AttemptOperation): AttemptLineage | null {
    const reader = new AttemptLineageReader(this.#file);
    try { return reader.attempts({ tenantId: o.tenantId, invoiceId: o.invoice.id, digest: o.digest }, operation).at(-1) ?? null; }
    finally { reader.close(); }
  }

  /** State is derived from persisted attempts only. Safe to call any number of times, from any process. */
  inspect(invoiceId: string): Inspection {
    const o = this.#obligation(invoiceId);
    const foreign = this.db.prepare('SELECT count(*) AS n FROM attempts WHERE tenant_id = ? AND invoice_id = ? AND digest <> ?')
      .get(o.tenantId, o.invoice.id, o.digest) as { n: number };
    const conversion = summary(this.#latest(o, 'conversion')), payout = summary(this.#latest(o, 'payout'));
    const base = { invoiceId: o.invoice.id, digest: o.digest, conversion, payout };
    if (Number(foreign.n) > 0) return Object.freeze({ ...base, state: 'RECONCILIATION_REQUIRED', nextAction: 'escalate', reason: 'attempts exist under a different commitment for this invoice id' });
    return Object.freeze({ ...base, ...deriveState(conversion, payout) });
  }

  /**
   * Claims one operation. Attempt row, taker-nonce reservation and the exact reviewed calldata commit in one transaction,
   * BEFORE any provider or wallet handoff. 'existing' means this claim was already made: never dispatch again.
   * Only an envelope this process reviewed and simulated can be claimed, and only the operation the state permits.
   */
  claim(invoiceId: string, operation: AttemptOperation, input: Readonly<{ attemptId: string; candidate: Candidate; notAfterMs?: number }>) {
    const o = this.#obligation(invoiceId);
    const c = input.candidate, now = this.#clock();
    check(isPreparedCandidate(c), 'only a reviewed and simulated envelope can be claimed');
    check(c.digest === o.digest && c.sender === o.invoice.taker && c.tx.chainId === chain, 'candidate does not belong to this obligation');
    check(c.action === (operation === 'conversion' ? 'swap' : 'payout'), 'candidate does not match the operation');
    check(now < o.invoice.expires && (input.notAfterMs === undefined || now < input.notAfterMs), 'authorization or quote expired');
    const permitted = operation === 'conversion' ? 'prepare-conversion' : 'prepare-payout';
    const state = this.inspect(invoiceId);
    check(state.nextAction === permitted, `operation not permitted in state ${state.state}`);
    const nonce = Number(BigInt(c.bounds.nonce));
    check(Number.isSafeInteger(nonce) && nonce >= 0, 'invalid reviewed nonce');
    const attempt: NewAttempt = {
      attemptId: input.attemptId, tenantId: o.tenantId, invoiceId: o.invoice.id, digest: o.digest, recordedRevision: o.invoice.version,
      operation, createdAtMs: now,
      authorization: { digest: o.digest, approvalSigner: o.invoice.approver, consentSigner: o.invoice.recipient, expiresAtMs: o.invoice.expires },
      envelope: envelopeOf(c.tx),
    };
    const created = this.#store.recordAttempt(attempt, { chainId: chain, sender: o.invoice.taker, nonce }, () => {
      this.db.prepare(`INSERT INTO reviewed_envelopes (attempt_id, action, sender, recipient, buy_token, sell_token, amount, debit,
        tx_to, tx_data, tx_value, chain_id, bounds, reviewed_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.attemptId, c.action, c.sender, c.recipient, c.buyToken, c.sellToken, c.amount.toString(), c.debit.toString(),
          c.tx.to.toLowerCase(), c.tx.data, c.tx.value, c.tx.chainId, JSON.stringify(c.bounds), now);
    });
    return created;
  }

  /** The owner's wallet returned a hash. Recorded once; a different hash for the same attempt is refused by SQLite. */
  recordHandoff(attemptId: string, hash: Hex) { this.#store.recordHash(attemptId, hash, this.#clock()); }
  /** Wallet error, timeout or crash after handoff. Keeps the claim, blocks everything, asks for reconciliation. */
  recordUnknown(attemptId: string, note: string) { this.#store.recordOutcomeUnknown(attemptId, this.#clock(), note); }

  /**
   * Independently verifies a recorded hash through the injected transport (production: celoQuorum of two providers,
   * so any disagreement throws and nothing is promoted) and, only if the transaction matches the persisted envelope,
   * the exact token movements and a canonical, finalized block, records verified-final and closes the attempt.
   */
  async confirm(invoiceId: string, operation: AttemptOperation, ctx: Readonly<{ rpc: Rpc; attributionCode: string }>): Promise<ConfirmResult> {
    const o = this.#obligation(invoiceId);
    const attempt = this.#latest(o, operation);
    if (!attempt) return { kind: 'blocked', reason: 'no attempt exists for this operation' };
    if (attempt.closed === 'verified-final' && attempt.hash) return { kind: 'final', hash: attempt.hash, blockNumber: 'recorded' };
    if (!attempt.hash) return { kind: 'blocked', reason: 'no transaction hash recorded; reconcile manually and do not resend' };
    let tx, canonical;
    try {
      tx = await transactionVerifier(ctx.rpc, ctx.attributionCode, this.#clock)(attempt, o.invoice);
      if (!tx) {
        this.#store.appendVerification(attempt.id, this.#clock(), 'not-found', 'journal-verifier');
        return { kind: 'unverified', reason: 'the chain does not show a matching successful transaction for the recorded hash' };
      }
      canonical = await canonicalBlockReader(ctx.rpc, this.#clock)(chain, tx.blockNumber);
    } catch (error) {
      return { kind: 'unavailable', reason: `evidence unavailable or providers disagree: ${String((error as Error).message).slice(0, 120)}` };
    }
    if (!canonical || BigInt(canonical.finalizedBlockNumber) < BigInt(canonical.blockNumber)) {
      this.#store.appendVerification(attempt.id, this.#clock(), 'not-final', 'journal-verifier');
      return { kind: 'pending', reason: 'transaction found but its block is not yet finalized' };
    }
    this.#store.recordVerifiedFinal(attempt.id, tx, canonical, this.#clock());
    this.#store.close(attempt.id, 'verified-final', this.#clock(), 'journal');
    return { kind: 'final', hash: attempt.hash, blockNumber: tx.blockNumber };
  }

  #persistedConversion(o: Obligation, attempt: AttemptLineage): PersistedConversion {
    const bad = (why: string): never => { throw Error(`persisted conversion is inconsistent: ${why}`); };
    const r = this.db.prepare('SELECT * FROM reviewed_envelopes WHERE attempt_id = ?').get(attempt.id) as Record<string, unknown> | undefined;
    if (!r || !attempt.envelope || !attempt.hash || attempt.closed !== 'verified-final' || attempt.digest !== o.digest) bad('missing envelope, hash or finality');
    const env = attempt.envelope!, row = r!;
    const data = String(row.tx_data), to = String(row.tx_to);
    if (row.action !== 'swap' || Number(row.chain_id) !== chain || env.chainId !== chain) bad('action or chain');
    if (sha(data) !== env.dataSha256 || to !== env.to || String(row.tx_value) !== env.value) bad('calldata does not match the claimed envelope');
    if (String(row.sender) !== o.invoice.taker || String(row.buy_token) !== o.invoice.buy || String(row.sell_token) !== o.invoice.sell) bad('parties or tokens');
    if (String(row.amount) !== atomic(o.invoice.buyAmount).toString() || BigInt(String(row.debit)) > atomic(o.invoice.maxSell)) bad('amounts');
    const bounds = JSON.parse(String(row.bounds)) as PersistedConversion['bounds'];
    const held = this.db.prepare('SELECT chain_id, sender, nonce FROM taker_nonces WHERE attempt_id = ?').get(attempt.id) as { chain_id: number; sender: string; nonce: number } | undefined;
    if (!held || held.sender !== o.invoice.taker || held.chain_id !== chain || BigInt(bounds.nonce) !== BigInt(held.nonce)) bad('nonce reservation');
    return Object.freeze({
      digest: o.digest, hash: attempt.hash as Hex, sender: String(row.sender), recipient: String(row.recipient),
      buyToken: String(row.buy_token), sellToken: String(row.sell_token), amount: BigInt(String(row.amount)), debit: BigInt(String(row.debit)),
      tx: Object.freeze({ to, data: data as Hex, chainId: chain, value: String(row.tx_value) }), bounds: Object.freeze(bounds),
    });
  }

  /**
   * Safe resume (R08). Allowed only when a conversion is already finalized in the journal. In a fresh process it:
   * rebuilds the authorization certificate from the stored signatures, re-verifies the persisted conversion against the
   * chain, and only then prepares the PAYOUT review. It never prepares, quotes or simulates a conversion. An expired
   * authorization blocks the payout until a reviewed continuation exists; it does not reset or reopen the journal.
   */
  async resume(invoiceId: string, ports: Ports, policy: Policy): Promise<ResumeResult> {
    const state = this.inspect(invoiceId);
    if (state.state !== 'CONVERTED_UNPAID') return { kind: 'not-resumable', state: state.state, nextAction: state.nextAction };
    const o = this.#obligation(invoiceId);
    if (ports.clock() >= o.invoice.expires) {
      return { kind: 'blocked', reason: 'continuation-required', detail: 'the signed authorization has expired after conversion; a reviewed continuation is required and conversion cannot be reopened' };
    }
    let persisted: PersistedConversion;
    try { persisted = this.#persistedConversion(o, this.#latest(o, 'conversion')!); }
    catch (error) { return { kind: 'blocked', reason: 'journal-inconsistent', detail: String((error as Error).message) }; }
    const proof = await verifyAuthorization(o.invoice, o.digest, o.audience, o.signatures, ports.clock());
    const conversion = await reverifyConversion(persisted, ports.reader as Pick<CeloReader, 'verifySettlement'>);
    if (!conversion) return { kind: 'blocked', reason: 'conversion-not-reverified', detail: 'the chain no longer confirms the recorded conversion; payout is not offered' };
    return { kind: 'payout-review', candidate: await reviewPayout(o.invoice, proof, conversion, ports, policy) };
  }
}
