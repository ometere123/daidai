import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { appEnabled } from '../../lib/app-gate';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: 'Sign out · Daidai', robots: { index: false, follow: false, nocache: true } };

/** GET never signs out (CSRF-safe); it only offers the POST button. */
export default async function LogoutPage() {
  await connection();
  if (!appEnabled()) notFound();
  return <main id="main" style={{ maxWidth: 440, margin: '10vh auto', padding: 16 }}>
    <form className="panel" method="post" action="/api/session/logout">
      <h1 className="title">Sign out</h1>
      <button type="submit" className="btn primary block">Sign out</button>
    </form>
  </main>;
}
