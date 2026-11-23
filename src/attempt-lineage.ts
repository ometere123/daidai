/**
 * Durable, append-only lineage for conversion and payout attempts (P10.3).
 *
 * Every attempt keeps the identity it was created with: tenant, invoice, commitment digest, the invoice revision at
 * which it was recorded, the operation, the authorization it was claimed under and the transaction envelope it was
 * allowed to send. Invoice revisions can advance freely; an attempt is never relabelled with a later revision.
 *
 * SQLite enforces the rules, not just this class:
 *  - identity columns are immutable (BEFORE UPDATE trigger), rows can't be deleted;
 *  - a transaction hash can be recorded once (NULL → value), never changed;
 *  - per (tenant, invoice, digest, operation): at most one open attempt, and an attempt closed 'verified-final' is
 *    terminal, so no further attempt can ever be inserted (no-duplicate-payment invariant), even with a fresh id;
 *  - closing as 'reconciled-not-landed' (the only path that could allow a new attempt) is DISABLED until an
 *    authoritative, server-attested reconciliation exists (P10.3 review, blocker 2). Unknown and hashless attempts
 *    therefore keep blocking new attempts;
 *  - INSERT/UPDATE OR REPLACE cannot delete rows through any unique conflict (id, operation key or hash);
 *  - the event history is append-only.
 *
 * Records whose historical revision can't be proven (legacy harness rows) are imported with lineage 'unresolved'
 * and no revision. They are retained for reconciliation and never treated as evidence of a recorded revision.
 *
 * This store never dispatches anything. Readers open the database read-only.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { attest, isAttested } from './evidence-attestation.ts';
import { LINEAGE_SCHEMA_SQL } from './lineage-schema.ts';
import type { CanonicalBlockObservation, ObservedTransaction } from './authoritative-invoice.ts';

export type AttemptOperation = 'conversion' | 'payout';
export type AuthorizationFingerprint = Readonly<{ digest: string; approvalSigner: string; consentSigner: string; expiresAtMs: number }>;
export type AttemptEnvelope = Readonly<{ chainId: number; to: string; dataSha256: string; value: string }>;
export type NewAttempt = Readonly<{
  attemptId: string; tenantId: string; invoiceId: string; digest: string; recordedRevision: number;
  operation: AttemptOperation; createdAtMs: number; authorization: AuthorizationFingerprint; envelope: AttemptEnvelope;
}>;
export type DispatchState = 'claimed' | 'hash-recorded' | 'outcome-unknown';
export type CloseReason = 'verified-final' | 'reconciled-not-landed';
export type LineageEventKind = 'claimed' | 'hash-recorded' | 'outcome-unknown' | 'verification' | 'reconciliation' | 'legacy-import' | 'closed';
export type LineageEvent = Readonly<{ seq: number; kind: LineageEventKind; atMs: number; detail: Readonly<Record<string, unknown>> }>;
export type AttemptLineage = Readonly<{
  source: 'attempt-store'; id: string; tenantId: string; invoiceId: string; digest: string; operation: AttemptOperation;
  lineage: 'recorded' | 'unresolved'; recordedRevision: number | null;
  authorization: AuthorizationFingerprint | null; envelope: AttemptEnvelope | null;
  hash: string | null; dispatch: DispatchState; closed: CloseReason | null; createdAtMs: number;
  history: readonly LineageEvent[];
}>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const hashPattern = /^0x[a-f0-9]{64}$/;
const addressPattern = /^0x[a-f0-9]{40}$/;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export const envelopeOf = (tx: Readonly<{ chainId: number; to: string; data: string; value: string }>): AttemptEnvelope => ({
  chainId: tx.chainId, to: tx.to.toLowerCase(), value: tx.value,
  dataSha256: createHash('sha256').update(tx.data.toLowerCase()).digest('hex'),
});

// The schema lives in lineage-schema.ts and is shared with the Cloudflare D1 adapter.
const schema = LINEAGE_SCHEMA_SQL;

function validateNew(a: NewAttempt) {
  check(idPattern.test(a.attemptId) && idPattern.test(a.tenantId) && idPattern.test(a.invoiceId), 'invalid attempt identity');
  check(digestPattern.test(a.digest) && a.operation && (a.operation === 'conversion' || a.operation === 'payout'), 'invalid attempt binding');
  check(Number.isSafeInteger(a.recordedRevision) && a.recordedRevision >= 0 && time(a.createdAtMs), 'invalid attempt revision or time');
  const f = a.authorization, e = a.envelope;
  check(f && f.digest === a.digest && addressPattern.test(f.approvalSigner) && addressPattern.test(f.consentSigner) &&
    f.approvalSigner !== f.consentSigner && time(f.expiresAtMs), 'invalid authorization fingerprint');
  check(e && Number.isSafeInteger(e.chainId) && addressPattern.test(e.to) && digestPattern.test(e.dataSha256) &&
    /^(0|[1-9][0-9]*)$/.test(e.value), 'invalid transaction envelope');
}

/** Write side. Owned by the (future) execution service; P10.3 only exercises it from tests. */
export class AttemptLineageStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;');
    this.db.exec(schema);
  }
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = work(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(attemptId: string, kind: LineageEventKind, atMs: number, detail: Record<string, unknown>) {
    check(time(atMs), 'invalid event time');
    this.db.prepare('INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)')
      .run(attemptId, kind, atMs, JSON.stringify(detail));
  }
  private row(attemptId: string) {
    return this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown> | undefined;
  }

  /** Records a claimed attempt before any dispatch. A repeated identical claim is idempotent; a conflicting one is refused. */
  recordAttempt(a: NewAttempt): 'created' | 'existing' {
    validateNew(a);
    return this.tx(() => {
      const existing = this.row(a.attemptId);
      if (existing) {
        const same = existing.tenant_id === a.tenantId && existing.invoice_id === a.invoiceId && existing.digest === a.digest &&
          existing.recorded_revision === a.recordedRevision && existing.operation === a.operation && existing.lineage === 'recorded' &&
          existing.authorization === JSON.stringify(a.authorization) && existing.envelope === JSON.stringify(a.envelope);
        check(same, 'attempt id conflict');
        return 'existing';
      }
      // Per invoice operation, across commitments: a new digest never reopens a finalized or open operation.
      const blocking = this.db.prepare(`SELECT closed FROM attempts WHERE tenant_id = ? AND invoice_id = ? AND operation = ?
        AND (closed IS NULL OR closed = 'verified-final') ORDER BY closed IS NULL LIMIT 1`).get(a.tenantId, a.invoiceId, a.operation) as { closed: string | null } | undefined;
      if (blocking) throw Error(blocking.closed === 'verified-final' ? 'this operation is already finalized' : 'an attempt for this operation is already open');
      try {
        this.db.prepare(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
          created_at_ms, authorization, envelope, hash, dispatch, closed) VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?, NULL, 'claimed', NULL)`)
          .run(a.attemptId, a.tenantId, a.invoiceId, a.digest, a.recordedRevision, a.operation, a.createdAtMs,
            JSON.stringify(a.authorization), JSON.stringify(a.envelope));
      } catch (error) {
        if (/UNIQUE constraint failed: attempts\.tenant_id/.test(String((error as Error).message))) throw Error('an attempt for this operation is already open');
        throw error;
      }
      this.event(a.attemptId, 'claimed', a.createdAtMs, { recordedRevision: a.recordedRevision });
      return 'created';
    });
  }

  /** Records the hash once. Re-recording the same hash is idempotent; a different hash is refused by SQLite. */
  recordHash(attemptId: string, hash: string, atMs: number) {
    check(hashPattern.test(hash), 'invalid transaction hash');
    this.tx(() => {
      const r = this.row(attemptId);
      check(r, 'unknown attempt');
      if (r.hash === hash) return;
      this.db.prepare("UPDATE attempts SET hash = ?, dispatch = 'hash-recorded' WHERE attempt_id = ?").run(hash, attemptId);
      this.event(attemptId, 'hash-recorded', atMs, { hash });
    });
  }

  /** A dispatch whose outcome is unknown and for which no hash was obtained (e.g. a crash or wallet error after submission). */
  recordOutcomeUnknown(attemptId: string, atMs: number, note: string) {
    this.tx(() => {
      const r = this.row(attemptId);
      check(r, 'unknown attempt');
      if (r.hash === null) this.db.prepare("UPDATE attempts SET dispatch = 'outcome-unknown' WHERE attempt_id = ?").run(attemptId);
      this.event(attemptId, 'outcome-unknown', atMs, { note: String(note).slice(0, 200) });
    });
  }

  /** Independent verification results are history, never a rewrite of the attempt. */
  /**
   * Records a *negative or inconclusive* verdict (mismatch, not-found, not-final). These can only restrict.
   * 'verified-final' is refused here: a caller-supplied verifier name is not evidence. Use recordVerifiedFinal().
   */
  appendVerification(attemptId: string, atMs: number, result: 'mismatch' | 'not-found' | 'not-final', verifier: string) {
    check(['mismatch', 'not-found', 'not-final'].includes(result), 'verified-final can only be recorded from attested evidence');
    check(idPattern.test(verifier), 'invalid verification');
    this.tx(() => {
      const r = this.row(attemptId);
      check(r, 'unknown attempt');
      check(r.hash !== null, 'verification requires a recorded transaction hash');
      this.event(attemptId, 'verification', atMs, { result, verifier, hash: r.hash });
    });
  }

  /**
   * Records 'verified-final' only from evidence produced in-process by the trusted adapters (attested transaction and
   * canonical-block observations), bound to this attempt's id, hash, recorded revision, commitment and operation, with
   * the block canonical and finalized. Raw SQL writers remain inside the trust boundary (see P10.4 doc).
   */
  recordVerifiedFinal(attemptId: string, tx: ObservedTransaction, canonical: CanonicalBlockObservation, atMs: number) {
    check(isAttested(tx) && isAttested(canonical), 'verified-final requires attested evidence');
    this.tx(() => {
      const r = this.row(attemptId);
      check(r, 'unknown attempt');
      check(r.hash !== null && r.lineage === 'recorded', 'verification requires a recorded transaction hash');
      check(tx.source === 'transaction-verifier' && tx.success === true && tx.attemptId === attemptId && tx.hash === r.hash &&
        tx.revision === r.recorded_revision && tx.tenantId === r.tenant_id && tx.invoiceId === r.invoice_id &&
        tx.digest === r.digest && tx.operation === r.operation, 'evidence does not belong to this attempt');
      check(canonical.source === 'canonical-chain-reader' && canonical.chainId === tx.chainId &&
        canonical.blockNumber === tx.blockNumber && canonical.blockHash === tx.blockHash &&
        BigInt(canonical.finalizedBlockNumber) >= BigInt(canonical.blockNumber), 'evidence is not canonical and finalized');
      this.event(attemptId, 'verification', atMs, {
        result: 'verified-final', verifier: 'attested-evidence', hash: r.hash, blockNumber: tx.blockNumber, blockHash: tx.blockHash,
        finalizedBlockNumber: canonical.finalizedBlockNumber,
      });
    });
  }


  /**
   * Closes an attempt as 'verified-final': terminal for its operation, so it can only ever block further attempts.
   * Requires a recorded hash and a prior independent 'verified-final' verification in the attempt's own history.
   *
   * 'reconciled-not-landed' is refused (here and by SQLite). It is the only closure that could permit a new attempt,
   * and an operator name is not proof of non-execution. It stays disabled until a server-authorized reconciliation
   * attestation bound to the exact attempt and evidence exists and has been separately reviewed.
   */
  close(attemptId: string, reason: CloseReason, atMs: number, closedBy: string) {
    if (reason !== 'verified-final') throw Error('reconciled-not-landed closure is disabled until authoritative reconciliation exists');
    check(idPattern.test(closedBy), 'closure requires an accountable operator');
    this.tx(() => {
      const r = this.row(attemptId);
      check(r, 'unknown attempt');
      check(r.hash !== null, 'verified-final requires a recorded transaction hash');
      const latest = this.db.prepare(`SELECT json_extract(detail, '$.result') AS result, json_extract(detail, '$.hash') AS hash
        FROM attempt_events WHERE attempt_id = ? AND kind = 'verification' ORDER BY seq DESC LIMIT 1`).get(attemptId) as { result: string; hash: string } | undefined;
      check(latest && latest.result === 'verified-final' && latest.hash === r.hash,
        'verified-final requires an independent verified-final verification (the latest verdict, for the recorded hash)');
      this.event(attemptId, 'closed', atMs, { reason, closedBy });
      this.db.prepare('UPDATE attempts SET closed = ? WHERE attempt_id = ?').run(reason, attemptId);
    });
  }

  /**
   * Imports attempts from a legacy harness record that never stored the revision at which they were made.
   * They are kept as 'unresolved' with no revision, authorization or proven envelope binding. Never guessed.
   */
  importLegacy(tenantId: string, legacy: Readonly<{ digest: string; invoiceId: string; swapId?: string; payoutId?: string }>, atMs: number) {
    check(idPattern.test(tenantId) && idPattern.test(legacy.invoiceId) && digestPattern.test(legacy.digest), 'invalid legacy record');
    const out: string[] = [];
    for (const [operation, attemptId] of [['conversion', legacy.swapId], ['payout', legacy.payoutId]] as const) {
      if (!attemptId) continue;
      check(typeof attemptId === 'string' && idPattern.test(attemptId), 'invalid legacy attempt id');
      this.tx(() => {
        const existing = this.row(attemptId);
        if (existing) {
          // Idempotent only for the identical legacy record; an id owned by another tenant/invoice/commitment/operation
          // must not be silently skipped (that would leave this invoice without a blocking record).
          check(existing.tenant_id === tenantId && existing.invoice_id === legacy.invoiceId && existing.digest === legacy.digest &&
            existing.operation === operation, 'legacy attempt id conflict');
          return;
        }
        this.db.prepare(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
          created_at_ms, authorization, envelope, hash, dispatch, closed) VALUES (?, ?, ?, ?, NULL, 'unresolved', ?, ?, NULL, NULL, NULL, 'outcome-unknown', NULL)`)
          .run(attemptId, tenantId, legacy.invoiceId, legacy.digest, operation, atMs);
        this.event(attemptId, 'legacy-import', atMs, { reason: 'historical revision, authorization and hash were not recorded' });
        out.push(attemptId);
      });
    }
    return out;
  }
  close_db() { this.db.close(); }
}

