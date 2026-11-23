import { connection } from 'next/server';
import { registration } from '../../../../src/public-registration';
import { publicObservation } from '../../lib/public-observation';
import { SiteNav } from '../site-nav';

export default async function Proof() {
  await connection();
  const report = await publicObservation();
  const fresh = Date.now() - report.observedAt <= 120_000;
  return <><SiteNav /><main className="product-shell"><h1 className="title">Public verification</h1>
    <p>Registration evidence is public. Invoice, conversion and payout records are private unless separately published.</p>
    <section className="panel product-evidence"><h2>ERC-8004 registration · Agent #{registration.agent}</h2>
      <p>{fresh ? report.status : 'unresolved · observation stale'}</p>
      <p>Celo Mainnet · chain {registration.chain}</p>
      <p>Wallet <code>{registration.wallet}</code></p><p>Registry <code>{registration.registry}</code></p>
      <a href={'https://celoscan.io/tx/' + registration.hash}><code>{registration.hash}</code> ↗</a>
      <p><time dateTime={new Date(report.observedAt).toISOString()}>{new Date(report.observedAt).toISOString()}</time></p>
      {report.providers.map(p => <div key={p.name}><strong>{p.name}</strong><p>{p.kind}</p>
        {p.kind === 'finalized registration' && <p>Successful receipt · ERC-721 mint to the registered wallet · block {p.height} · finalized head {p.head}<br /><code>{p.blockHash}</code></p>}</div>)}
    </section>
    <section className="panel"><h2>Settlement evidence</h2><p>No verified USDt conversion or cNGN payout has been published.</p></section>
  </main></>;
}
