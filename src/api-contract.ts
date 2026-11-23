/**
 * Versioned, runtime-validated contract for the read-only Daidai API (P10.4).
 * Shared by the Cloudflare Worker (workers/api) and the Next.js server client (apps/web/lib). Worker-safe.
 *
 * Endpoints (none callable from a browser; every request carries service authentication, service-auth.ts):
 *   GET    /v1/health
 *   GET    /v1/invoices                                viewer token in `x-daidai-viewer` (P10.5: permitted invoice list)
 *   GET    /v1/invoices/{invoiceId}/authoritative     viewer token in `x-daidai-viewer`
 *   POST   /v1/sessions                                body {"invitation": "<code>"} (P10.5: single-use invitation exchange)
 *   DELETE /v1/sessions/current                        viewer token in `x-daidai-viewer` (P10.5: revoke)
 * Only the session endpoints write, and only to authentication tables. Nothing here touches funds or the ledger.
 */
import { isAuthoritativeInvoiceProjection, type AuthoritativeInvoiceProjection } from './authoritative-invoice.ts';

export const API_VERSION = 'v1' as const;
export const VIEWER_HEADER = 'x-daidai-viewer';
export const errorCodes = ['invalid-request', 'unauthenticated-service', 'not-found-or-forbidden', 'unavailable', 'rate-limited', 'method-not-allowed', 'invalid-credentials'] as const;
export type ErrorCode = typeof errorCodes[number];
export const errorStatus: Record<ErrorCode, number> = {
  'invalid-request': 400, 'unauthenticated-service': 401, 'not-found-or-forbidden': 404, unavailable: 503, 'rate-limited': 429, 'method-not-allowed': 405, 'invalid-credentials': 403,
};
/** Maximum accepted request body (session exchange only). */
export const MAX_BODY_BYTES = 1024;

export type HealthResponse = Readonly<{ apiVersion: 'v1'; kind: 'health'; status: 'ok'; readOnly: true; execution: 'disabled' }>;
export type InvoiceResponse = Readonly<{ apiVersion: 'v1'; kind: 'authoritative-invoice'; invoice: AuthoritativeInvoiceProjection }>;
export type ErrorResponse = Readonly<{ apiVersion: 'v1'; kind: 'error'; error: ErrorCode }>;
/** Session material travels only over the signed server-to-server channel; the Vercel server stores it in an HttpOnly cookie. */
export type SessionResponse = Readonly<{ apiVersion: 'v1'; kind: 'session'; token: string; expiresAtMs: number; idleTimeoutMs: number }>;
export type RevokedResponse = Readonly<{ apiVersion: 'v1'; kind: 'revoked' }>;
export type InvoiceSummary = Readonly<{ id: string; revision: number; targetAtomic: string; maxDebitAtomic: string }>;
export type InvoiceListResponse = Readonly<{ apiVersion: 'v1'; kind: 'invoice-list'; invoices: readonly InvoiceSummary[] }>;
export type ApiResponse = HealthResponse | InvoiceResponse | ErrorResponse | SessionResponse | RevokedResponse | InvoiceListResponse;
export const MAX_LIST = 100;

export type ParsedRequest =
  | Readonly<{ route: 'health' }>
  | Readonly<{ route: 'invoice'; invoiceId: string; viewerToken: string }>
  | Readonly<{ route: 'invoice-list'; viewerToken: string }>
  | Readonly<{ route: 'session-create' }>
  | Readonly<{ route: 'session-revoke'; viewerToken: string }>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

/** Parses method, path and headers. No query strings, no fragments and no extra path segments are accepted. */
export function parseRequest(method: string, url: string, headers: Headers): ParsedRequest | ErrorCode {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'invalid-request'; }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return 'invalid-request';
  const viewer = () => { const t = headers.get(VIEWER_HEADER) ?? ''; return tokenPattern.test(t) ? t : null; };
  if (parsed.pathname === '/v1/sessions') {
    if (method !== 'POST') return 'method-not-allowed';
    if (!/^application\/json(;\s*charset=utf-8)?$/i.test(headers.get('content-type') ?? '')) return 'invalid-request';
    return { route: 'session-create' };
  }
  if (parsed.pathname === '/v1/sessions/current') {
    if (method !== 'DELETE') return 'method-not-allowed';
    const t = viewer(); return t ? { route: 'session-revoke', viewerToken: t } : 'not-found-or-forbidden';
  }
  if (method !== 'GET') return 'method-not-allowed';
  if (parsed.pathname === '/v1/health') return { route: 'health' };
  if (parsed.pathname === '/v1/invoices') { const t = viewer(); return t ? { route: 'invoice-list', viewerToken: t } : 'not-found-or-forbidden'; }
  const m = /^\/v1\/invoices\/([^/]+)\/authoritative$/.exec(parsed.pathname);
  if (!m) return 'invalid-request';
  let invoiceId: string;
  try { invoiceId = decodeURIComponent(m[1]); } catch { return 'invalid-request'; }
  if (!idPattern.test(invoiceId)) return 'invalid-request';
  const viewerToken = headers.get(VIEWER_HEADER) ?? '';
  if (!tokenPattern.test(viewerToken)) return 'not-found-or-forbidden';
  return { route: 'invoice', invoiceId, viewerToken };
}

