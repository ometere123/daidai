/**
 * Daidai read-only API Worker (P10.4). LOCAL PROTOTYPE: runs in Miniflare/workerd only, never deployed.
 * Writes only authentication state (invitations, sessions, service nonces); never financial tables. No chain reader unless
 * DAIDAI_CHAIN_RPC_URL is set (operations stay unknown; nothing settles). No CORS.
 */
import { errorBody, responseHeaders } from '../../../src/api-contract.ts';
import { takeLaunchRate } from './launch-rate.ts';
import { NonceWindow } from '../../../src/service-auth.ts';
import { d1Repositories } from './d1-repositories.ts';
import { chainFromEnv } from './chain-config.ts';
import type { D1Like } from './d1-schema.ts';
import { RateLimiter, handle, parseServiceKeys } from './handler.ts';

export interface Env {
  DAIDAI_LAUNCH_MODE?: string; DAIDAI_DISTRIBUTED_RATE?: string;
  DB: D1Like; DAIDAI_SERVICE_KEYS?: string; DAIDAI_AUDIENCE: string;
  /** Optional, unset by default. https only (http://127.0.0.1 for local tests). */
  DAIDAI_LOCAL_PRODUCT?: string; DAIDAI_CHAIN_RPC_URL?: string; DAIDAI_ATTRIBUTION_CODE?: string;
}

// Per isolate (see README): fast-path replay window and rate limiter. The authoritative replay store is D1 service_nonces.
const nonces = new NonceWindow();
const limiter = new RateLimiter();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.DAIDAI_LAUNCH_MODE !== 'isolated-local') {
      return new Response(JSON.stringify(errorBody('unavailable')), { status: 503, headers: responseHeaders });
    }
    return handle(request, {
      distributedRate: env.DAIDAI_DISTRIBUTED_RATE === '1' ? (scope, now) => takeLaunchRate(env.DB, scope, now) : undefined,
      repos: () => d1Repositories(env.DB),
      db: () => env.DB,
      localProduct: env.DAIDAI_LOCAL_PRODUCT === 'isolated-miniflare',
      chain: () => chainFromEnv(env),
      keys: () => parseServiceKeys(env.DAIDAI_SERVICE_KEYS),
      audience: env.DAIDAI_AUDIENCE,
      nonces, limiter, now: () => Date.now(),
      // Only route, status, key id and a short request id. Never tokens, signatures, bodies or invoice data.
      log: line => console.log(JSON.stringify(line)),
    });
  },
};
