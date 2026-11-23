/**
 * PROTOTYPE D1 writer for attempt lineage (P10.4). Tests only: not imported by the Worker, no HTTP route writes.
 *
 * Mirrors AttemptLineageStore (src/attempt-lineage.ts) on Cloudflare D1. The same SQLite triggers (shared
 * LINEAGE_SCHEMA_STATEMENTS) enforce the invariants; this class adds the same pre-checks and error messages.
 *
 * Semantic differences from the node:sqlite store (documented in README "D1 vs node:sqlite"):
 *  - D1 has no interactive transactions (no BEGIN IMMEDIATE ... COMMIT around reads + writes). A pre-check SELECT and the
 *    following write are separate round trips, so the pre-check is advisory; the triggers are the authority. Every
 *    multi-statement write is one db.batch(), which D1 runs atomically (all or nothing).
 *  - Where node relied on the transaction to bind a write to the row it just read, the D1 writer makes the write itself
 *    conditional (INSERT ... SELECT ... WHERE / UPDATE ... WHERE), so a concurrent change makes the write a no-op or a
 *    trigger error instead of a stale write.
 *  - A losing concurrent recordAttempt hits a trigger instead of the pre-check; the error is mapped back to the node
 *    message ("already open" / "already finalized" / idempotent 'existing').
 *  - No PRAGMA foreign_keys / journal_mode / busy_timeout (D1 manages these).
 */
import type {
  CloseReason, LineageEventKind, NewAttempt,
} from '../../../src/attempt-lineage.ts';
import type { CanonicalBlockObservation, ObservedTransaction } from '../../../src/authoritative-invoice.ts';
import { isAttested } from '../../../src/evidence-attestation.ts';
import type { D1Like, D1Stmt } from './d1-schema.ts';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const hashPattern = /^0x[a-f0-9]{64}$/;
const addressPattern = /^0x[a-f0-9]{40}$/;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error(message); }
const time = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

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

type Row = Record<string, unknown>;

export class D1LineageWriter {
  readonly db: D1Like;
  constructor(db: D1Like) { this.db = db; }

  private row(attemptId: string) {
    return this.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').bind(attemptId).first<Row>();
  }
  private event(attemptId: string, kind: LineageEventKind, atMs: number, detail: Record<string, unknown>): D1Stmt {
    check(time(atMs), 'invalid event time');
    return this.db.prepare('INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) VALUES (?, ?, ?, ?)')
      .bind(attemptId, kind, atMs, JSON.stringify(detail));
  }
  private same(existing: Row, a: NewAttempt) {
    return existing.tenant_id === a.tenantId && existing.invoice_id === a.invoiceId && existing.digest === a.digest &&
      existing.recorded_revision === a.recordedRevision && existing.operation === a.operation && existing.lineage === 'recorded' &&
      existing.authorization === JSON.stringify(a.authorization) && existing.envelope === JSON.stringify(a.envelope);
  }
  private async blocking(tenantId: string, invoiceId: string, operation: string) {
    return this.db.prepare(`SELECT closed FROM attempts WHERE tenant_id = ? AND invoice_id = ? AND operation = ?
      AND (closed IS NULL OR closed = 'verified-final') ORDER BY closed IS NULL LIMIT 1`).bind(tenantId, invoiceId, operation).first<{ closed: string | null }>();
  }

