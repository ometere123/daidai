/**
 * Read-only Celo JSON-RPC transport (P10.5). Worker-safe (fetch only).
 *
 * The returned Rpc is wrapped in readOnlyRpc (chain-evidence.ts), so only eth_chainId, eth_getTransactionByHash,
 * eth_getTransactionReceipt and eth_getBlockByNumber can ever be sent. There is no way to broadcast, sign or call.
 * Hardening: https only (http allowed for loopback test servers), no redirects, no credentials in the URL, per-call
 * timeout, response-size cap, strict JSON-RPC 2.0 envelope with id matching, no batching. Errors never include the
 * endpoint URL (which may embed a provider key), response bodies or headers.
 *
 * The adapters in chain-evidence.ts re-check eth_chainId on every observation and verify transaction identity,
 * envelope, attribution, logs, exact output, debit cap, canonical block hash and finality. A production endpoint
 * (and any provider key, which must be a Worker secret) needs owner approval; CI never uses a live endpoint.
 */
import { readOnlyRpc, type Rpc } from './chain-evidence.ts';

export type CeloRpcOptions = Readonly<{ url: string; fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number }>;

export class CeloRpcError extends Error {
  readonly code: 'timeout' | 'http' | 'too-large' | 'malformed' | 'rpc-error' | 'config';
  constructor(code: CeloRpcError['code'], message: string) { super(message); this.name = 'CeloRpcError'; this.code = code; }
}

function validateUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CeloRpcError('config', 'invalid chain RPC URL'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.username || url.password || url.hash) throw new CeloRpcError('config', 'chain RPC URL must not contain credentials or fragments');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new CeloRpcError('config', 'chain RPC URL must be https');
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new CeloRpcError('too-large', 'chain RPC response too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw new CeloRpcError('too-large', 'chain RPC response too large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

export function createCeloRpc(options: CeloRpcOptions): Rpc {
  const url = validateUrl(options.url).toString();
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxBytes ?? 2_000_000;
  if (!(timeoutMs > 0 && timeoutMs <= 30_000) || !(maxBytes > 0 && maxBytes <= 10_000_000)) throw new CeloRpcError('config', 'invalid chain RPC limits');
  let counter = 0;
  const transport: Rpc = async (method, params) => {
    const id = ++counter;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new CeloRpcError((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timeout' : 'http', 'chain RPC request failed');
    }
    if (res.status !== 200) throw new CeloRpcError('http', 'chain RPC HTTP ' + res.status);
    let text: string;
    try { text = await readCapped(res, maxBytes); }
    catch (e) { if (e instanceof CeloRpcError) throw e; throw new CeloRpcError((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'malformed', 'chain RPC body unreadable'); }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new CeloRpcError('malformed', 'chain RPC body is not JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CeloRpcError('malformed', 'chain RPC envelope');
    const env = body as Record<string, unknown>;
    if (env.jsonrpc !== '2.0' || env.id !== id) throw new CeloRpcError('malformed', 'chain RPC envelope');
    if (Object.hasOwn(env, 'error')) throw new CeloRpcError('rpc-error', 'chain RPC returned an error');
    if (!Object.hasOwn(env, 'result')) throw new CeloRpcError('malformed', 'chain RPC envelope');
    return env.result;
  };
  return readOnlyRpc(transport);
}
