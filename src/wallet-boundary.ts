import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RpcRequest, WalletJob } from './browser-wallet.ts';

type Pending = WalletJob & {
  delivered: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Host this handler on the same trusted local origin as the browser. No HTTP listener is started here.
export function walletBoundary(origin: string) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('loopback origin required');
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  let pending: Pending | undefined;
  let closed = false;
  const listeners = new Set<() => void>();
  const response = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

  const provider = {
    on(event: string, handler: () => void) { if (event === 'disconnect') listeners.add(handler); },
    removeListener(event: string, handler: () => void) { if (event === 'disconnect') listeners.delete(handler); },
    request(request: RpcRequest, deadline = Date.now() + 15_000): Promise<unknown> {
      if (closed || pending || Date.now() >= deadline ||
        !['eth_accounts', 'eth_chainId', 'eth_sendTransaction'].includes(request.method)) return Promise.reject(Error('wallet unavailable'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = undefined;
          reject(Error('wallet bridge expired'));
        }, Math.min(deadline - Date.now(), 60_000));
        pending = { id: randomBytes(16).toString('hex'), expires: deadline,
          request: structuredClone(request), delivered: false, resolve, reject, timer };
      });
    },
  };

  async function handle(req: Request) {
    const supplied = Buffer.from(req.headers.get('authorization') ?? '');
    if (closed || req.method !== 'POST' || new URL(req.url).origin !== origin ||
      req.headers.get('origin') !== origin || supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)) return response(null, 403);
    let body: { action?: string; id?: string; result?: unknown; error?: number };
    try { body = await req.json(); } catch { return response(null, 400); }
    if (!body || typeof body !== 'object') return response(null, 400);
    const job = pending;
    if (body.action === 'poll') {
      if (!job || job.delivered || Date.now() >= job.expires) return response(null);
      job.delivered = true;
      return response({ id: job.id, expires: job.expires, request: job.request });
    }
    if (body.action !== 'complete' || !job?.delivered || job.id !== body.id) return response(null, 409);
    clearTimeout(job.timer);
    pending = undefined;
    if (body.error !== undefined) job.reject(Object.assign(Error('browser wallet declined or disconnected'), { code: body.error }));
    else job.resolve(body.result);
    return response(null);
  }

  return { token, provider, handle, close() {
    closed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(Error('wallet session closed')); pending = undefined; }
    for (const listener of listeners) listener();
  } };
}
