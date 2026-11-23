/**
 * Environment gate for private (authenticated) routes, P10.5 decision 2. Read at request time from server env only.
 * The gate alone never exposes data: every private page additionally needs a Worker-validated session.
 *   VERCEL_ENV=production → DAIDAI_APP_ENABLED must be exactly "1"
 *   VERCEL_ENV=preview    → DAIDAI_PREVIEW_ACCESS must be exactly "1"
 *   any other VERCEL_ENV (e.g. development) or unset → DAIDAI_APP_ENABLED="1" or NODE_ENV=development
 */
if (typeof window !== 'undefined') throw new Error('app-gate is server-only');

export function appEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAIDAI_PUBLIC_RELEASE === '1') return false;
  const vercel = String(env.VERCEL_ENV ?? '').trim().toLowerCase();
  if (vercel === 'production') return env.DAIDAI_APP_ENABLED === '1';
  if (vercel === 'preview') return env.DAIDAI_PREVIEW_ACCESS === '1';
  return env.DAIDAI_APP_ENABLED === '1' || env.NODE_ENV === 'development';
}

/** Headers for every private route-handler response: never indexed, never cached. */
export const privateHeaders: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store, private, max-age=0',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'referrer-policy': 'no-referrer',
});
