import { connection } from 'next/server';
import { appEnabled } from '../lib/app-gate';
import { readFixtureWorkspace } from './invoice-workspace';
import { SiteNav } from './site-nav';
import { PlumbBob, TokenAmount } from './ui';

/**
 * Landing. Dynamic, because which doors exist depends on the release profile read at request time. Every link offered
 * here must resolve in the profile that rendered it (enforced by the link crawl in scripts/p13-product-smoke.mjs).
 * The slab below is a labelled sample taken from the synthetic demo workspace, never a live invoice.
 */
export default async function Landing() {
  await connection();
  const open = appEnabled();
  const sample = readFixtureWorkspace(Date.now()).invoices.find(i => i.id === 'INV-0042')!;
  return <><SiteNav /><main id="main" className="product-shell">
    <section className="product-hero"><div>
      <h1>Invoice in cNGN.<br />Fund it in USDt.</h1>
      <p className="product-lede">Two currencies. One agreement. Verified settlement.</p>
      <p>Set the exact amount your recipient should receive and a maximum all-in USDt debit. Daidai checks both before conversion and verifies the separate recipient payout.</p>
      <div className="product-actions">
        {open ? <><a className="btn primary" href="/invoices/new">Create an invoice</a><a className="btn secondary" href="/demo">Open the demo workspace</a></>
          : <><a className="btn primary" href="/demo">Open the demo workspace</a><a className="btn secondary" href="/proof">See the public proof</a></>}
      </div>
      {!open && <p className="product-note">Live invoicing is invite-only and closed on this site. The demo uses synthetic data and moves no money.</p>}
    </div>
    <section className="slab sample-slab" aria-label="Sample invoice from the demo workspace">
      <PlumbBob size={22} onInk className="slab-mark" />
      <div className="slab-body">
        <p className="sample-tag">Sample from the demo workspace · synthetic data</p>
        <p className="slab-sentence">{sample.recipient} receives exactly <span className="nowrap"><TokenAmount value={sample.target} unit="cNGN" className="display-amount" /></span></p>
        <p className="slab-peg">The payer’s ceiling is <TokenAmount value={sample.cap} unit="USDt" /> all-in, fee included. The recipient’s amount never changes.</p>
      </div>
    </section></section>
    <ol className="product-flow" aria-label="How a payment settles">
      <li><h2>Agree</h2><p>Supplier and payer each sign the exact cNGN amount and the USDt ceiling.</p></li>
      <li><h2>Convert</h2><p>One firm quote, one owner-approved swap, checked against the signed terms.</p></li>
      <li><h2>Pay</h2><p>A separate, exact cNGN transfer to the supplier’s wallet.</p></li>
      <li><h2>Verify</h2><p>Independent readers confirm both transactions. A restart resumes at the payout and never repeats the conversion.</p></li>
    </ol>
    <p className="product-note">Registered on Celo as ERC-8004 Agent #10103. Live settlement is not yet authorised; the <a href="/proof">proof page</a> states exactly what has and has not been verified.</p>
  </main></>;
}
