/**
 * Versioned, runtime-validated contract for the read-only Daidai API (P10.4).
 * Shared by the Cloudflare Worker (workers/api) and the Next.js server client (apps/web/lib). Worker-safe.
 *
 * Endpoints (all GET, all read-only, none callable from a browser):
 *   GET /v1/health
 *   GET /v1/invoices/{invoiceId}/authoritative     viewer token in `x-daidai-viewer`
 * Every request carries service authentication headers (service-auth.ts).
 */
import { isAuthoritativeInvoiceProjection, type AuthoritativeInvoiceProjection } from './authoritative-invoice.ts';

export const API_VERSION = 'v1' as const;
export const VIEWER_HEADER = 'x-daidai-viewer';
export const errorCodes = ['invalid-request', 'unauthenticated-service', 'not-found-or-forbidden', 'unavailable', 'rate-limited', 'method-not-allowed'] as const;
export type ErrorCode = typeof errorCodes[number];
export const errorStatus: Record<ErrorCode, number> = {
  'invalid-request': 400, 'unauthenticated-service': 401, 'not-found-or-forbidden': 404, unavailable: 503, 'rate-limited': 429, 'method-not-allowed': 405,
};

export type HealthResponse = Readonly<{ apiVersion: 'v1'; kind: 'health'; status: 'ok'; readOnly: true; execution: 'disabled' }>;
export type InvoiceResponse = Readonly<{ apiVersion: 'v1'; kind: 'authoritative-invoice'; invoice: AuthoritativeInvoiceProjection }>;
export type ErrorResponse = Readonly<{ apiVersion: 'v1'; kind: 'error'; error: ErrorCode }>;
export type ApiResponse = HealthResponse | InvoiceResponse | ErrorResponse;

export type ParsedRequest =
  | Readonly<{ route: 'health' }>
  | Readonly<{ route: 'invoice'; invoiceId: string; viewerToken: string }>;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

/** Parses method, path and headers. No query strings, no bodies and no extra path segments are accepted. */
export function parseRequest(method: string, url: string, headers: Headers): ParsedRequest | ErrorCode {
  if (method !== 'GET') return 'method-not-allowed';
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'invalid-request'; }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return 'invalid-request';
  if (parsed.pathname === '/v1/health') return { route: 'health' };
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
