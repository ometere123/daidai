import { SiteNav } from './site-nav';

export default function Landing() {
  return <><SiteNav /><main id="main" className="product-shell">
    <section className="product-hero"><div><p className="product-kicker">Celo Mainnet · USDt → cNGN</p>
      <h1>Invoice in cNGN.<br />Fund it in USDt.</h1>
      <p>Set the exact amount your recipient should receive and a maximum all-in USDt debit. Daidai checks both before conversion and verifies the separate recipient payout.</p>
      <div className="product-actions"><a className="btn primary" href="/invoices/new">Create an invoice</a><a className="btn secondary" href="/pay">Review a payment</a></div>
    </div><aside className="product-card"><p className="product-kicker">Verifiable on Celo</p><h2>Agent #10103</h2><p>Inspect the finalized registration and the rules that govern invoice review.</p><a href="/proof">View registration proof ↗</a></aside></section>
    <div className="product-points"><section><h2>Exact recipient amount</h2><p>Commit the cNGN amount before reviewing a quote.</p></section><section><h2>All-in USDt cap</h2><p>The fee is included in the payer’s maximum debit.</p></section><section><h2>Two finalized steps</h2><p>Conversion and payout have independent evidence.</p></section></div>
    <a href="/demo">Try the isolated demo ↗</a>
  </main></>;
}
