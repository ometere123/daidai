import { cookies } from 'next/headers';
import { cngn, usdt } from '../../../../../src/invoice-core';
import { preparePreview } from '../../../../../src/product-quote';
import { textilePreviewSource } from '../../../../../src/textile-preview-source';
import { requirePrivate } from '../../../lib/private';
import { localProduct, productCookie } from '../../../lib/product';
import { productCall } from '../../../lib/daidai-api';
import { amount, Terms } from '../product-ui';
import { ShareFragment } from '../share-fragment';
import WalletReadiness from './wallet-readiness';

export const dynamic = 'force-dynamic';
export default async function PayerReview({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!localProduct()) return <><h1 className="title">Payer review</h1><p>The authenticated invoice service is unavailable in this environment.</p><a href="/demo">Try the isolated demo</a></>;
  const { token } = await requirePrivate();
  const { result } = await searchParams;
  const code = (await cookies()).get(productCookie)?.value;
  const reply = code ? await productCall({ kind: 'redeem', code }, token) : null;
  const invoice = reply?.kind === 'revision' ? reply.revisions[0] : undefined;
  const quote = invoice && process.env.DAIDAI_LOCAL_TEXTILE_PREVIEW !== '0' ? await preparePreview(invoice, textilePreviewSource(), Date.now) : null;
  return <>
    <h1 className="title">Payer review</h1>
    <section className="panel product-panel"><h2>Open a payment link</h2><ShareFragment />
      {(result || code && !invoice) && <p role="alert">These payment instructions are unavailable. Ask the merchant for an active link.</p>}
    </section>
    {invoice && <>
      <section className="panel product-panel"><h2>Committed invoice</h2><Terms revision={invoice} />
        <p className="meta" style={{ overflowWrap: 'anywhere' }}>Celo Mainnet (42220) · USDt {usdt} · cNGN {cngn}</p>
      </section>
      <section className="panel product-panel"><h2>Textile indicative quote</h2>
        <p>Source: Textile FX preview. No liquidity reservation or executable order.</p>
        {quote?.kind === 'indicative' ? <dl>
          <dt>Conversion before fee</dt><dd>{amount(quote.base)} USDt</dd>
          <dt>Protocol fee</dt><dd>{amount(quote.fee)} USDt</dd>
          <dt>All-in debit</dt><dd>{amount(quote.debit)} USDt</dd>
          <dt>Review window (UTC)</dt><dd>{new Date(quote.reviewUntil).toISOString()}</dd>
        </dl> : <p role="status">{quote?.kind === 'over-cap' ? 'Blocked: estimated debit exceeds the invoice cap.' : 'Quote unavailable'}</p>}
      </section>
      <section className="panel product-panel"><h2>Authorization and wallet readiness</h2>
        <p>Verified invoice approval and recipient consent are outstanding.</p><WalletReadiness />
      </section>
      <section className="panel product-panel"><h2>Settlement review</h2>
        <p>Conversion: no finalized evidence.</p><p>Recipient payout: no finalized evidence.</p><strong>Not settled</strong>
        <p>An unknown payout must be reconciled before a new attempt can be considered.</p>
      </section>
    </>}
  </>;
}
