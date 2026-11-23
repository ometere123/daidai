import { localProduct } from '../../../../lib/product';
import { notFound } from 'next/navigation';
import MerchantInvoice from '../../merchant/[id]/page';
import type { Metadata } from 'next';
import { AuthoritativeInvoiceView } from '../../../authoritative-invoice-view';
import { getAuthoritativeInvoice } from '../../../../lib/daidai-api';
import { requirePrivate } from '../../../../lib/private';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: 'Authoritative invoice · Daidai', robots: { index: false, follow: false, nocache: true } };

const settlementText = {
  unverified: 'Settlement is unverified. Nothing on this page is a receipt.',
  'reconciliation-required': 'Reconciliation is required before this invoice can be treated as settled. Nothing on this page is a receipt.',
} as const;

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  const { token } = await requirePrivate();
  const { id } = await params;
  if (localProduct() && /^[0-9a-f]{32}$/.test(id)) return MerchantInvoice({ params, searchParams });
  const result = await getAuthoritativeInvoice(id, token);
  return <>
    <a className="back" href="/invoices"><span aria-hidden="true">←</span> Invoices</a>
    <div className="panel" role="region" aria-label="Authoritative notice">
      <strong>Authoritative · read-only</strong>
      <p className="meta">Server-rendered from the Daidai API. No wallet, signing or payment actions exist on this page.</p>
    </div>
    {result.kind === 'invoice' ? <>
      {result.invoice.settlement !== 'settled' ? <div className="panel" role="note" aria-label="Settlement status">
        {settlementText[result.invoice.settlement === 'reconciliation-required' ? 'reconciliation-required' : 'unverified']}
      </div> : null}
      {!result.invoice.conversion.evidence || !result.invoice.payout.evidence ? <div className="panel" role="note" aria-label="Chain evidence notice">
        No verified chain evidence is available for {!result.invoice.conversion.evidence && !result.invoice.payout.evidence ? 'the conversion or the payout'
          : !result.invoice.conversion.evidence ? 'the conversion' : 'the payout'}.
      </div> : null}
      <AuthoritativeInvoiceView invoice={result.invoice} />
    </> : <div className="panel" role="status" data-result="unavailable">This invoice is not available.</div>}
  </>;
}