export const health = (): HealthResponse => ({ apiVersion: API_VERSION, kind: 'health', status: 'ok', readOnly: true, execution: 'disabled' });
export const errorBody = (error: ErrorCode): ErrorResponse => ({ apiVersion: API_VERSION, kind: 'error', error });

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

/** Validates a response body received over the wire (the Vercel server never trusts the transport by itself). */
export function parseResponse(value: unknown): ApiResponse | null {
  if (exactKeys(value, ['apiVersion', 'kind', 'status', 'readOnly', 'execution'])) {
    return value.apiVersion === API_VERSION && value.kind === 'health' && value.status === 'ok' && value.readOnly === true &&
      value.execution === 'disabled' ? value as HealthResponse : null;
  }
  if (exactKeys(value, ['apiVersion', 'kind', 'invoice'])) {
    return value.apiVersion === API_VERSION && value.kind === 'authoritative-invoice' && isAuthoritativeInvoiceProjection(value.invoice)
      ? value as InvoiceResponse : null;
  }
  if (exactKeys(value, ['apiVersion', 'kind', 'error'])) {
    return value.apiVersion === API_VERSION && value.kind === 'error' && (errorCodes as readonly unknown[]).includes(value.error)
      ? value as ErrorResponse : null;
  }
  return null;
}

/** Headers every API response must carry: private data is never cached, never framed, never sniffed. */
export const responseHeaders: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, private, max-age=0',
  'pragma': 'no-cache',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'vary': 'x-daidai-viewer, x-daidai-signature',
});

const invitationPattern = /^[A-Za-z0-9_-]{32,128}$/;
/** Parses the session-exchange body: exactly {"invitation": "<code>"}, at most MAX_BODY_BYTES. */
export function parseSessionBody(text: string): Readonly<{ invitation: string }> | null {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!exactKeys(v, ['invitation']) || typeof v.invitation !== 'string' || !invitationPattern.test(v.invitation)) return null;
  return { invitation: v.invitation };
}

/** Validates the P10.5 response kinds (in addition to parseResponse). */
export function parseSessionOrListResponse(value: unknown): SessionResponse | RevokedResponse | InvoiceListResponse | ErrorResponse | null {
  if (exactKeys(value, ['apiVersion', 'kind', 'token', 'expiresAtMs', 'idleTimeoutMs'])) {
    return value.apiVersion === API_VERSION && value.kind === 'session' && typeof value.token === 'string' && tokenPattern.test(value.token) &&
      Number.isSafeInteger(value.expiresAtMs) && (value.expiresAtMs as number) > 0 &&
      Number.isSafeInteger(value.idleTimeoutMs) && (value.idleTimeoutMs as number) > 0 ? value as SessionResponse : null;
  }
  if (exactKeys(value, ['apiVersion', 'kind'])) return value.apiVersion === API_VERSION && value.kind === 'revoked' ? value as RevokedResponse : null;
  if (exactKeys(value, ['apiVersion', 'kind', 'invoices'])) {
    if (value.apiVersion !== API_VERSION || value.kind !== 'invoice-list' || !Array.isArray(value.invoices) || value.invoices.length > MAX_LIST) return null;
    const ok = value.invoices.every(i => exactKeys(i, ['id', 'revision', 'targetAtomic', 'maxDebitAtomic']) && typeof i.id === 'string' && idPattern.test(i.id) &&
      Number.isSafeInteger(i.revision) && (i.revision as number) >= 0 && typeof i.targetAtomic === 'string' && /^[1-9][0-9]{0,77}$/.test(i.targetAtomic) &&
      typeof i.maxDebitAtomic === 'string' && /^[1-9][0-9]{0,77}$/.test(i.maxDebitAtomic));
    return ok ? value as InvoiceListResponse : null;
  }
  const r = parseResponse(value);
  return r && r.kind === 'error' ? r : null;
}
