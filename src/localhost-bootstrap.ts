import { randomBytes, timingSafeEqual } from 'node:crypto';

export function oneUseBootstrap(expires: number, clock = Date.now) {
  if (!Number.isFinite(expires)) throw Error('Invalid localhost session expiry.');
  const ticket = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + ticket);
  let used = false;
  return {
    ticket,
    get used() { return used; },
    consume(authorization: string | undefined) {
      const supplied = Buffer.from(authorization ?? '');
      if (used || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return 403;
      if (clock() >= expires) return 410;
      used = true;
      return 200;
    },
  };
}
