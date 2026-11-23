/**
 * Daidai read-only API Worker (P10.4). LOCAL PROTOTYPE: runs in Miniflare/workerd only, never deployed.
 * GET-only, no writes, no chain reader configured (operations stay unknown; nothing settles), no CORS.
 */
import { NonceWindow } from '../../../src/service-auth.ts';
import { d1Repositories } from './d1-repositories.ts';
import type { D1Like } from './d1-schema.ts';
import { RateLimiter, handle, parseServiceKeys } from './handler.ts';

export interface Env { DB: D1Like; DAIDAI_SERVICE_KEYS?: string; DAIDAI_AUDIENCE: string }

// Per isolate (see README): replay window and rate limiter are not shared across isolates or colos.
const nonces = new NonceWindow();
const limiter = new RateLimiter();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      repos: () => d1Repositories(env.DB),
      keys: () => parseServiceKeys(env.DAIDAI_SERVICE_KEYS),
      audience: env.DAIDAI_AUDIENCE,
      nonces, limiter, now: () => Date.now(),
      // Only route, status, key id and a short request id. Never tokens, signatures, bodies or invoice data.
      log: line => console.log(JSON.stringify(line)),
    });
  },
};
