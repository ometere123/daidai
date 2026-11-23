import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { AuthoritativeInvoiceView } from '../../../authoritative-invoice-view';
import { getAuthoritativeInvoice } from '../../../../lib/daidai-api';
import { demoViewerToken, internalDemoEnabled } from '../../../../lib/internal-demo';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const metadata: Metadata = { title: 'Authoritative invoice · Internal', robots: { index: false, follow: false, nocache: true } };

const banner = { borderLeft: '4px solid currentColor', padding: '12px 16px', margin: '16px 0' } as const;

export default async function InternalAuthoritativePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  await connection();
  if (!internalDemoEnabled()) notFound();
  const { invoiceId } = await params;
  const token = demoViewerToken();
  const result = token ? await getAuthoritativeInvoice(invoiceId, token) : { kind: 'misconfigured' as const };
  return <main className="shell" data-source="authoritative" data-execution="disabled">
    <div className="panel" role="region" aria-label="Authoritative notice" style={banner}>
      <strong>Authoritative · Internal read-only demonstration</strong>
      <p className="meta">Server-rendered from the read-only API. No wallet, signing or payment actions exist on this page.</p>
    </div>
    <h1>Authoritative invoice</h1>
    {result.kind === 'invoice' ? <>
      <div className="panel" role="note" aria-label="Chain reader notice" style={banner}>
        No chain reader is configured, so settlement cannot be shown. Conversion and payout remain unverified until
        finalized onchain evidence is independently read.
      </div>
      <AuthoritativeInvoiceView invoice={result.invoice} />
    </> : <div className="panel" role="status" data-result="unavailable" style={banner}>
      This invoice is not available.
    </div>}
  </main>;
}
