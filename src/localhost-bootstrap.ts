import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function oneUseBootstrap(expires: number, clock = Date.now) {
  if (!Number.isFinite(expires)) throw Error('Invalid localhost session expiry.');
  const ticket = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + ticket);
  let used = false;
  return {
    ticket,
    get used() { return used; },
    consumeRequest(req: IncomingMessage, origin: string) {
      if (!origin || req.headers.host !== new URL(origin).host || req.headers.origin !== origin) {
        return { status: 403, code: 'BOOTSTRAP_CONTEXT_MISMATCH' };
      }
      if (req.method !== 'POST') return { status: 405, code: 'STARTUP_EXCEPTION' };
      const authorization = req.headers.authorization;
      if (!authorization || authorization === 'Bearer') return { status: 403, code: 'BOOTSTRAP_MISSING' };
      if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) return { status: 403, code: 'BOOTSTRAP_MALFORMED' };
      if (!timingSafeEqual(expected, Buffer.from(authorization))) return { status: 403, code: 'BOOTSTRAP_INCORRECT' };
      if (used) return { status: 403, code: 'BOOTSTRAP_CONSUMED' };
      if (clock() >= expires) return { status: 410, code: 'BOOTSTRAP_EXPIRED' };
      used = true;
      return { status: 200 };
    },
  };
}
