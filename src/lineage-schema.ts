/**
 * The attempt-lineage schema, shared by the node:sqlite store (attempt-lineage.ts) and the Cloudflare D1 adapter
 * (workers/api). Pure data, no runtime imports, so it loads anywhere.
 *
 * Invariants are enforced by SQLite itself (triggers, CHECK constraints and indices), so they hold for any writer that
 * uses this schema, including raw SQL. They are re-tested on local D1 (workerd) rather than assumed to transfer.
 * Statements are listed individually because D1 applies them one by one (batch), and every one is idempotent
 * (IF NOT EXISTS). Relaxing a trigger on an existing database therefore needs an explicit, reviewed migration.
 */
export const LINEAGE_SCHEMA_VERSION = 2;

export const LINEAGE_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL, invoice_id TEXT NOT NULL, digest TEXT NOT NULL,
  recorded_revision INTEGER, lineage TEXT NOT NULL CHECK (lineage IN ('recorded', 'unresolved')),
  operation TEXT NOT NULL CHECK (operation IN ('conversion', 'payout')),
  created_at_ms INTEGER NOT NULL, authorization TEXT, envelope TEXT,
  hash TEXT, dispatch TEXT NOT NULL CHECK (dispatch IN ('claimed', 'hash-recorded', 'outcome-unknown')),
  closed TEXT CHECK (closed IS NULL OR closed IN ('verified-final', 'reconciled-not-landed')),
  CHECK ((lineage = 'recorded') = (recorded_revision IS NOT NULL AND authorization IS NOT NULL AND envelope IS NOT NULL))
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_open_attempt ON attempts (tenant_id, invoice_id, digest, operation) WHERE closed IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS unique_hash ON attempts (hash) WHERE hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS attempt_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES attempts (attempt_id),
  kind TEXT NOT NULL CHECK (kind IN ('claimed', 'hash-recorded', 'outcome-unknown', 'verification', 'reconciliation', 'legacy-import', 'closed')),
  at_ms INTEGER NOT NULL, detail TEXT NOT NULL
)`,
  `CREATE TRIGGER IF NOT EXISTS attempt_no_replace BEFORE INSERT ON attempts
  WHEN EXISTS (SELECT 1 FROM attempts WHERE attempt_id = NEW.attempt_id)
  BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON attempt_events
  WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM attempt_events WHERE seq = NEW.seq)
  BEGIN SELECT RAISE(ABORT, 'attempt history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS closed_attempt_frozen BEFORE UPDATE OF hash, dispatch ON attempts
  WHEN OLD.closed IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'closed attempts are frozen'); END`,
  `CREATE TRIGGER IF NOT EXISTS operation_open_or_final BEFORE INSERT ON attempts
  WHEN EXISTS (SELECT 1 FROM attempts WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id AND digest = NEW.digest
    AND operation = NEW.operation AND (closed IS NULL OR closed = 'verified-final'))
  BEGIN SELECT RAISE(ABORT, 'an attempt for this operation is open or finalized'); END`,
  `CREATE TRIGGER IF NOT EXISTS invoice_operation_open_or_final BEFORE INSERT ON attempts
  WHEN EXISTS (SELECT 1 FROM attempts WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.invoice_id
    AND operation = NEW.operation AND (closed IS NULL OR closed = 'verified-final'))
  BEGIN SELECT RAISE(ABORT, 'an attempt for this invoice operation is open or finalized under some commitment'); END`,
  `CREATE TRIGGER IF NOT EXISTS attempt_inserted_open BEFORE INSERT ON attempts WHEN NEW.closed IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'attempts are recorded open'); END`,
  `CREATE TRIGGER IF NOT EXISTS hash_no_replace_insert BEFORE INSERT ON attempts
  WHEN NEW.hash IS NOT NULL AND EXISTS (SELECT 1 FROM attempts WHERE hash = NEW.hash)
  BEGIN SELECT RAISE(ABORT, 'transaction hash already belongs to another attempt'); END`,
  `CREATE TRIGGER IF NOT EXISTS hash_no_replace_update BEFORE UPDATE OF hash ON attempts
  WHEN NEW.hash IS NOT NULL AND EXISTS (SELECT 1 FROM attempts WHERE hash = NEW.hash AND attempt_id <> OLD.attempt_id)
  BEGIN SELECT RAISE(ABORT, 'transaction hash already belongs to another attempt'); END`,
  `CREATE TRIGGER IF NOT EXISTS reconciled_not_landed_disabled BEFORE UPDATE OF closed ON attempts
  WHEN NEW.closed = 'reconciled-not-landed'
  BEGIN SELECT RAISE(ABORT, 'reconciled-not-landed closure is disabled until authoritative reconciliation exists'); END`,
  `CREATE TRIGGER IF NOT EXISTS verified_final_requires_hash BEFORE UPDATE OF closed ON attempts
  WHEN NEW.closed = 'verified-final' AND OLD.hash IS NULL
  BEGIN SELECT RAISE(ABORT, 'verified-final requires a recorded transaction hash'); END`,
  `CREATE TRIGGER IF NOT EXISTS verified_final_requires_evidence BEFORE UPDATE OF closed ON attempts
  WHEN NEW.closed = 'verified-final' AND OLD.hash IS NOT NULL AND (
    (SELECT json_extract(detail, '$.result') FROM attempt_events WHERE attempt_id = OLD.attempt_id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) IS NOT 'verified-final'
    OR (SELECT json_extract(detail, '$.hash') FROM attempt_events WHERE attempt_id = OLD.attempt_id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) IS NOT OLD.hash
    OR (SELECT json_extract(detail, '$.verifier') FROM attempt_events WHERE attempt_id = OLD.attempt_id AND kind = 'verification' ORDER BY seq DESC LIMIT 1) IS NOT 'attested-evidence')
  BEGIN SELECT RAISE(ABORT, 'verified-final requires the latest independent verdict for the recorded hash'); END`,
  `CREATE TRIGGER IF NOT EXISTS attempt_identity_immutable BEFORE UPDATE OF
  attempt_id, tenant_id, invoice_id, digest, recorded_revision, lineage, operation, created_at_ms, authorization, envelope ON attempts
  BEGIN SELECT RAISE(ABORT, 'attempt identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS attempt_hash_set_once BEFORE UPDATE OF hash ON attempts
  WHEN OLD.hash IS NOT NULL AND NEW.hash IS NOT OLD.hash
  BEGIN SELECT RAISE(ABORT, 'attempt hash is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS attempt_close_once BEFORE UPDATE OF closed ON attempts
  WHEN OLD.closed IS NOT NULL AND NEW.closed IS NOT OLD.closed
  BEGIN SELECT RAISE(ABORT, 'attempt closure is final'); END`,
  `CREATE TRIGGER IF NOT EXISTS attempt_closed_terminal BEFORE UPDATE OF closed ON attempts
  WHEN OLD.closed IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'attempt closure is final'); END`,
  `CREATE TRIGGER IF NOT EXISTS attempt_no_delete BEFORE DELETE ON attempts
  BEGIN SELECT RAISE(ABORT, 'attempts are retained'); END`,
  `CREATE TRIGGER IF NOT EXISTS events_append_only_update BEFORE UPDATE ON attempt_events
  BEGIN SELECT RAISE(ABORT, 'attempt history is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS events_append_only_delete BEFORE DELETE ON attempt_events
  BEGIN SELECT RAISE(ABORT, 'attempt history is append-only'); END`,
]);

/** Single-script form for node:sqlite exec(). */
export const LINEAGE_SCHEMA_SQL = LINEAGE_SCHEMA_STATEMENTS.map(s => s + ';').join('\n');
