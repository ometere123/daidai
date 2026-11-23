import { productCookie } from '../../../../lib/product';
/** POST /api/session/logout: revoke at the Worker and clear the cookie. Origin-checked. GET never logs out. */
import { NextResponse, type NextRequest } from 'next/server';
import { appEnabled, privateHeaders } from '../../../../lib/app-gate';
import { revokeSession } from '../../../../lib/daidai-api';
import { sameOrigin } from '../../../../lib/origin';
import { cookieAttributes, SESSION_COOKIE } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;

export async function POST(request: NextRequest) {
  if (!appEnabled()) return new NextResponse('Not found', { status: 404, headers: privateHeaders });
  if (!sameOrigin(request)) return new NextResponse('Forbidden', { status: 403, headers: privateHeaders });
  const token = request.cookies.get(SESSION_COOKIE)?.value ?? '';
  if (tokenPattern.test(token) && !(await revokeSession(token))) {
    return new NextResponse('Sign-out unavailable. Try again.', { status: 503, headers: privateHeaders });
  }
  const response = new NextResponse(null, { status: 303, headers: { ...privateHeaders, location: '/login' } });
  response.cookies.set(SESSION_COOKIE, '', { ...cookieAttributes, maxAge: 0 });
  response.cookies.set(productCookie, '', { ...cookieAttributes, maxAge: 0 });
  return response;
}

export function GET() {
  return new NextResponse('Method not allowed', { status: 405, headers: { ...privateHeaders, allow: 'POST' } });
}
