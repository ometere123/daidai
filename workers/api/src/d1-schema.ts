/**
 * D1 schema for the read-only API (P10.4, local prototype). Every statement is idempotent (IF NOT EXISTS), and the
 * attempt-lineage part is the exact LINEAGE_SCHEMA_STATEMENTS list the node:sqlite AttemptLineageStore uses, so the same
 * SQLite triggers enforce the same invariants on D1.
 *
 * The Worker never applies this schema. It is applied by tests and scripts/seed-local.mjs / invite.mjs only. P10.5 routes
 * write ONLY to the authentication tables (viewer_invitations, viewer_sessions, service_nonces), never to financial tables.
 */
import { LINEAGE_SCHEMA_STATEMENTS } from '../../../src/lineage-schema.ts';

/** The subset of the D1 binding API used here. Structural, so tests can wrap it to observe queries. */
export interface D1Result<T = Record<string, unknown>> { results: T[]; success: boolean; meta?: Record<string, unknown> }
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(statements: D1Stmt[]): Promise<D1Result[]>;
}

export const READ_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS invoices (
  tenant_id TEXT NOT NULL, invoice_id TEXT NOT NULL, body TEXT NOT NULL CHECK (json_valid(body)),
  digest TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 0),
  PRIMARY KEY (tenant_id, invoice_id)
)`,
  `CREATE TABLE IF NOT EXISTS tenant_directory (invoice_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS signatures (
  tenant_id TEXT NOT NULL, invoice_id TEXT NOT NULL, digest TEXT NOT NULL, approval TEXT NOT NULL, consent TEXT NOT NULL,
  PRIMARY KEY (tenant_id, invoice_id, digest)
)`,
  `CREATE TABLE IF NOT EXISTS viewer_sessions (
  token_sha256 TEXT PRIMARY KEY CHECK (length(token_sha256) = 64), viewer_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  authenticated_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS invoice_permissions (
  tenant_id TEXT NOT NULL, viewer_id TEXT NOT NULL, invoice_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission = 'invoice:read'),
  PRIMARY KEY (tenant_id, viewer_id, invoice_id, permission)
)`,
]);

/**
 * P10.5 session lifecycle columns added to viewer_sessions. Added with ALTER TABLE so databases created by P10.4 keep
 * working (all nullable; a NULL idle_expires_at_ms is read as min(authenticated_at_ms + idle timeout, expires_at_ms)).
 */
export const SESSION_COLUMNS: readonly string[] = Object.freeze([
  'idle_expires_at_ms INTEGER', 'revoked_at_ms INTEGER', 'created_from TEXT', 'rotated_from TEXT',
]);

export const AUTH_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  // Invitation codes are stored only as SHA-256. session_sha256 binds the single consumption to the session it created.
  `CREATE TABLE IF NOT EXISTS viewer_invitations (
  code_sha256 TEXT PRIMARY KEY CHECK (length(code_sha256) = 64), tenant_id TEXT NOT NULL, viewer_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  used_at_ms INTEGER, session_sha256 TEXT
)`,
  `CREATE TRIGGER IF NOT EXISTS viewer_invitations_single_use BEFORE UPDATE OF used_at_ms, session_sha256 ON viewer_invitations
WHEN OLD.used_at_ms IS NOT NULL OR OLD.session_sha256 IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'invitation already used'); END`,
  `CREATE TRIGGER IF NOT EXISTS viewer_invitations_immutable BEFORE UPDATE OF code_sha256, tenant_id, viewer_id, created_at_ms, expires_at_ms
ON viewer_invitations BEGIN SELECT RAISE(ABORT, 'invitation identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS viewer_sessions_no_unrevoke BEFORE UPDATE OF revoked_at_ms ON viewer_sessions
WHEN OLD.revoked_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'session revocation is final'); END`,
  `CREATE TRIGGER IF NOT EXISTS viewer_sessions_immutable BEFORE UPDATE OF token_sha256, viewer_id, tenant_id, authenticated_at_ms,
expires_at_ms, created_from, rotated_from ON viewer_sessions BEGIN SELECT RAISE(ABORT, 'session identity is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS viewer_sessions_idle_bounded BEFORE UPDATE OF idle_expires_at_ms ON viewer_sessions
WHEN NEW.idle_expires_at_ms IS NULL OR NEW.idle_expires_at_ms > NEW.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'idle expiry beyond absolute expiry'); END`,
  `CREATE INDEX IF NOT EXISTS viewer_sessions_by_viewer ON viewer_sessions (tenant_id, viewer_id)`,
  // Global replay store (decision 3): a duplicate (key_id, nonce) fails on D1's single primary.
  `CREATE TABLE IF NOT EXISTS service_nonces (
  key_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at_ms INTEGER NOT NULL, PRIMARY KEY (key_id, nonce)
)`,
  `CREATE INDEX IF NOT EXISTS service_nonces_by_age ON service_nonces (seen_at_ms)`,
]);

/** Every CREATE statement (the session columns are added between the base tables and the auth statements). */
export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([...READ_SCHEMA_STATEMENTS, ...LINEAGE_SCHEMA_STATEMENTS, ...AUTH_SCHEMA_STATEMENTS]);

/** Applies the schema one statement at a time (D1 exec() splits on newlines, which breaks multi-line triggers). Idempotent. */
export async function applySchema(db: D1Like) {
  for (const sql of [...READ_SCHEMA_STATEMENTS, ...LINEAGE_SCHEMA_STATEMENTS]) await db.prepare(sql).run();
  for (const col of SESSION_COLUMNS) {
    try { await db.prepare(`ALTER TABLE viewer_sessions ADD COLUMN ${col}`).run(); } catch (e) {
      if (!/duplicate column/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
  for (const sql of AUTH_SCHEMA_STATEMENTS) await db.prepare(sql).run();
}
