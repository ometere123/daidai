import { NextResponse, type NextRequest } from 'next/server';
import { privateHeaders } from '../../../lib/app-gate';
import { deriveProductShare, productCall } from '../../../lib/daidai-api';
import { sameOrigin } from '../../../lib/origin';
import { localProduct, productCookie } from '../../../lib/product';
import { cookieAttributes, readSessionToken } from '../../../lib/session';

export const dynamic = 'force-dynamic';
const go = (location: string) => new NextResponse(null, { status: 303, headers: { ...privateHeaders, location } });
const reject = (status: number) => new NextResponse('Request unavailable', { status, headers: privateHeaders });

function units(value: string): string {
  if (!/^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/.test(value)) return '';
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}

export async function POST(request: NextRequest) {
  if (!localProduct()) return reject(404);
  if (!sameOrigin(request)) return reject(403);
  const session = await readSessionToken();
  if (!session) return go('/login');
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return reject(400);
  const reader = request.body?.getReader();
  if (!reader) return reject(400);
  let size = 0, raw = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return reject(400); }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } catch { return reject(400); }
  const form = new URLSearchParams(raw);
  const kind = form.get('kind'), id = form.get('id') ?? '', key = form.get('key');
  if (kind === 'redeem') {
    const code = form.get('code');
    const result = await productCall({ kind, code }, session);
    const response = go(result?.kind === 'revision' ? '/pay' : '/pay?result=unavailable');
    response.cookies.set(productCookie, result?.kind === 'revision' ? code! : '', { ...cookieAttributes, maxAge: result?.kind === 'revision' ? 86400 : 0 });
    return response;
  }
  if (kind !== 'save' && kind !== 'commit' && kind !== 'cancel' && kind !== 'share' && kind !== 'revoke') return reject(400);
  if (!/^[0-9a-f]{32}$/.test(id)) return reject(400);
  const expected = Number(form.get('expected'));
  const code = kind === 'share' && key ? deriveProductShare(id, key, session) : null;
  if (kind === 'share' && !code) return reject(400);
  const draft = kind === 'save' ? {
    target: units(form.get('target') ?? ''), cap: units(form.get('cap') ?? ''), recipient: form.get('recipient'),
    approver: form.get('approver'), expiry: Number(form.get('expiry')),
  } : undefined;
  const result = await productCall({ kind, id, key, expected, draft, code }, session);
  if (result?.kind === 'denied') return reject(404);
  if (result?.kind === 'shared') return go('/merchant/' + id + '#' + code);
  if (result?.kind === 'revision' || result?.kind === 'revoked') return go('/merchant/' + id);
  return go((expected === 0 && kind === 'save' ? '/merchant' : '/merchant/' + id) + '?result=' + (result?.kind ?? 'unavailable'));
}
