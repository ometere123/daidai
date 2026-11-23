/**
 * CSRF defence for state-changing route handlers (login, logout): the Origin header must equal this deployment's
 * origin (scheme + Host). A missing or "null" Origin is rejected. SameSite=Strict on the session cookie is the second layer.
 */
if (typeof window !== 'undefined') throw new Error('origin is server-only');

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host || origin === 'null') return false;
  const forwarded = (request.headers.get('x-forwarded-proto') ?? '').split(',')[0].trim();
  const scheme = forwarded === 'https' || forwarded === 'http' ? forwarded + ':' : new URL(request.url).protocol;
  return origin === scheme + '//' + host;
}
