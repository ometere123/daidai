/**
 * Cloudflare D1 implementations of the P10.4 repository interfaces (src/repositories.ts). Read-only: every query
 * here is a SELECT. D1 has no read-only connection, so "read-only" is enforced by this code and by review, not by
 * the binding (see README, A8).
 *
 * Repositories return rows. Commitments and signatures are re-derived and verified by projectionSources(); the only
 * attestation done here is the attempt reader's, which mirrors AttemptLineageReader exactly (same shape, history
 * included) because the projector requires attested attempt rows.
 */
import type {
  AttemptEnvelope, AttemptLineage, AttemptOperation, AuthorizationFingerprint, CloseReason, DispatchState, LineageEvent, LineageEventKind,
} from '../../../src/attempt-lineage.ts';
import type { CommitmentBinding } from '../../../src/authoritative-invoice.ts';
import { attest } from '../../../src/evidence-attestation.ts';
import type { Invoice } from '../../../src/invoice-core.ts';
import type {
  AttemptRepository, InvoiceRepository, InvoiceRow, PermissionRepository, Repositories, SignatureRepository, ViewerSessionRepository,
} from '../../../src/repositories.ts';
import type { D1Like } from './d1-schema.ts';
import type { Hex } from 'viem';

type Row = Record<string, unknown>;
const str = (v: unknown) => typeof v === 'string' ? v : null;
const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) ? v : null;

export function d1Invoices(db: D1Like): InvoiceRepository {
  return {
    async read(tenantId, invoiceId): Promise<InvoiceRow | null> {
      const r = await db.prepare('SELECT tenant_id, invoice_id, body, digest, revision FROM invoices WHERE tenant_id = ? AND invoice_id = ?')
        .bind(tenantId, invoiceId).first<Row>();
      if (!r) return null;
      const body = str(r.body), digest = str(r.digest), revision = int(r.revision);
      if (body === null || digest === null || revision === null) return null;
      let invoice: Invoice;
      try { invoice = JSON.parse(body); } catch { return null; }
      if (!invoice || typeof invoice !== 'object' || Array.isArray(invoice)) return null;
      return Object.freeze({ tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id), invoice, digest, revision });
    },
  };
}

export function d1Signatures(db: D1Like): SignatureRepository {
  return {
    async read(b: CommitmentBinding) {
      const r = await db.prepare('SELECT approval, consent FROM signatures WHERE tenant_id = ? AND invoice_id = ? AND digest = ?')
        .bind(b.tenantId, b.invoiceId, b.digest).first<Row>();
      const approval = str(r?.approval), consent = str(r?.consent);
      return approval && consent ? Object.freeze({ approval: approval as Hex, consent: consent as Hex }) : null;
    },
  };
}

export function d1Sessions(db: D1Like): ViewerSessionRepository {
  return {
    async findByTokenHash(tokenHash) {
      if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null;
      const r = await db.prepare('SELECT viewer_id, tenant_id, authenticated_at_ms, expires_at_ms FROM viewer_sessions WHERE token_sha256 = ?')
        .bind(tokenHash).first<Row>();
      if (!r) return null;
      const viewerId = str(r.viewer_id), tenantId = str(r.tenant_id), authenticatedAtMs = int(r.authenticated_at_ms), expiresAtMs = int(r.expires_at_ms);
      if (viewerId === null || tenantId === null || authenticatedAtMs === null || expiresAtMs === null) return null;
      return Object.freeze({ viewerId, tenantId, authenticatedAtMs, expiresAtMs });
    },
  };
}

export function d1Permissions(db: D1Like): PermissionRepository {
  return {
    async canReadInvoice(tenantId, viewerId, invoiceId) {
      const r = await db.prepare(`SELECT 1 AS ok FROM invoice_permissions WHERE tenant_id = ? AND viewer_id = ? AND invoice_id = ?
        AND permission = 'invoice:read'`).bind(tenantId, viewerId, invoiceId).first<Row>();
      return r?.ok === 1;
    },
    async tenantOfInvoice(invoiceId) {
      const r = await db.prepare('SELECT tenant_id FROM tenant_directory WHERE invoice_id = ?').bind(invoiceId).first<Row>();
      return str(r?.tenant_id);
    },
  };
}

const parse = (v: unknown) => v === null ? null : Object.freeze(JSON.parse(String(v)));

/** Mirrors AttemptLineageReader.attempts(): same query, ordering, shape and attestation. */
export function d1Attempts(db: D1Like): AttemptRepository {
  return {
    async attempts(binding, operation: AttemptOperation): Promise<readonly AttemptLineage[]> {
      const { results } = await db.prepare(`SELECT * FROM attempts WHERE tenant_id = ? AND invoice_id = ? AND digest = ? AND operation = ?
        ORDER BY created_at_ms, attempt_id`).bind(binding.tenantId, binding.invoiceId, binding.digest, operation).all<Row>();
      const out: AttemptLineage[] = [];
      for (const r of results) {
        const events = (await db.prepare('SELECT seq, kind, at_ms, detail FROM attempt_events WHERE attempt_id = ? ORDER BY seq')
          .bind(String(r.attempt_id)).all<Row>()).results;
        const history: LineageEvent[] = events.map(e => Object.freeze({
          seq: Number(e.seq), kind: e.kind as LineageEventKind, atMs: Number(e.at_ms), detail: Object.freeze(JSON.parse(String(e.detail))),
        }));
        out.push(attest<AttemptLineage>({
          source: 'attempt-store', id: String(r.attempt_id), tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id),
          digest: String(r.digest), operation: r.operation as AttemptOperation, lineage: r.lineage as 'recorded' | 'unresolved',
          recordedRevision: r.recorded_revision === null ? null : Number(r.recorded_revision),
          authorization: parse(r.authorization) as AuthorizationFingerprint | null, envelope: parse(r.envelope) as AttemptEnvelope | null,
          hash: r.hash === null ? null : String(r.hash), dispatch: r.dispatch as DispatchState,
          closed: r.closed === null ? null : r.closed as CloseReason, createdAtMs: Number(r.created_at_ms),
          history: Object.freeze(history),
        }));
      }
      return Object.freeze(out);
    },
  };
}

export function d1Repositories(db: D1Like): Repositories {
  return Object.freeze({
    invoices: d1Invoices(db), signatures: d1Signatures(db), sessions: d1Sessions(db),
    permissions: d1Permissions(db), attempts: d1Attempts(db),
  });
}
