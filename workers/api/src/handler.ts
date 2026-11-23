/**
 * Request handling for the read-only API, independent of the Workers runtime so tests can run the exact same
 * composition with instrumented repositories. index.ts binds it to env (D1, secrets) and module-scope state.
 *
 * Order (each step fails closed with a uniform body, see README):
 *   1. any Origin header (a browser)            → 401 unauthenticated-service, never CORS headers
 *   2. contract parse: method / path / query    → 405 / 400, before anything touches data
 *   2b. POST body larger than MAX_BODY_BYTES    → 400 invalid-request (read with a hard cap, before auth)
 *   3. HMAC service auth over method, path, body and viewer token (also /v1/health) → 401 unauthenticated-service
 *   3b. global nonce claim in D1 (service_nonces): duplicate → 401; any other D1 error → 503 (fail closed)
 *   4. per-isolate rate limit per key id (+ a stricter bucket for invitation exchange) → 429 rate-limited
 *   5. route:
 *      POST /v1/sessions        body → invitation exchange; any failure → 403 invalid-credentials (uniform)
 *      DELETE-method /v1/sessions/current: revoke; always 'revoked' (no oracle)
 *      GET /v1/invoices         → session → permitted list (re-derived commitments)
 *      GET /v1/invoices/{id}/authoritative → session → permission + tenant directory → invoice read → P10.3 projector
 *      anything that is not a projection        → 404 not-found-or-forbidden (no existence oracle)
 *   Exceptions anywhere                         → 503 unavailable (no message leaked)
 */
import {
  MAX_BODY_BYTES, MAX_LIST, VIEWER_HEADER, errorBody, errorStatus, health, parseRequest, parseResponse, parseSessionBody,
  parseSessionOrListResponse, responseHeaders, type ApiResponse, type ErrorCode, type InvoiceSummary,
} from '../../../src/api-contract.ts';
import { readAuthoritativeInvoice } from '../../../src/authoritative-invoice.ts';
import { commit } from '../../../src/invoice-core.ts';
import { projectionSources, type Repositories } from '../../../src/repositories.ts';
import { NonceWindow, SERVICE_HEADERS, verifyRequest } from '../../../src/service-auth.ts';
import { authenticateViewer, type AuthenticatedViewer } from '../../../src/viewer-access.ts';
import { product } from './product.ts';
import { productPath } from '../../../src/product-contract.ts';
import type { ChainConfig } from './chain-config.ts';
import { claimNonce, d1SessionAuthenticator, exchangeInvitation, pruneNonces, revokeSession } from './d1-auth.ts';
import type { D1Like } from './d1-schema.ts';

export const MAX_OBSERVATION_AGE_MS = 60_000;

/**
 * Token bucket per key id. Per isolate only: Workers run many isolates, so this is a local brake, not a global quota.
 * P13: the bucket is keyed by *service* key, and the Vercel server is a single service identity shared by every user,
 * so the default is a service-level budget (600 burst, 10/s). The P10 default (60, 1/s) let one multipage session
 * exhaust it for everyone (observed: 429 on the 60th call of the product journey). The stricter invitation-exchange
 * bucket (SESSION_BUCKET) and the optional global launch quota (launch-rate.ts) are unchanged.
 */
export class RateLimiter {
  #buckets = new Map<string, { tokens: number; at: number }>();
  readonly capacity: number; readonly refillPerSecond: number;
  constructor(capacity = 600, refillPerSecond = 10) { this.capacity = capacity; this.refillPerSecond = refillPerSecond; }
  take(key: string, nowMs: number): boolean {
    const b = this.#buckets.get(key) ?? { tokens: this.capacity, at: nowMs };
    b.tokens = Math.min(this.capacity, b.tokens + Math.max(0, nowMs - b.at) / 1000 * this.refillPerSecond);
    b.at = nowMs;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.#buckets.set(key, b);
    if (this.#buckets.size > 10_000) this.#buckets.delete(this.#buckets.keys().next().value!);
    return ok;
  }
}

export type LogLine = Readonly<{ rid: string; route: string; status: number; keyId?: string }>;
export type Deps = Readonly<{
  repos: () => Repositories; keys: () => Readonly<Record<string, string>> | null; audience: string;
  /** The D1 binding for authentication state (sessions, invitations, service_nonces). */
  db: () => D1Like;
  nonces: NonceWindow; limiter: RateLimiter; now: () => number; log: (line: LogLine) => void;
  /** Optional read-only chain reader (chain-config.ts). Absent by default: operations stay unknown. */
  chain?: () => ChainConfig | undefined;
  localProduct?: boolean;
  distributedRate?: (scope: 'service' | 'invitation', now: number) => Promise<boolean>;
  /** Probability source for opportunistic nonce pruning (default Math.random; prune when < PRUNE_PROBABILITY). */
  random?: () => number;
  /** Override for the stricter invitation-exchange bucket (default: one per isolate). */
  sessionLimiter?: RateLimiter;
}>;
export const PRUNE_PROBABILITY = 0.01;
/** Invitation exchanges per key id share the normal bucket AND this stricter one (per isolate). */
export const SESSION_BUCKET = Object.freeze({ capacity: 10, refillPerSecond: 0.2 });

/** Parses DAIDAI_SERVICE_KEYS: a JSON object {keyId: secret}, every secret at least 32 characters. Null if unusable. */
export function parseServiceKeys(raw: unknown): Readonly<Record<string, string>> | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(k) || typeof v !== 'string' || v.length < 32) return null;
    out[k] = v;
  }
  return Object.keys(out).length ? Object.freeze(out) : null;
}