  /** Records a claimed attempt before any dispatch. A repeated identical claim is idempotent; a conflicting one is refused. */
  async recordAttempt(a: NewAttempt): Promise<'created' | 'existing'> {
    validateNew(a);
    const existing = await this.row(a.attemptId);
    if (existing) { check(this.same(existing, a), 'attempt id conflict'); return 'existing'; }
    const blocking = await this.blocking(a.tenantId, a.invoiceId, a.operation);
    if (blocking) throw Error(blocking.closed === 'verified-final' ? 'this operation is already finalized' : 'an attempt for this operation is already open');
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
          created_at_ms, authorization, envelope, hash, dispatch, closed) VALUES (?, ?, ?, ?, ?, 'recorded', ?, ?, ?, ?, NULL, 'claimed', NULL)`)
          .bind(a.attemptId, a.tenantId, a.invoiceId, a.digest, a.recordedRevision, a.operation, a.createdAtMs,
            JSON.stringify(a.authorization), JSON.stringify(a.envelope)),
        this.event(a.attemptId, 'claimed', a.createdAtMs, { recordedRevision: a.recordedRevision }),
      ]);
      return 'created';
    } catch (error) {
      // Lost a race (no interactive transaction): re-read and report what node's pre-check would have reported.
      const now = await this.row(a.attemptId);
      if (now) { check(this.same(now, a), 'attempt id conflict'); return 'existing'; }
      const b = await this.blocking(a.tenantId, a.invoiceId, a.operation);
      if (b) throw Error(b.closed === 'verified-final' ? 'this operation is already finalized' : 'an attempt for this operation is already open');
      throw error;
    }
  }

  /** Records the hash once. Re-recording the same hash is idempotent (no event); a different hash is refused by the trigger. */
  async recordHash(attemptId: string, hash: string, atMs: number) {
    check(hashPattern.test(hash), 'invalid transaction hash');
    const r = await this.row(attemptId);
    check(r, 'unknown attempt');
    if (r.hash === hash) return;
    check(time(atMs), 'invalid event time');
    await this.db.batch([
      // Same-hash races become a no-op (0 changes); a different hash reaches attempt_hash_set_once and aborts the batch.
      this.db.prepare("UPDATE attempts SET hash = ?, dispatch = 'hash-recorded' WHERE attempt_id = ? AND hash IS NOT ?").bind(hash, attemptId, hash),
      this.db.prepare('INSERT INTO attempt_events (attempt_id, kind, at_ms, detail) SELECT ?, ?, ?, ? WHERE changes() = 1')
        .bind(attemptId, 'hash-recorded', atMs, JSON.stringify({ hash })),
    ]);
  }

  async recordOutcomeUnknown(attemptId: string, atMs: number, note: string) {
    const r = await this.row(attemptId);
    check(r, 'unknown attempt');
    await this.db.batch([
      this.db.prepare("UPDATE attempts SET dispatch = 'outcome-unknown' WHERE attempt_id = ? AND hash IS NULL").bind(attemptId),
      this.event(attemptId, 'outcome-unknown', atMs, { note: String(note).slice(0, 200) }),
    ]);
  }

  /** Negative or inconclusive verdicts only. 'verified-final' is refused: a caller-supplied verifier name is not evidence. */
  async appendVerification(attemptId: string, atMs: number, result: 'mismatch' | 'not-found' | 'not-final', verifier: string) {
    check(['mismatch', 'not-found', 'not-final'].includes(result), 'verified-final can only be recorded from attested evidence');
    check(idPattern.test(verifier), 'invalid verification');
    check(time(atMs), 'invalid event time');
    const r = await this.row(attemptId);
    check(r, 'unknown attempt');
    check(r.hash !== null, 'verification requires a recorded transaction hash');
    // The verdict is bound to the hash stored at write time (same JSON key order as node: result, verifier, hash).
    await this.db.prepare(`INSERT INTO attempt_events (attempt_id, kind, at_ms, detail)
      SELECT attempt_id, 'verification', ?, json_object('result', ?, 'verifier', ?, 'hash', hash) FROM attempts
      WHERE attempt_id = ? AND hash IS NOT NULL`).bind(atMs, result, verifier, attemptId).run();
  }

  /** 'verified-final' only from in-process attested evidence bound to this attempt, canonical and finalized. */
  async recordVerifiedFinal(attemptId: string, tx: ObservedTransaction, canonical: CanonicalBlockObservation, atMs: number) {
    check(isAttested(tx) && isAttested(canonical), 'verified-final requires attested evidence');
    check(time(atMs), 'invalid event time');
    const r = await this.row(attemptId);
    check(r, 'unknown attempt');
    check(r.hash !== null && r.lineage === 'recorded', 'verification requires a recorded transaction hash');
    check(tx.source === 'transaction-verifier' && tx.success === true && tx.attemptId === attemptId && tx.hash === r.hash &&
      tx.revision === r.recorded_revision && tx.tenantId === r.tenant_id && tx.invoiceId === r.invoice_id &&
      tx.digest === r.digest && tx.operation === r.operation, 'evidence does not belong to this attempt');
    check(canonical.source === 'canonical-chain-reader' && canonical.chainId === tx.chainId &&
      canonical.blockNumber === tx.blockNumber && canonical.blockHash === tx.blockHash &&
      BigInt(canonical.finalizedBlockNumber) >= BigInt(canonical.blockNumber), 'evidence is not canonical and finalized');
    const detail = JSON.stringify({
      result: 'verified-final', verifier: 'attested-evidence', hash: r.hash, blockNumber: tx.blockNumber, blockHash: tx.blockHash,
      finalizedBlockNumber: canonical.finalizedBlockNumber,
    });
    // Conditional on the row still carrying the hash the evidence was checked against.
    const res = await this.db.prepare(`INSERT INTO attempt_events (attempt_id, kind, at_ms, detail)
      SELECT ?, 'verification', ?, ? WHERE EXISTS (SELECT 1 FROM attempts WHERE attempt_id = ? AND hash = ? AND lineage = 'recorded')`)
      .bind(attemptId, atMs, detail, attemptId, r.hash).run();
    check(Number(res.meta?.changes ?? 0) === 1, 'evidence does not belong to this attempt');
  }

  /** Closes 'verified-final' only; 'reconciled-not-landed' is refused here and by the trigger. */
  async close(attemptId: string, reason: CloseReason, atMs: number, closedBy: string) {
    if (reason !== 'verified-final') throw Error('reconciled-not-landed closure is disabled until authoritative reconciliation exists');
    check(idPattern.test(closedBy), 'closure requires an accountable operator');
    const r = await this.row(attemptId);
    check(r, 'unknown attempt');
    check(r.hash !== null, 'verified-final requires a recorded transaction hash');
    const latest = await this.db.prepare(`SELECT json_extract(detail, '$.result') AS result, json_extract(detail, '$.hash') AS hash
      FROM attempt_events WHERE attempt_id = ? AND kind = 'verification' ORDER BY seq DESC LIMIT 1`).bind(attemptId).first<{ result: string; hash: string }>();
    check(latest && latest.result === 'verified-final' && latest.hash === r.hash,
      'verified-final requires an independent verified-final verification (the latest verdict, for the recorded hash)');
    // Atomic: if the UPDATE trips a trigger (e.g. a newer negative verdict raced in), the 'closed' event rolls back too.
    await this.db.batch([
      this.event(attemptId, 'closed', atMs, { reason, closedBy }),
      this.db.prepare('UPDATE attempts SET closed = ? WHERE attempt_id = ?').bind(reason, attemptId),
    ]);
  }

  /** Legacy attempts with no provable revision are kept 'unresolved' and keep blocking. Conflicting ids are refused. */
  async importLegacy(tenantId: string, legacy: Readonly<{ digest: string; invoiceId: string; swapId?: string; payoutId?: string }>, atMs: number) {
    check(idPattern.test(tenantId) && idPattern.test(legacy.invoiceId) && digestPattern.test(legacy.digest), 'invalid legacy record');
    const out: string[] = [];
    for (const [operation, attemptId] of [['conversion', legacy.swapId], ['payout', legacy.payoutId]] as const) {
      if (!attemptId) continue;
      check(typeof attemptId === 'string' && idPattern.test(attemptId), 'invalid legacy attempt id');
      const conflict = (e: Row) => check(e.tenant_id === tenantId && e.invoice_id === legacy.invoiceId && e.digest === legacy.digest &&
        e.operation === operation, 'legacy attempt id conflict');
      const existing = await this.row(attemptId);
      if (existing) { conflict(existing); continue; }
      try {
        await this.db.batch([
          this.db.prepare(`INSERT INTO attempts (attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation,
            created_at_ms, authorization, envelope, hash, dispatch, closed) VALUES (?, ?, ?, ?, NULL, 'unresolved', ?, ?, NULL, NULL, NULL, 'outcome-unknown', NULL)`)
            .bind(attemptId, tenantId, legacy.invoiceId, legacy.digest, operation, atMs),
          this.event(attemptId, 'legacy-import', atMs, { reason: 'historical revision, authorization and hash were not recorded' }),
        ]);
      } catch (error) {
        const now = await this.row(attemptId);
        if (now) { conflict(now); continue; }
        throw error;
      }
      out.push(attemptId);
    }
    return out;
  }
}

