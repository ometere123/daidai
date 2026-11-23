import { notFound } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import { localProduct } from '../../../lib/product';
import { productCall } from '../../../lib/daidai-api';
import { requirePrivate } from '../../../lib/private';
import { DraftForm, ProductError, amount } from '../product-ui';

export const dynamic = 'force-dynamic';
export default async function Merchant({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!localProduct()) notFound();
  const { token } = await requirePrivate();
  const list = await productCall({ kind: 'list' }, token);
  const { result } = await searchParams;
  return <>
    <h1 className="title">Merchant workspace</h1>
    <p className="meta">Isolated local workspace · payment execution disabled</p>
    <ProductError result={result} />
    {!list || list.kind !== 'list' ? <p role="status">The invoice service is unavailable.</p> :
      !list.merchant ? <p role="status">This session does not have merchant permissions.</p> : <>
        <section className="panel product-panel"><h2>New invoice</h2><DraftForm id={randomBytes(16).toString('hex')} /></section>
        <section className="panel product-panel"><h2>Your invoices</h2>
          {list.revisions.length ? <ul>{list.revisions.map(r => <li key={r.id}>
            <a href={'/merchant/' + r.id}>{amount(r.target)} cNGN · {r.expiry <= Date.now() && r.state !== 'cancelled' ? 'expired' : r.state} · revision {r.revision}</a>
          </li>)}</ul> : <p>No invoices yet.</p>}
        </section>
      </>}
  </>;
}
