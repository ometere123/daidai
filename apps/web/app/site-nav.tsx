import { cookies } from 'next/headers';
import { appEnabled } from '../lib/app-gate';
import { SESSION_COOKIE } from '../lib/session';
import { BrandWordmark } from './brand';

/**
 * Gate-aware navigation. A route that answers 404 in this profile is never offered: in the public release only the
 * reviewer-facing pages appear. Pages that render this must be dynamic, because the gate is read at request time.
 */
export async function SiteNav() {
  const open = appEnabled();
  const signedIn = open && (await cookies()).has(SESSION_COOKIE);
  return <header className="product-nav"><a className="product-mark" href="/" aria-label="Daidai home"><BrandWordmark /></a>
    <nav aria-label="Main navigation">
      {open && <a href="/invoices">Invoices</a>}{open && <a href="/pay">Pay</a>}{open && <a href="/activity">Activity</a>}
      <a href="/agent">Agent</a><a href="/proof">Proof</a><a href="/demo">Demo</a>
    </nav>
    {open && !signedIn && <a className="product-sign-in" href="/login">Sign in</a>}
  </header>;
}
