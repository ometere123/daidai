import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { appEnabled } from '../../lib/app-gate';
import { Wordmark } from '../ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: 'Sign in · Daidai', robots: { index: false, follow: false, nocache: true } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  if (!appEnabled()) notFound();
  const failed = (await searchParams).e === '1';
  return <main id="main" style={{ maxWidth: 440, margin: '10vh auto', padding: 16, display: 'grid', gap: 16 }}>
    <Wordmark />
    <form className="panel" method="post" action="/api/session" autoComplete="off">
      <h1 className="title">Sign in</h1>
      <p className="meta">Enter the invitation code you were given. Each code works once.</p>
      <label htmlFor="invitation">Invitation code</label>
      <input id="invitation" name="invitation" type="password" autoComplete="off" required minLength={32} maxLength={128}
        spellCheck={false} autoCapitalize="off" style={{ minHeight: 44, padding: '0 12px', border: '1px solid var(--color-rule)', borderRadius: 8 }} />
      {failed ? <p role="alert" data-result="invalid">That invitation is not valid.</p> : null}
      <button type="submit" className="btn primary block">Sign in</button>
    </form>
  </main>;
}