/** Read side. Opens the database read-only, so even a compromised projector can't write lineage. */
export class AttemptLineageReader {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true });
    this.db.exec('PRAGMA query_only = ON;');
  }
  attempts(binding: Readonly<{ tenantId: string; invoiceId: string; digest: string }>, operation: AttemptOperation): readonly AttemptLineage[] {
    const rows = this.db.prepare(`SELECT * FROM attempts WHERE tenant_id = ? AND invoice_id = ? AND digest = ? AND operation = ?
      ORDER BY created_at_ms, attempt_id`).all(binding.tenantId, binding.invoiceId, binding.digest, operation) as Record<string, unknown>[];
    return Object.freeze(rows.map(r => {
      const history = (this.db.prepare('SELECT seq, kind, at_ms, detail FROM attempt_events WHERE attempt_id = ? ORDER BY seq')
        .all(r.attempt_id as string) as Record<string, unknown>[])
        .map(e => Object.freeze({ seq: Number(e.seq), kind: e.kind as LineageEventKind, atMs: Number(e.at_ms), detail: Object.freeze(JSON.parse(String(e.detail))) }));
      return attest<AttemptLineage>({
        source: 'attempt-store', id: String(r.attempt_id), tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id),
        digest: String(r.digest), operation: r.operation as AttemptOperation, lineage: r.lineage as 'recorded' | 'unresolved',
        recordedRevision: r.recorded_revision === null ? null : Number(r.recorded_revision),
        authorization: r.authorization === null ? null : Object.freeze(JSON.parse(String(r.authorization))),
        envelope: r.envelope === null ? null : Object.freeze(JSON.parse(String(r.envelope))),
        hash: r.hash === null ? null : String(r.hash), dispatch: r.dispatch as DispatchState,
        closed: r.closed === null ? null : r.closed as CloseReason, createdAtMs: Number(r.created_at_ms),
        history: Object.freeze(history),
      });
    }));
  }
  close() { this.db.close(); }
}
