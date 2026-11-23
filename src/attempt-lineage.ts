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
import { attest } from './evidence-attestation.ts';

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

const schema = `
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL, invoice_id TEXT NOT NULL, digest TEXT NOT NULL,
  recorded_revision INTEGER, lineage TEXT NOT NULL CHECK (lineage IN ('recorded', 'unresolved')),
  operation TEXT NOT NULL CHECK (operation IN ('conversion', 'payout')),
  created_at_ms INTEGER NOT NULL, authorization TEXT, envelope TEXT,
  hash TEXT, dispatch TEXT NOT NULL CHECK (dispatch IN ('claimed', 'hash-recorded', 'outcome-unknown')),
  closed TEXT CHECK (closed IS NULL OR closed IN ('verified-final', 'reconciled-not-landed')),
  CHECK ((lineage = 'recorded') = (recorded_revision IS NOT NULL AND authorization IS NOT NULL AND envelope IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON attempts (tenant_id, invoice_id, digest, operation) WHERE closed IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS unique_hash ON attempts (hash) WHERE hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS attempt_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES attempts (attempt_id),
  kind TEXT NOT NULL CHECK (kind IN ('claimed', 'hash-recorded', 'outcome-unknown', 'verification', 'reconciliation', 'legacy-import', 'closed')),
  at_ms INTEGER NOT NULL, detail TEXT NOT NULL
);
-- INSERT OR REPLACE deletes the conflicting row without firing DELETE/UPDATE triggers, so block it at insert time.
CREATE TRIGGER IF NOT EXISTS attempt_no_replace BEFORE INSERT ON attempts
  WHEN EXISTS (SELECT 1 FROM attempts WHERE attempt_id = NEW.attempt_id)
  BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON attempt_events
  WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM attempt_events WHERE seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT, 'attempt history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS closed_attempt_frozen BEFORE UPDATE OF hash, dispatch ON attempts
  WHEN OLD.closed IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'closed attempts are frozen'); END;
-- No-duplicate-payment invariant: an open or verified-final attempt blocks every further attempt for the operation.
CREATE TRIGGER IF NOT EXISTS operation_open_or_final BEFORE INSERT ON attempts
  WHEN EXISTS (SELECT 1 FROM attempts WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id AND digest = NEW.digest
    AND operation = NEW.operation AND (closed IS NULL OR closed = 'verified-final'))
  BEGIN SELECT RAISE(ABORT, 'an attempt for this operation is open or finalized'); END;
CREATE TRIGGER IF NOT EXISTS attempt_inserted_open BEFORE INSERT ON attempts WHEN NEW.closed IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'attempts are recorded open'); END;
CREATE TRIGGER IF NOT EXISTS hash_no_replace_insert BEFORE INSERT ON attempts
  WHEN NEW.hash IS NOT NULL AND EXISTS (SELECT 1 FROM attempts WHERE hash = NEW.hash)
  BEGIN SELECT RAISE(ABORT, 'transaction hash already belongs to another attempt'); END;
CREATE TRIGGER IF NOT EXISTS hash_no_replace_update BEFORE UPDATE OF hash ON attempts
  WHEN NEW.hash IS NOT NULL AND EXISTS (SELECT 1 FROM attempts WHERE hash = NEW.hash AND attempt_id <> OLD.attempt_id)
  BEGIN SELECT RAISE(ABORT, 'transaction hash already belongs to another attempt'); END;
-- Deferred until authoritative reconciliation infrastructure exists. Fail closed: never prove non-execution by assertion.
CREATE TRIGGER IF NOT EXISTS reconciled_not_landed_disabled BEFORE UPDATE OF closed ON attempts
  WHEN NEW.closed = 'reconciled-not-landed'
  BEGIN SELECT RAISE(ABORT, 'reconciled-not-landed closure is disabled until authoritative reconciliation exists'); END;
CREATE TRIGGER IF NOT EXISTS verified_final_requires_hash BEFORE UPDATE OF closed ON attempts
  WHEN NEW.closed = 'verified-final' AND OLD.hash IS NULL
  BEGIN SELECT RAISE(ABORT, 'verified-final requires a recorded transaction hash'); END;
-- verified-final must rest on the latest independent verdict for the recorded hash (raw SQL included).
CREATE TRIGGER IF NOT EXISTS verified_final_requires_evidence BEFORE UPDATE OF closed ON attempts
  WHEN NEW.closed = 'verified-final' AND OLD.hash IS NOT NULL AND (
    (SELECT json_extract(detail, '$.result') FROM attempt_events WHERE attempt_id = OLD.attempt_id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) IS NOT 'verified-final'
    OR (SELECT json_extract(detail, '$.hash') FROM attempt_events WHERE attempt_id = OLD.attempt_id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) IS NOT OLD.hash)
  BEGIN SELECT RAISE(ABORT, 'verified-final requires the latest independent verdict for the recorded hash'); END;
CREATE TRIGGER IF NOT EXISTS attempt_identity_immutable BEFORE UPDATE OF
  attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms, authorization, envelope ON attempts
  BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS attempt_hash_set_once BEFORE UPDATE OF hash ON attempts
  WHEN OLD.hash IS NOT NULL AND NEW.hash IS NOT OLD.hash
  BEGIN SELECT RAISE(ABORT, 'attempt hash is immutable'); END;
CREATE TRIGGER IF NOT EXISTS attempt_close_once BEFORE UPDATE OF closed ON attempts
  WHEN OLD.closed IS NOT NULL AND NEW.closed IS NOT OLD.closed
  BEGIN SELECT RAISE(ABORT, 'attempt closure is final'); END;
CREATE TRIGGER IF NOT EXISTS attempt_no_delete BEFORE DELETE ON attempts
  BEGIN SELECT RAISE(ABORT, 'attempts are retained'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_update BEFORE UPDATE ON attempt_events
  BEGIN SELECT RAISE(ABORT, 'attempt history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_delete BEFORE DELETE ON attempt_events
  BEGIN SELECT RAISE(ABORT, 'attempt history is append-only'); END;
`;

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
      const blocking = this.db.prepare(`SELECT closed FROM attempts WHERE tenant_id = ? AND invoice_id = ? AND digest = ? AND operation = ?
        AND (closed IS NULL OR closed = 'verified-final') LIMIT 1`).get(a.tenantId, a.invoiceId, a.digest, a.operation) as { closed: string | null } | undefined;
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
  appendVerification(attemptId: string, atMs: number, result: 'verified-final' | 'mismatch' | 'not-found' | 'not-final', verifier: string) {
    check(['verified-final', 'mismatch', 'not-found', 'not-final'].includes(result) && idPattern.test(verifier), 'invalid verification');
    this.tx(() => {
      const r = this.row(attemptId);
      check(r, 'unknown attempt');
      // A verdict is about a specific transaction: it can only be recorded once a hash exists, and it names that hash.
      check(r.hash !== null, 'verification requires a recorded transaction hash');
      this.event(attemptId, 'verification', atMs, { result, verifier, hash: r.hash });
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
