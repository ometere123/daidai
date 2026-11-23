/**
 * GET /api/session/expired: private pages redirect here when the Worker rejects the session. The cookie is cleared
 * only after the Worker confirms the session is invalid, so a cross-site GET cannot sign out a valid session.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { appEnabled, privateHeaders } from '../../../../lib/app-gate';
import { listInvoices } from '../../../../lib/daidai-api';
import { cookieAttributes, SESSION_COOKIE } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!appEnabled()) return new NextResponse('Not found', { status: 404, headers: privateHeaders });
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const response = new NextResponse(null, { status: 303, headers: { ...privateHeaders, location: '/login' } });
  if (token !== undefined && (await listInvoices(token)).kind === 'not-found-or-forbidden') {
    response.cookies.set(SESSION_COOKIE, '', { ...cookieAttributes, maxAge: 0 });
  }
  return response;
}
