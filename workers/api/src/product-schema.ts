import type { D1Like } from './d1-schema.ts';

const schema = [
  'CREATE TABLE IF NOT EXISTS product_schema (version INTEGER PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS product_merchants (tenant TEXT NOT NULL, viewer TEXT NOT NULL, PRIMARY KEY (tenant, viewer))',
  `CREATE TABLE IF NOT EXISTS product_revisions (
    tenant TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    operation_key TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY (tenant, id, revision), UNIQUE (tenant, owner, operation_key)
  )`,
  `CREATE TRIGGER IF NOT EXISTS product_revisions_no_update BEFORE UPDATE ON product_revisions
    BEGIN SELECT RAISE(ABORT, 'immutable revision'); END`,
  `CREATE TRIGGER IF NOT EXISTS product_revisions_no_delete BEFORE DELETE ON product_revisions
    BEGIN SELECT RAISE(ABORT, 'immutable revision'); END`,
  `CREATE TABLE IF NOT EXISTS product_shares (
    capability_hash TEXT PRIMARY KEY, tenant TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER,
    FOREIGN KEY (tenant, id, revision) REFERENCES product_revisions(tenant, id, revision)
  )`,
  'CREATE INDEX IF NOT EXISTS product_shares_invoice ON product_shares(tenant, id)',
  'INSERT OR IGNORE INTO product_schema VALUES (1)',
];

export async function applyProductSchema(db: D1Like) {
  const result = await db.batch(schema.map(sql => db.prepare(sql)));
  if (result.length !== schema.length || result.some(r => !r.success)) throw Error('product schema unavailable');
}
