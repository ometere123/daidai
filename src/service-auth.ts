/**
 * Service-to-service authentication between the Vercel server and the Cloudflare Worker (P10.4). Worker-safe (WebCrypto).
 *
 * The caller signs: METHOD \n PATH \n TIMESTAMP_MS \n NONCE \n SHA256(body) \n SHA256(viewer token) with HMAC-SHA256 under a
 * shared key, identified by a key id for rotation. The Worker checks the key id, a ±60 s skew window, a nonce replay
 * window and a constant-time signature comparison. Browsers never hold the key: requests carrying an Origin header
 * are rejected by the Worker. This authenticates the *calling service*, not the viewer.
 *
 * Limitation: the nonce cache is per Worker isolate. A globally consistent replay store (Durable Object or D1 nonce
 * table) is required before production; the ±60 s window bounds exposure meanwhile.
 */
export const SERVICE_HEADERS = Object.freeze({
  keyId: 'x-daidai-key-id', timestamp: 'x-daidai-timestamp', nonce: 'x-daidai-nonce', signature: 'x-daidai-signature',
});
export const MAX_SKEW_MS = 60_000;
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}
async function hmacKey(secret: string) {
  if (typeof secret !== 'string' || secret.length < 32) throw Error('service key too short');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function canonical(method: string, path: string, timestamp: string, nonce: string, body: string, viewerToken: string) {
  return [method.toUpperCase(), path, timestamp, nonce, await sha256Hex(body), await sha256Hex(viewerToken)].join('\n');
}

export type SignedHeaders = Record<string, string>;

export async function signRequest(o: { keyId: string; secret: string; method: string; path: string; body?: string; viewerToken?: string;
  nowMs: number; nonce: string }): Promise<SignedHeaders> {
  const timestamp = String(o.nowMs);
  const message = await canonical(o.method, o.path, timestamp, o.nonce, o.body ?? '', o.viewerToken ?? '');
  const signature = hex(await crypto.subtle.sign('HMAC', await hmacKey(o.secret), enc.encode(message)));
  return { [SERVICE_HEADERS.keyId]: o.keyId, [SERVICE_HEADERS.timestamp]: timestamp, [SERVICE_HEADERS.nonce]: o.nonce, [SERVICE_HEADERS.signature]: signature };
}

/** Bounded, per-process replay window. Returns false if the nonce was already seen within the window. */
export class NonceWindow {
  #seen = new Map<string, number>();
  readonly ttlMs: number;
  readonly max: number;
  constructor(ttlMs = 2 * MAX_SKEW_MS, max = 50_000) { this.ttlMs = ttlMs; this.max = max; }
  claim(nonce: string, nowMs: number): boolean {
    for (const [n, t] of this.#seen) { if (nowMs - t > this.ttlMs || this.#seen.size > this.max) this.#seen.delete(n); else break; }
    if (this.#seen.has(nonce)) return false;
    this.#seen.set(nonce, nowMs);
    return true;
  }
}

export async function verifyRequest(o: { keys: Readonly<Record<string, string>>; headers: Headers; method: string; path: string; body: string;
  viewerToken: string; nowMs: number; nonces: NonceWindow }): Promise<boolean> {
  const keyId = o.headers.get(SERVICE_HEADERS.keyId) ?? '';
  const timestamp = o.headers.get(SERVICE_HEADERS.timestamp) ?? '';
  const nonce = o.headers.get(SERVICE_HEADERS.nonce) ?? '';
  const signature = o.headers.get(SERVICE_HEADERS.signature) ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || !Object.hasOwn(o.keys, keyId)) return false;
  if (!/^[0-9]{13}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(o.nowMs - Number(timestamp)) > MAX_SKEW_MS) return false;
  const message = await canonical(o.method, o.path, timestamp, nonce, o.body, o.viewerToken);
  const bytes = new Uint8Array(signature.match(/../g)!.map(h => parseInt(h, 16)));
  let ok: boolean;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(o.keys[keyId]), bytes, enc.encode(message)); } catch { return false; }
  // Claim the nonce only for a valid signature, so unauthenticated callers can't fill the replay window.
  return ok && o.nonces.claim(keyId + ':' + nonce, o.nowMs);
}
