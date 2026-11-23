import { randomBytes } from 'node:crypto';
import { notFound } from 'next/navigation';
import { requirePrivate } from '../../../../lib/private';
import { localProduct } from '../../../../lib/product';
import { productCall } from '../../../../lib/daidai-api';
import { DraftForm, ProductError } from '../../product-ui';

export const dynamic = 'force-dynamic';
export default async function NewInvoice({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  if (!localProduct()) notFound();
  const { token } = await requirePrivate();
  const list = await productCall({ kind: 'list' }, token);
  const { result } = await searchParams;
  return <><h1 className="title">Create an invoice</h1><ProductError result={result} />
    {!list || list.kind !== 'list' ? <p role="status">The invoice service is unavailable.</p>
      : !list.merchant ? <p role="status">Merchant permission is required.</p>
      : <section className="panel product-panel"><p>Review terms before committing. Settlement requires separate invoice approval and recipient consent.</p>
        <DraftForm id={randomBytes(16).toString('hex')} /></section>}
  </>;
}
