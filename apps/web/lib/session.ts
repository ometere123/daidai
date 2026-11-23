/**
 * Server-only session cookie handling (P10.5 decision 1). The opaque Worker-issued token lives only in an
 * HttpOnly, Secure, SameSite=Strict, host-only `__Host-` cookie. It is never passed to client components, never
 * rendered, and never logged. Local testing: Chromium treats http://localhost and http://127.0.0.1 as potentially
 * trustworthy and accepts Secure / __Host- cookies there (verified in test/p105-auth-flow.test.mjs); the attributes
 * are never downgraded for http.
 */
import { cookies } from 'next/headers';

if (typeof window !== 'undefined') throw new Error('session is server-only');

export const SESSION_COOKIE = '__Host-daidai_session';
export const MAX_SESSION_SECONDS = 12 * 60 * 60;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

/** Max-Age in seconds: min(absolute expiry, 12 h). Null if already expired or nonsensical. */
export function sessionMaxAge(expiresAtMs: number, nowMs = Date.now()): number | null {
  if (!Number.isSafeInteger(expiresAtMs)) return null;
  const s = Math.min(Math.floor((expiresAtMs - nowMs) / 1000), MAX_SESSION_SECONDS);
  return s > 0 ? s : null;
}

export const cookieAttributes = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' } as const;

export async function readSessionToken(): Promise<string | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value ?? '';
  return tokenPattern.test(value) ? value : null;
}

/** Route handlers / server actions only. */
export async function setSessionCookie(token: string, maxAge: number): Promise<void> {
  if (!tokenPattern.test(token) || !(maxAge > 0)) throw new Error('refusing to set an invalid session cookie');
  (await cookies()).set(SESSION_COOKIE, token, { ...cookieAttributes, maxAge });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, '', { ...cookieAttributes, maxAge: 0 });
}
