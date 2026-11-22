import { checkTakerChallenge, takerWalletRequest, type TakerChallenge } from './taker-schema.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { RpcRequest, WalletJob } from './browser-wallet.ts';

type Pending = WalletJob & {
  delivered: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// Host this handler on the same trusted local origin as the browser. No HTTP listener is started here.
export function walletBoundary(origin: string, pinned?: string) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('loopback origin required');
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  let pending: Pending | undefined;
  let closed = false;
  const listeners = new Set<() => void>();
  const response = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

  function queue(request: RpcRequest, deadline: number, challenge?: TakerChallenge): Promise<unknown> {
    if (closed || pending || !Number.isSafeInteger(deadline) || Date.now() >= deadline) return Promise.reject(Error('wallet unavailable'));
    const expires = Math.min(deadline, Date.now() + 60_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined;
        reject(Error('wallet bridge expired'));
      }, expires - Date.now());
      pending = { id: randomBytes(16).toString('hex'), expires,
        request: structuredClone(request), challenge, delivered: false, resolve, reject, timer };
    });
  }

  const provider = {
    on(event: string, handler: () => void) { if (event === 'disconnect') listeners.add(handler); },
    removeListener(event: string, handler: () => void) { if (event === 'disconnect') listeners.delete(handler); },
    request(request: RpcRequest, deadline = Date.now() + 15_000): Promise<unknown> {
      if (!['eth_accounts', 'eth_chainId', 'eth_sendTransaction'].includes(request.method)) return Promise.reject(Error('wallet method denied'));
      if (request.method === 'eth_sendTransaction' && pinned) {
        const tx = request.params?.[0] as { from?: string; chainId?: string; data?: string } | undefined;
        if (request.params?.length !== 1 || tx?.from !== pinned || tx.chainId !== '0xa4ec' ||
          typeof tx.data !== 'string' || !/^0x(?:[a-f0-9]{2})+$/i.test(tx.data)) return Promise.reject(Error('invalid pinned transaction'));
      }
      return queue(request, deadline);
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
      return response({ id: job.id, expires: job.expires, request: job.request, challenge: job.challenge });
    }
    if (body.action !== 'complete' || !job?.delivered || job.id !== body.id || Date.now() >= job.expires ||
      (body.error !== undefined && body.error !== 4001 && body.error !== 4900)) return response(null, 409);
    clearTimeout(job.timer);
    pending = undefined;
    if (body.error !== undefined) job.reject(Object.assign(Error('browser wallet declined or disconnected'), { code: body.error }));
    else job.resolve(body.result);
    return response(null);
  }

  return { token, provider, handle,
    signTaker(challenge: TakerChallenge, expires: number) {
      if (!pinned) throw Error('Textile signing requires a pinned sender');
      checkTakerChallenge(challenge, pinned, Date.now());
      return queue(takerWalletRequest(challenge), expires, Object.freeze({ ...challenge }));
    },
    close() {
    closed = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(Error('wallet session closed')); pending = undefined; }
    for (const listener of listeners) listener();
  } };
}