function respond(body: ApiResponse, allow = 'GET'): Response {
  // Defense in depth: never send a body the public contract would not accept.
  const wire = JSON.parse(JSON.stringify(body));
  const safe = parseResponse(wire) || parseSessionOrListResponse(wire) ? body : errorBody('unavailable');
  const status = safe.kind === 'error' ? errorStatus[safe.error] : 200;
  const headers = new Headers(responseHeaders);
  if (status === 405) headers.set('allow', allow);
  return new Response(JSON.stringify(safe), { status, headers });
}

/** Reads at most `max` bytes of the body; null if larger or not valid UTF-8. */
async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(/^[0-9]{1,10}$/.test(declared) && Number(declared) <= max)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { return null; }
}

/** Permitted invoices of the viewer's own tenant, at most MAX_LIST; rows whose commitment no longer matches are skipped. */
async function listInvoices(db: D1Like, viewer: AuthenticatedViewer): Promise<InvoiceSummary[]> {
  const { results } = await db.prepare(`SELECT i.invoice_id, i.body, i.digest, i.revision FROM invoice_permissions p
      JOIN tenant_directory d ON d.invoice_id = p.invoice_id AND d.tenant_id = p.tenant_id
      JOIN invoices i ON i.tenant_id = p.tenant_id AND i.invoice_id = p.invoice_id
    WHERE p.tenant_id = ? AND p.viewer_id = ? AND p.permission = 'invoice:read'
    ORDER BY i.invoice_id LIMIT ?`).bind(viewer.tenantId, viewer.viewerId, MAX_LIST).all<Record<string, unknown>>();
  const out: InvoiceSummary[] = [];
  for (const r of results) {
    if (typeof r.body !== 'string' || typeof r.digest !== 'string' || typeof r.invoice_id !== 'string' ||
        typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) || r.revision < 0) continue;
    let committed;
    try { committed = commit(JSON.parse(r.body)); } catch { continue; }
    if (committed.digest !== r.digest || committed.invoice.id !== r.invoice_id) continue;
    out.push(Object.freeze({ id: committed.invoice.id, revision: r.revision, targetAtomic: committed.invoice.buyAmount, maxDebitAtomic: committed.invoice.maxSell }));
  }
  return out;
}

