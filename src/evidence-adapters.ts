/**
 * Trusted, read-only evidence adapters for the authoritative projection (P10.3).
 *
 * Each adapter performs its own verification and only then attests the record it returns
 * (evidence-attestation.ts). Nothing here can write, sign or dispatch:
 *  - chain access goes through `readOnlyRpc`, which refuses every method except four read calls;
 *  - SQLite is opened with `readOnly: true` and `query_only`;
 *  - authorization signatures are only *recovered* (pure EIP-712 recovery), never requested.
 *
 * These adapters are internal and injectable. They are not wired to any route: production storage, a reviewed RPC
 * endpoint and viewer authentication are prerequisites (see P10.3-READ-ONLY-BOUNDARIES.md).
 */
import { DatabaseSync } from 'node:sqlite';
import { attest } from './evidence-attestation.ts';
import { commit, type Invoice } from './invoice-core.ts';
import type {
  AuthorizationPurpose, CanonicalBlockObservation, CommitmentBinding, ObservedAuthorization, ObservedTransaction,
  StoredAttempt, StoredInvoice, ViewerGrant,
} from './authoritative-invoice.ts';

export * from './chain-evidence.ts';

// ---------------------------------------------------------------- committed invoice snapshots

/** Server directory of tenant ownership. Never derived from client input. */
export type TenantDirectory = (invoiceId: string) => Promise<string | null>;

/**
 * Reads committed invoice snapshots from the invoice store (the harness `invoices` table: id, body, revision)
 * through a read-only connection, re-derives the commitment digest and rejects any record that doesn't match it.
 */
export function invoiceSnapshotReader(file: string, tenants: TenantDirectory, clock: () => number) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON;');
  return {
    async readInvoice(grant: ViewerGrant): Promise<StoredInvoice | null> {
      if (await tenants(grant.invoiceId) !== grant.tenantId) return null;
      const row = db.prepare('SELECT body, revision FROM invoices WHERE id = ?').get(grant.invoiceId) as { body: string; revision: number } | undefined;
      if (!row) return null;
      let record: { commitment: { invoice: Invoice; digest: string }; revision: number };
      try { record = JSON.parse(String(row.body)); } catch { return null; }
      const committed = commit(record.commitment.invoice);
      if (committed.digest !== record.commitment.digest || record.revision !== Number(row.revision)) return null;
      return attest<StoredInvoice>({
        source: 'invoice-store', tenantId: grant.tenantId, invoice: committed.invoice, digest: committed.digest,
        revision: Number(row.revision), observedAtMs: clock(),
      });
    },
    close() { db.close(); },
  };
}

