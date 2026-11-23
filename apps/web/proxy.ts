/**
 * P13 release gate at the request edge (Next.js 16 `proxy`, formerly middleware).
 *
 * Private routes must answer a real 404 whenever the environment gate is closed (public release profile,
 * Production without DAIDAI_APP_ENABLED=1, Preview without DAIDAI_PREVIEW_ACCESS=1). Gating only inside the pages is
 * not enough: the (app) group has a loading boundary, so Next.js starts streaming with status 200 and renders the
 * private layout shell before a page-level notFound() runs. This proxy refuses those paths before any page, layout or
 * loading boundary executes. Pages still call requirePrivate(), so a session remains required when the gate is open.
 * /pay is intentionally public: without the local product service it renders an availability notice only.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { appEnabled } from './lib/app-gate';

const PRIVATE = [/^\/invoices(?:\/|$)/, /^\/activity(?:\/|$)/, /^\/merchant(?:\/|$)/, /^\/login(?:\/|$)/, /^\/logout(?:\/|$)/,
  /^\/api\/session(?:\/|$)/, /^\/api\/product(?:\/|$)/];

export function isPrivatePath(pathname: string): boolean {
  let path: string;
  try { path = decodeURIComponent(pathname); } catch { return true; } // malformed encoding: deny
  path = path.replace(/\/{2,}/g, '/').toLowerCase();
  return PRIVATE.some(r => r.test(path));
}

export function proxy(request: NextRequest) {
  if (!appEnabled() && isPrivatePath(request.nextUrl.pathname)) {
    return new NextResponse('Not found', { status: 404, headers: {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store, max-age=0',
      'x-robots-tag': 'noindex, nofollow, noarchive', 'x-content-type-options': 'nosniff',
    } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/invoices/:path*', '/activity/:path*', '/merchant/:path*', '/login/:path*', '/logout/:path*', '/api/session/:path*', '/api/product/:path*',
    '/invoices', '/activity', '/merchant', '/login', '/logout', '/api/session', '/api/product'],
};
