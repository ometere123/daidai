import { parseProduct, parseProductReply, productPath } from '../../../src/product-contract.ts';
import { localProduct } from './product';
/**
 * Server-only typed client for the Daidai API (P10.4 read-only, P10.5 session exchange and invoice list).
 * Config comes from server environment variables only (never NEXT_PUBLIC_*). Never logs tokens, keys or bodies.
 * Every request is HMAC-signed over method, path, body and viewer token (src/service-auth.ts) with a fresh nonce.
 */
import { parseResponse, parseSessionOrListResponse, VIEWER_HEADER, type InvoiceSummary } from '../../../src/api-contract.ts';
import { signRequest } from '../../../src/service-auth.ts';
import type { AuthoritativeInvoiceProjection } from '../../../src/authoritative-invoice.ts';

if (typeof window !== 'undefined') throw new Error('daidai-api is server-only');

export type InvoiceResult =
  | Readonly<{ kind: 'invoice'; invoice: AuthoritativeInvoiceProjection }>
  | Readonly<{ kind: 'not-found-or-forbidden' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'misconfigured' }>;
export type ListResult =
  | Readonly<{ kind: 'invoice-list'; invoices: readonly InvoiceSummary[] }>
  | Readonly<{ kind: 'not-found-or-forbidden' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'misconfigured' }>;
export type SessionResult =
  | Readonly<{ kind: 'session'; token: string; expiresAtMs: number }>
  | Readonly<{ kind: 'invalid' }>;

type Config = { baseUrl: URL; keyId: string; key: string };
const TIMEOUT_MS = 5_000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
const invitationPattern = /^[A-Za-z0-9_-]{32,128}$/;

function readConfig(env: NodeJS.ProcessEnv = process.env): Config | null {
  const base = env.DAIDAI_API_BASE_URL ?? '';
  const keyId = env.DAIDAI_SERVICE_KEY_ID ?? '';
  const key = env.DAIDAI_SERVICE_KEY ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || key.length < 32) return null;
  let baseUrl: URL;
  try { baseUrl = new URL(base); } catch { return null; }
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname))) return null;
  if (baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password) return null;
  return { baseUrl, keyId, key };
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One signed request. Returns the decoded JSON body, 'unavailable' on transport failure, or 'misconfigured'. No retries. */
async function signedCall(method: 'GET' | 'POST' | 'DELETE', apiPath: string, o: { body?: string; viewerToken?: string } = {}): Promise<unknown> {
  if (typeof window !== 'undefined') throw new Error('daidai-api is server-only');
  const config = readConfig();
  if (!config) return 'misconfigured';
  const path = config.baseUrl.pathname.replace(/\/+$/, '') + apiPath;
  const url = new URL(path, config.baseUrl.origin);
  try {
    const signed = await signRequest({ keyId: config.keyId, secret: config.key, method, path, body: o.body ?? '',
      viewerToken: o.viewerToken ?? '', nowMs: Date.now(), nonce: nonce() });
    const headers: Record<string, string> = { ...signed, accept: 'application/json' };
    if (o.viewerToken) headers[VIEWER_HEADER] = o.viewerToken;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url, { method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers, body: o.body });
    return await response.json();
  } catch {
    return 'unavailable';
  }
}

export async function getAuthoritativeInvoice(invoiceId: string, viewerToken: string): Promise<InvoiceResult> {
  if (!idPattern.test(invoiceId) || !tokenPattern.test(viewerToken)) return { kind: 'not-found-or-forbidden' };
  const body = await signedCall('GET', '/v1/invoices/' + encodeURIComponent(invoiceId) + '/authoritative', { viewerToken });
  if (body === 'misconfigured') return { kind: 'misconfigured' };
  const parsed = parseResponse(body);
  if (!parsed) return { kind: 'unavailable' };
  if (parsed.kind === 'authoritative-invoice') {
    return parsed.invoice.id === invoiceId ? { kind: 'invoice', invoice: parsed.invoice } : { kind: 'unavailable' };
  }
  if (parsed.kind === 'error' && parsed.error === 'not-found-or-forbidden') return { kind: 'not-found-or-forbidden' };
  if (parsed.kind === 'error' && parsed.error === 'unauthenticated-service') return { kind: 'misconfigured' };
  return { kind: 'unavailable' };
}

/** Lists invoices the session may see. Doubles as per-request session validation (the Worker checks expiry, idle, revocation). */
export async function listInvoices(viewerToken: string): Promise<ListResult> {
  if (!tokenPattern.test(viewerToken)) return { kind: 'not-found-or-forbidden' };
  const body = await signedCall('GET', '/v1/invoices', { viewerToken });
  if (body === 'misconfigured') return { kind: 'misconfigured' };
  const parsed = parseSessionOrListResponse(body);
  if (!parsed) return { kind: 'unavailable' };
  if (parsed.kind === 'invoice-list') return { kind: 'invoice-list', invoices: parsed.invoices };
  if (parsed.kind === 'error' && parsed.error === 'not-found-or-forbidden') return { kind: 'not-found-or-forbidden' };
  if (parsed.kind === 'error' && parsed.error === 'unauthenticated-service') return { kind: 'misconfigured' };
  return { kind: 'unavailable' };
}

/** Exchanges a single-use invitation. Every failure collapses to 'invalid' (no enumeration). */
export async function createSession(invitation: string, previousToken = ''): Promise<SessionResult> {
  if (!invitationPattern.test(invitation)) return { kind: 'invalid' };
  const parsed = parseSessionOrListResponse(await signedCall('POST', '/v1/sessions', { body: JSON.stringify({ invitation }), viewerToken: tokenPattern.test(previousToken) ? previousToken : '' }));
  if (parsed?.kind === 'session') return { kind: 'session', token: parsed.token, expiresAtMs: parsed.expiresAtMs };
  return { kind: 'invalid' };
}

/** Revokes the session at the Worker. The caller clears the cookie after revocation is confirmed. */
export async function revokeSession(viewerToken: string): Promise<boolean> {
  if (!tokenPattern.test(viewerToken)) return false;
  const parsed = parseSessionOrListResponse(await signedCall('DELETE', '/v1/sessions/current', { viewerToken }));
  return parsed?.kind === 'revoked';
}

export async function productCall(input: Record<string, unknown>, viewerToken: string) {
  if (!localProduct() || !tokenPattern.test(viewerToken)) return null;
  const wire = { ...input, version: 'p11.v1' };
  if (!parseProduct(wire)) return null;
  return parseProductReply(await signedCall('POST', productPath, { body: JSON.stringify(wire), viewerToken }));
}
