/**
 * Request handling for the read-only API, independent of the Workers runtime so tests can run the exact same
 * composition with instrumented repositories. index.ts binds it to env (D1, secrets) and module-scope state.
 *
 * Order (each step fails closed with a uniform body, see README):
 *   1. any Origin header (a browser)            → 401 unauthenticated-service, never CORS headers
 *   2. contract parse: method / path / query    → 405 / 400, before anything touches data
 *   3. HMAC service auth (also for /v1/health)  → 401 unauthenticated-service
 *   4. per-isolate rate limit per key id        → 429 rate-limited
 *   5. viewer session → permission + tenant directory → invoice read → P10.3 projector
 *      anything that is not a projection        → 404 not-found-or-forbidden (no existence oracle)
 *   Exceptions anywhere                         → 503 unavailable (no message leaked)
 */
import {
  VIEWER_HEADER, errorBody, errorStatus, health, parseRequest, parseResponse, responseHeaders, type ApiResponse, type ErrorCode,
} from '../../../src/api-contract.ts';
import { readAuthoritativeInvoice } from '../../../src/authoritative-invoice.ts';
import { authenticateViewerToken, projectionSources, type Repositories } from '../../../src/repositories.ts';
import { NonceWindow, SERVICE_HEADERS, verifyRequest } from '../../../src/service-auth.ts';

export const MAX_OBSERVATION_AGE_MS = 60_000;

/** Token bucket per key id. Per isolate only: Workers run many isolates, so this is a local brake, not a global quota. */
export class RateLimiter {
  #buckets = new Map<string, { tokens: number; at: number }>();
  readonly capacity: number; readonly refillPerSecond: number;
  constructor(capacity = 60, refillPerSecond = 1) { this.capacity = capacity; this.refillPerSecond = refillPerSecond; }
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
  nonces: NonceWindow; limiter: RateLimiter; now: () => number; log: (line: LogLine) => void;
}>;

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

function respond(body: ApiResponse): Response {
  // Defense in depth: never send a body the public contract would not accept.
  const safe = parseResponse(JSON.parse(JSON.stringify(body))) ? body : errorBody('unavailable');
  const status = safe.kind === 'error' ? errorStatus[safe.error] : 200;
  const headers = new Headers(responseHeaders);
  if (status === 405) headers.set('allow', 'GET');
  return new Response(JSON.stringify(safe), { status, headers });
}

const rid = () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const id = rid();
  let route = 'unknown', keyId: string | undefined;
  const fail = (code: ErrorCode) => respond(errorBody(code));
  let response: Response;
  try {
    response = await (async () => {
      if (request.headers.has('origin')) return fail('unauthenticated-service');
      if (request.method === 'OPTIONS') return fail('method-not-allowed');
      const parsed = parseRequest(request.method, request.url, request.headers);
      if (parsed === 'method-not-allowed' || parsed === 'invalid-request') return fail(parsed);
      route = typeof parsed === 'string' ? 'invoice' : parsed.route;
      const keys = deps.keys();
      if (!keys) return fail('unavailable');
      const nowMs = deps.now();
      const viewerToken = route === 'invoice' ? request.headers.get(VIEWER_HEADER) ?? '' : '';
      const ok = await verifyRequest({ keys, headers: request.headers, method: request.method, path: new URL(request.url).pathname,
        body: '', viewerToken, nowMs, nonces: deps.nonces });
      if (!ok) return fail('unauthenticated-service');
      keyId = request.headers.get(SERVICE_HEADERS.keyId)!;
      if (!deps.limiter.take(keyId, nowMs)) return fail('rate-limited');
      if (typeof parsed === 'string') return fail(parsed); // e.g. malformed viewer token: same 404 as any denial
      if (parsed.route === 'health') return respond(health());
      const repos = deps.repos();
      const viewer = await authenticateViewerToken(repos, parsed.viewerToken, nowMs);
      if (!viewer) return fail('not-found-or-forbidden');
      // One request time for the whole read: the projector rejects observations stamped after opts.nowMs, so a live
      // clock here would make every observation "from the future" by a few ms and fail closed.
      const sources = projectionSources(repos, { audience: deps.audience, clock: () => nowMs });
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
