/**
 * Gate for the internal authoritative demonstration (P10.4). Read at request time from server env only.
 *
 * Enabled only when DAIDAI_INTERNAL_DEMO=1, VERCEL_ENV is not 'production', and NODE_ENV is not 'production'.
 * DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD=1 lifts only the NODE_ENV check, for local `next start` testing.
 * NEVER set DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD on Vercel. VERCEL_ENV=production always disables the demo.
 */
if (typeof window !== 'undefined') throw new Error('internal-demo is server-only');

export function internalDemoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAIDAI_INTERNAL_DEMO !== '1') return false;
  if (env.VERCEL_ENV === 'production') return false;
  if (env.NODE_ENV === 'production' && env.DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD !== '1') return false;
  return true;
}

/** The demo viewer session token, issued server-side out of band. */
export function demoViewerToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.DAIDAI_DEMO_VIEWER_TOKEN ?? '';
  return token ? token : null;
}
