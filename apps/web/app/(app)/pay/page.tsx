import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { cngn, usdt } from '../../../../../src/invoice-core';
import { preparePreview, simulatedTextilePreview } from '../../../../../src/product-quote';
import { requirePrivate } from '../../../lib/private';
import { localProduct, productCookie } from '../../../lib/product';
import { productCall } from '../../../lib/daidai-api';
import { amount, Terms } from '../product-ui';
import { ShareFragment } from '../share-fragment';

export const dynamic = 'force-dynamic';
export default async function PayerReview({ searchParams }: { searchParams: Promise<{ result?: string; scenario?: string }> }) {
  if (!localProduct()) notFound();
  const { token } = await requirePrivate();
  const { result, scenario } = await searchParams;
  const code = (await cookies()).get(productCookie)?.value;
  const reply = code ? await productCall({ kind: 'redeem', code }, token) : null;
  const invoice = reply?.kind === 'revision' ? reply.revisions[0] : undefined;
  const quote = invoice ? await preparePreview(invoice, simulatedTextilePreview, Date.now) : null;
  return <>
    <h1 className="title">Payer review</h1>
    <p className="meta">Isolated local workspace · no funds move</p>
    <section className="panel"><h2>Open a payment link</h2><ShareFragment />
      {(result || code && !invoice) && <p role="alert">These payment instructions are unavailable. Ask the merchant for an active link.</p>}
    </section>
    {invoice && <>
      <section className="panel"><h2>Committed invoice</h2><Terms revision={invoice} />
        <p className="meta" style={{ overflowWrap: 'anywhere' }}>Celo Mainnet (42220) · USDt {usdt} · cNGN {cngn}</p>
      </section>
      <section className="panel"><h2>Simulated Textile preview</h2>
        <p>Indicative demo data. No liquidity was reserved and no firm quote exists.</p>
        {quote?.kind === 'indicative' ? <dl>
          <dt>Conversion amount before fee</dt><dd>{amount(quote.base)} USDt</dd>
          <dt>Protocol fee</dt><dd>{amount(quote.fee)} USDt</dd>
          <dt>All-in debit</dt><dd>{amount(quote.debit)} USDt</dd>
          <dt>Local review expires (UTC)</dt><dd>{new Date(quote.reviewUntil).toISOString()}</dd>
        </dl> : <p role="status">{quote?.kind === 'over-cap' ? 'Blocked: estimated debit exceeds the invoice cap.' : 'Preview unavailable or expired.'}</p>}
      </section>
      <section className="panel"><h2>Authorization and wallet readiness</h2>
        <ul><li>Invoice approval: missing verified authorization</li><li>Recipient consent: missing verified authorization</li>
          <li>Wallet, allowance and gas: unchecked. Wallet interaction is disabled.</li></ul>
      </section>
      <section className="panel"><h2>Settlement review</h2>
        <ol><li>Conversion: USDt to exact cNGN in the Daidai taker wallet.</li>
          <li>Payout: a separate exact cNGN transfer to the committed recipient.</li></ol>
        <p>No finalized conversion or payout evidence is attached to this invoice.</p>
        <a href="/pay?scenario=unknown">View a simulated unknown payout</a>
        {scenario === 'unknown' && <div role="status"><strong>Simulation · Needs reconciliation</strong>
          <p>The simulated payout outcome is unknown. A new attempt stays blocked until authoritative reconciliation, fresh preflight and explicit approval.</p></div>}
      </section>
    </>}
  </>;
}
