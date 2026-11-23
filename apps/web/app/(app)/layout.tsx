import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Wordmark } from '../ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

/** Authenticated read-only shell. Every page below calls requirePrivate(); this layout renders no private data. */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <div className="column" data-source="authoritative" data-execution="disabled">
    <header className="topbar" style={{ display: 'flex' }}>
      <a className="top-brand" href="/invoices"><Wordmark /></a>
      <span className="top-right">
        <span className="meta" role="note" aria-label="Data source">Authoritative · read-only</span>
        <form method="post" action="/api/session/logout">
          <button type="submit" className="btn secondary compact">Sign out</button>
        </form>
      </span>
    </header>
    <main id="main" className="route" style={{ padding: '16px', display: 'grid', gap: '16px', maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      {children}
    </main>
  </div>;
}
