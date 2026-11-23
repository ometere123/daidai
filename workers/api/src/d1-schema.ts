/**
 * D1 schema for the read-only API (P10.4, local prototype). Every statement is idempotent (IF NOT EXISTS), and the
 * attempt-lineage part is the exact LINEAGE_SCHEMA_STATEMENTS list the node:sqlite AttemptLineageStore uses, so the same
 * SQLite triggers enforce the same invariants on D1.
 *
 * The Worker never applies this schema: no HTTP route writes. It is applied by tests and scripts/seed-local.mjs only.
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

export const SCHEMA_STATEMENTS: readonly string[] = Object.freeze([...READ_SCHEMA_STATEMENTS, ...LINEAGE_SCHEMA_STATEMENTS]);

/** Applies the schema one statement at a time (D1 exec() splits on newlines, which breaks multi-line triggers). */
export async function applySchema(db: D1Like) {
  for (const sql of SCHEMA_STATEMENTS) await db.prepare(sql).run();
}
