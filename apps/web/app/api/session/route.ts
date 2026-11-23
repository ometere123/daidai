/** POST /api/session: exchange an invitation for a session (P10.5). Origin-checked; uniform failure; never logs input. */
import { NextResponse } from 'next/server';
import { appEnabled, privateHeaders } from '../../../lib/app-gate';
import { createSession } from '../../../lib/daidai-api';
import { sameOrigin } from '../../../lib/origin';
import { cookieAttributes, SESSION_COOKIE, sessionMaxAge } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const go = (location: string) => new NextResponse(null, { status: 303, headers: { ...privateHeaders, location } });

export async function POST(request: Request) {
  if (!appEnabled()) return new NextResponse('Not found', { status: 404, headers: privateHeaders });
  if (!sameOrigin(request)) return new NextResponse('Forbidden', { status: 403, headers: privateHeaders });
  let invitation = '';
  try {
    const form = await request.formData();
    const v = form.get('invitation');
    invitation = typeof v === 'string' ? v.trim() : '';
  } catch { /* uniform failure below */ }
  const result = await createSession(invitation);
  const maxAge = result.kind === 'session' ? sessionMaxAge(result.expiresAtMs) : null;
  if (result.kind !== 'session' || maxAge === null) return go('/login?e=1');
  const response = go('/invoices');
  response.cookies.set(SESSION_COOKIE, result.token, { ...cookieAttributes, maxAge });
  return response;
}

export function GET() {
  return new NextResponse('Method not allowed', { status: 405, headers: { ...privateHeaders, allow: 'POST' } });
}
