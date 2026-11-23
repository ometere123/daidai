/**
 * Repository interfaces for the authoritative read path (P10.4) and their composition into P10.3 projection sources.
 * Worker-safe. Implementations: node:sqlite (tests, existing harness) and Cloudflare D1 (workers/api).
 *
 * Repositories return *rows*. Only this composition layer (server-side, trusted) turns them into attested evidence after
 * re-deriving commitments and verifying signatures, so a repository can never hand the projector authority by label.
 */
import type {
  AttemptLineage, AttemptOperation,
} from './attempt-lineage.ts';
import {
  type CommitmentBinding, type ProjectionSources, type StoredInvoice, type ViewerGrant,
} from './authoritative-invoice.ts';
import { authorizationObserver, canonicalBlockReader, transactionVerifier, type Rpc } from './chain-evidence.ts';
import { attest } from './evidence-attestation.ts';
import { commit, type Invoice } from './invoice-core.ts';
import { authenticateViewer, invoiceViewerAuthorizer, type AuthenticatedViewer, type PermissionStore, type ViewerAuthenticator } from './viewer-access.ts';
import type { Hex } from 'viem';

export type InvoiceRow = Readonly<{ tenantId: string; invoiceId: string; invoice: Invoice; digest: string; revision: number }>;
export interface InvoiceRepository { read(tenantId: string, invoiceId: string): Promise<InvoiceRow | null> }
export interface SignatureRepository { read(binding: CommitmentBinding): Promise<Readonly<{ approval: Hex; consent: Hex }> | null> }
/** Sessions are looked up by the SHA-256 of the opaque token; raw tokens are never stored. */
export interface ViewerSessionRepository {
  findByTokenHash(tokenHash: string): Promise<Readonly<{ viewerId: string; tenantId: string; authenticatedAtMs: number; expiresAtMs: number }> | null>;
}
export type PermissionRepository = PermissionStore;
export interface AttemptRepository { attempts(binding: CommitmentBinding, operation: AttemptOperation): Promise<readonly AttemptLineage[]> }

export type Repositories = Readonly<{
  invoices: InvoiceRepository; signatures: SignatureRepository; sessions: ViewerSessionRepository;
  permissions: PermissionRepository; attempts: AttemptRepository;
}>;

export type CompositionOptions = Readonly<{
  /**
   * `clock` MUST return the request's fixed `nowMs` (the same value passed to readAuthoritativeInvoice), not a live
   * Date.now(): the projector rejects observations newer than `nowMs`, so a live clock makes every read fail closed.
   */
  audience: string; clock: () => number;
  /** Absent by default: without an approved read-only chain reader, operations stay unknown and nothing settles. */
  chain?: Readonly<{ rpc: Rpc; attributionCode: string }>;
}>;

const hashToken = async (token: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
  .map(b => b.toString(16).padStart(2, '0')).join('');

export function sessionAuthenticator(sessions: ViewerSessionRepository): ViewerAuthenticator {
  return { async verify(credential) { return sessions.findByTokenHash(await hashToken(credential)); } };
}

/** Authenticates the viewer token (server-side session lookup). Returns a branded viewer or null. */
export async function authenticateViewerToken(repos: Repositories, token: string, nowMs: number): Promise<AuthenticatedViewer | null> {
  return authenticateViewer(sessionAuthenticator(repos.sessions), token, nowMs);
}

/** Composes repository rows into attested P10.3 projection sources. */
export function projectionSources(repos: Repositories, o: CompositionOptions): ProjectionSources<unknown> {
  const snapshot = async (g: ViewerGrant): Promise<StoredInvoice | null> => {
    const row = await repos.invoices.read(g.tenantId, g.invoiceId);
    if (!row || row.tenantId !== g.tenantId || row.invoiceId !== g.invoiceId || !Number.isSafeInteger(row.revision) || row.revision < 0) return null;
    let committed;
    try { committed = commit(row.invoice); } catch { return null; }
    if (committed.digest !== row.digest || committed.invoice.id !== g.invoiceId) return null;
    return attest<StoredInvoice>({ source: 'invoice-store', tenantId: g.tenantId, invoice: committed.invoice, digest: committed.digest,
      revision: row.revision, observedAtMs: o.clock() });
  };
  return {
    authorize: invoiceViewerAuthorizer(repos.permissions, o.clock),
    readInvoice: snapshot,
    observeAuthorization: authorizationObserver(b => repos.signatures.read(b), b => snapshot(b), o.audience, o.clock),
    // Attempt rows are re-attested by the D1/node lineage readers themselves; pass them through untouched.
    readAttempts: (b, op) => repos.attempts.attempts(b, op),
    observeTransaction: o.chain ? transactionVerifier(o.chain.rpc, o.chain.attributionCode, o.clock) : async () => null,
    observeCanonicalBlock: o.chain ? canonicalBlockReader(o.chain.rpc, o.clock) : async () => null,
  };
}
