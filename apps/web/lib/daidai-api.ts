/**
 * Server-only typed client for the read-only Daidai API (P10.4).
 * Config comes from server environment variables only (never NEXT_PUBLIC_*). Never logs tokens, keys or bodies.
 */
import { parseResponse, VIEWER_HEADER } from '../../../src/api-contract.ts';
import { signRequest } from '../../../src/service-auth.ts';
import type { AuthoritativeInvoiceProjection } from '../../../src/authoritative-invoice.ts';

if (typeof window !== 'undefined') throw new Error('daidai-api is server-only');

export type InvoiceResult =
  | Readonly<{ kind: 'invoice'; invoice: AuthoritativeInvoiceProjection }>
  | Readonly<{ kind: 'not-found-or-forbidden' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'misconfigured' }>;

type Config = { baseUrl: URL; keyId: string; key: string };
const TIMEOUT_MS = 5_000;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

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

export async function getAuthoritativeInvoice(invoiceId: string, viewerToken: string): Promise<InvoiceResult> {
  if (typeof window !== 'undefined') throw new Error('daidai-api is server-only');
  const config = readConfig();
  if (!config) return { kind: 'misconfigured' };
  if (!idPattern.test(invoiceId) || !tokenPattern.test(viewerToken)) return { kind: 'not-found-or-forbidden' };
  const prefix = config.baseUrl.pathname.replace(/\/+$/, '');
  const path = prefix + '/v1/invoices/' + encodeURIComponent(invoiceId) + '/authoritative';
  const url = new URL(path, config.baseUrl.origin);
  let body: unknown;
  try {
    const headers = await signRequest({ keyId: config.keyId, secret: config.key, method: 'GET', path, viewerToken, nowMs: Date.now(), nonce: nonce() });
    const response = await fetch(url, {
      method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { ...headers, [VIEWER_HEADER]: viewerToken, accept: 'application/json' },
    });
    body = await response.json();
  } catch {
    return { kind: 'unavailable' };
  }
  const parsed = parseResponse(body);
  if (!parsed) return { kind: 'unavailable' };
  if (parsed.kind === 'authoritative-invoice') {
    return parsed.invoice.id === invoiceId ? { kind: 'invoice', invoice: parsed.invoice } : { kind: 'unavailable' };
  }
  if (parsed.kind === 'error' && parsed.error === 'not-found-or-forbidden') return { kind: 'not-found-or-forbidden' };
  if (parsed.kind === 'error' && parsed.error === 'unauthenticated-service') return { kind: 'misconfigured' };
  return { kind: 'unavailable' };
}
