/**
 * Invoice-scoped viewer access (P10.3). Server-only.
 *
 * Authority comes from two server-owned sources, never from the client:
 *  1. a ViewerAuthenticator that turns an opaque credential into an AuthenticatedViewer (e.g. a verified session);
 *  2. a PermissionStore holding explicit `invoice:read` grants per (tenant, viewer, invoice).
 *
 * An AuthenticatedViewer can only be minted inside this module (in-process brand). A client-built object with the
 * same fields, a JSON round-tripped viewer, or a "grant" sent by the client is rejected. A wallet connection,
 * invoice approval or recipient consent signature is not viewer authentication and has no path into this module.
 *
 * Unauthorized and cross-tenant requests are rejected before any invoice data is read.
 */
import type { ViewerGrant } from './authoritative-invoice.ts';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const minted = new WeakSet<object>();

export type AuthenticatedViewer = Readonly<{ viewerId: string; tenantId: string; authenticatedAtMs: number; expiresAtMs: number }>;

/** Implemented by the real session/identity provider. Credentials are opaque to Daidai. */
export interface ViewerAuthenticator {
  verify(credential: string, nowMs: number): Promise<Readonly<{ viewerId: string; tenantId: string; authenticatedAtMs: number; expiresAtMs: number }> | null>;
}
/** Server-held access control. Must be scoped by tenant; never derived from invoice contents or client input. */
export interface PermissionStore {
  canReadInvoice(tenantId: string, viewerId: string, invoiceId: string): Promise<boolean>;
  /** Server directory of which tenant owns an invoice; used to refuse cross-tenant reads before any data access. */
  tenantOfInvoice(invoiceId: string): Promise<string | null>;
}

export async function authenticateViewer(auth: ViewerAuthenticator, credential: unknown, nowMs: number): Promise<AuthenticatedViewer | null> {
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 4096) return null;
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return null;
  let result;
  try { result = await auth.verify(credential, nowMs); } catch { return null; }
  if (!result || typeof result !== 'object') return null;
  // Read every field exactly once, then validate and freeze the copies (no getter can change them afterwards).
  const { viewerId, tenantId, authenticatedAtMs, expiresAtMs } = result;
  if (typeof viewerId !== 'string' || typeof tenantId !== 'string' || !idPattern.test(viewerId) || !idPattern.test(tenantId) ||
      !Number.isSafeInteger(authenticatedAtMs) || !Number.isSafeInteger(expiresAtMs) ||
      authenticatedAtMs > nowMs || expiresAtMs <= nowMs) return null;
  const viewer = Object.freeze({ viewerId, tenantId, authenticatedAtMs, expiresAtMs });
  minted.add(viewer);
  return viewer;
}

export function isAuthenticatedViewer(value: unknown): value is AuthenticatedViewer {
  return typeof value === 'object' && value !== null && minted.has(value);
}

/**
 * Builds the projector's `authorize` port. Returns a grant only for a minted, unexpired viewer with an explicit
 * permission for this exact invoice in the viewer's own tenant, and only if the server directory agrees the invoice
 * belongs to that tenant.
 */
export function invoiceViewerAuthorizer(permissions: PermissionStore, clock: () => number) {
  return async function authorize(viewer: unknown, invoiceId: string): Promise<ViewerGrant | null> {
    if (!isAuthenticatedViewer(viewer) || typeof invoiceId !== 'string' || !idPattern.test(invoiceId)) return null;
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0 || !(now < viewer.expiresAtMs)) return null;
    try {
      const owner = await permissions.tenantOfInvoice(invoiceId);
      if (owner === null || owner !== viewer.tenantId) return null;
      if (await permissions.canReadInvoice(viewer.tenantId, viewer.viewerId, invoiceId) !== true) return null;
    } catch { return null; }
    return Object.freeze({ tenantId: viewer.tenantId, invoiceId });
  };
}