const sessionLimiter = new RateLimiter(SESSION_BUCKET.capacity, SESSION_BUCKET.refillPerSecond);
const rid = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const id = rid();
  let route = 'unknown', keyId: string | undefined, allow = 'GET';
  const fail = (code: ErrorCode) => respond(errorBody(code), allow);
  let response: Response;
  try {
    response = await (async () => {
      if (request.headers.has('origin')) return fail('unauthenticated-service');
      try {
        const p = new URL(request.url).pathname;
        allow = p === '/v1/sessions' ? 'POST' : p === '/v1/sessions/current' ? 'DELETE' : 'GET';
      } catch { /* parseRequest reports it */ }
      if (request.method === 'OPTIONS') return fail('method-not-allowed');
      const url = new URL(request.url);
      const productRequest = url.pathname === productPath;
      if (productRequest) {
        if (!deps.localProduct || url.hostname !== '127.0.0.1') return fail('not-found-or-forbidden');
        allow = 'POST';
        if (request.method !== 'POST') return fail('method-not-allowed');
        if (url.search || request.headers.get('content-type') !== 'application/json') return fail('invalid-request');
      }
      const parsed = productRequest ? { route: 'product' as const, viewerToken: request.headers.get(VIEWER_HEADER) ?? '' }
        : parseRequest(request.method, request.url, request.headers);
      if (parsed === 'method-not-allowed' || parsed === 'invalid-request') return fail(parsed);
      route = typeof parsed === 'string' ? 'invoice' : parsed.route;
      let body = '';
      if (route === 'session-create' || route === 'product') {
        const read = await readBody(request, MAX_BODY_BYTES);
        if (read === null) return fail('invalid-request');
        body = read;
      }
      const keys = deps.keys();
      if (!keys) return fail('unavailable');
      const nowMs = deps.now();
      const viewerToken = route === 'product' || route === 'invoice' || route === 'invoice-list' || route === 'session-revoke' || route === 'session-create' ? request.headers.get(VIEWER_HEADER) ?? '' : '';
      const ok = await verifyRequest({ keys, headers: request.headers, method: request.method, path: new URL(request.url).pathname,
        body, viewerToken, nowMs, nonces: deps.nonces });
      if (!ok) return fail('unauthenticated-service');
      keyId = request.headers.get(SERVICE_HEADERS.keyId)!;
      // Global replay claim, after the signature verified (unauthenticated callers cannot fill the table).
      const db = deps.db();
      const claim = await claimNonce(db, keyId, request.headers.get(SERVICE_HEADERS.nonce)!, nowMs);
      if (claim === 'replayed') return fail('unauthenticated-service');
      if (claim !== 'claimed') return fail('unavailable');
      if ((deps.random ?? Math.random)() < PRUNE_PROBABILITY) { try { await pruneNonces(db, nowMs); } catch { /* best effort */ } }
      if (deps.distributedRate && !await deps.distributedRate('service', nowMs)) return fail('rate-limited');
      if (!deps.limiter.take(keyId, nowMs)) return fail('rate-limited');
      if (typeof parsed === 'string') return fail(parsed); // e.g. malformed viewer token: same 404 as any denial
      if (parsed.route === 'health') return respond(health());
      if (parsed.route === 'session-create') {
        if (!(deps.sessionLimiter ?? sessionLimiter).take(keyId, nowMs)) return fail('rate-limited');
        if (deps.distributedRate && !await deps.distributedRate('invitation', nowMs)) return fail('rate-limited');
        const input = parseSessionBody(body);
        if (!input) return fail('invalid-request');
        const issued = await exchangeInvitation(db, input.invitation, nowMs, viewerToken);
        if (!issued) return fail('invalid-credentials');
        return respond({ apiVersion: 'v1', kind: 'session', token: issued.token, expiresAtMs: issued.expiresAtMs, idleTimeoutMs: issued.idleTimeoutMs });
      }
      if (parsed.route === 'session-revoke') {
        await revokeSession(db, parsed.viewerToken, nowMs);
        return respond({ apiVersion: 'v1', kind: 'revoked' });
      }
      const viewer = await authenticateViewer(d1SessionAuthenticator(db), parsed.viewerToken, nowMs);
      if (!viewer) return fail('not-found-or-forbidden');
      if (parsed.route === 'product') {
        const result = await product(db, viewer, body, nowMs);
        const status = result.kind === 'denied' ? 404 : result.kind === 'conflict' ? 409 : result.kind === 'invalid' ? 400 : 200;
        return new Response(JSON.stringify(result), { status, headers: responseHeaders });
      }
      if (parsed.route === 'invoice-list') {
        return respond({ apiVersion: 'v1', kind: 'invoice-list', invoices: await listInvoices(db, viewer) });
      }
      const repos = deps.repos();
      // One request time for the whole read: the projector rejects observations stamped after opts.nowMs, so a live
      // clock here would make every observation "from the future" by a few ms and fail closed.
      const chain = deps.chain?.();
      const sources = projectionSources(repos, { audience: deps.audience, clock: () => nowMs, ...(chain ? { chain } : {}) });
      const invoice = await readAuthoritativeInvoice({ viewer, invoiceId: parsed.invoiceId }, sources,
        { nowMs, maxObservationAgeMs: MAX_OBSERVATION_AGE_MS, expectedAudience: deps.audience });
      if (!invoice) return fail('not-found-or-forbidden');
      return respond({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice });
    })();
  } catch {
    response = fail('unavailable');
  }
  try { deps.log(Object.freeze({ rid: id, route, status: response.status, ...(keyId ? { keyId } : {}) })); } catch { /* logging never fails a request */ }
  return response;
}
