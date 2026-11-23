import { notFound } from 'next/navigation';
import { requirePrivate } from '../../../../lib/private';
import { localProduct } from '../../../../lib/product';
import { productCall } from '../../../../lib/daidai-api';
import { DraftForm, MutationButton, ProductError, Terms } from '../../product-ui';
import { ShareFragment } from '../../share-fragment';

export const dynamic = 'force-dynamic';
export default async function MerchantInvoice({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  if (!localProduct()) notFound();
  const { token } = await requirePrivate();
  const { id } = await params;
  const history = await productCall({ kind: 'detail', id }, token);
  if (history?.kind === 'denied') notFound();
  const revision = history?.kind === 'history' ? history.revisions[0] : undefined;
  if (!revision) return <p role="status">The invoice could not be loaded.</p>;
  const expired = revision.expiry <= Date.now();
  const { result } = await searchParams;
  return <>
    <a href="/invoices">Merchant workspace</a>
    <h1 className="title">Invoice terms</h1>
    <ProductError result={result} />
    <section className="panel product-panel"><h2>{revision.state === 'cancelled' ? 'Cancelled' : expired ? 'Expired' : revision.state === 'draft' ? 'Draft' : 'Committed · awaiting approvals'}</h2>
      <Terms revision={revision} />
    </section>
    {revision.state === 'draft' && <section className="panel product-panel"><h2>Edit draft</h2><DraftForm id={id} revision={revision} />
      {!expired && <MutationButton revision={revision} kind="commit" label="Commit invoice terms" />}
    </section>}
    {revision.state === 'committed' && !expired && <section className="panel product-panel">
      <h2>Payment instructions</h2><p>Share with an authenticated payer. Links expire within 24 hours and grant invoice review only.</p>
      <ShareFragment merchant />
      <MutationButton revision={revision} kind="share" label="Generate payment link" />
      <MutationButton revision={revision} kind="revoke" label="Revoke payment links" />
    </section>}
    {revision.state !== 'cancelled' && <MutationButton revision={revision} kind="cancel" label="Cancel invoice" />}
    <section className="panel product-panel"><h2>Settlement timeline</h2><p>Conversion · no finalized evidence</p><p>Recipient payout · no finalized evidence</p><strong>Not settled</strong></section>
    <section className="panel product-panel"><h2>Revision history</h2><ol>{history?.revisions.map(r => <li key={r.revision}>
      Revision {r.revision} · {r.state} · <time dateTime={new Date(r.at).toISOString()}>{new Date(r.at).toISOString()}</time>
    </li>)}</ol></section>
  </>;
}
