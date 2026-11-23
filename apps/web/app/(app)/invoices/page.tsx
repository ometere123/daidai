import { localProduct } from '../../../lib/product';
import type { Metadata } from 'next';
import { TokenAmount } from '../../ui';
import { requirePrivate } from '../../../lib/private';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: 'Invoices · Daidai', robots: { index: false, follow: false, nocache: true } };

export default async function InvoicesPage() {
  const { invoices } = await requirePrivate();
  return <>
    <div className="panel" role="region" aria-label="Authoritative notice">
      <strong>Authoritative · read-only</strong>
      <p className="meta">Server-rendered from the Daidai API. No wallet, signing or payment actions exist here.</p>
    </div>
    <h1 className="title">Invoices</h1>
    {localProduct() && <nav aria-label="Customer workspace"><a href="/merchant">Merchant workspace</a>{' · '}<a href="/pay">Payer review</a></nav>}
    {invoices === null ? <div className="panel" role="status">Invoices are not available right now.</div>
      : invoices.length === 0 ? <div className="panel" role="status" data-result="empty">No invoices are shared with you yet.</div>
      : <ul className="panel" aria-label="Invoices" style={{ listStyle: 'none', margin: 0 }}>
        {invoices.map(i => <li key={i.id} data-invoice={i.id}>
          <a href={'/invoices/' + encodeURIComponent(i.id)} style={{ display: 'grid', gap: 4, padding: '8px 0' }}>
            <strong className="mono">{i.id}</strong>
            <span className="meta">Revision {i.revision} · Target <TokenAmount value={BigInt(i.targetAtomic)} unit="cNGN" tabular /> · Max debit{' '}
              <TokenAmount value={BigInt(i.maxDebitAtomic)} unit="USDt" tabular /></span>
          </a>
        </li>)}
      </ul>}
  </>;
}
