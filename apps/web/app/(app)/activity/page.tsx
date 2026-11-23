import { requirePrivate } from '../../../lib/private';
import { getAuthoritativeInvoice } from '../../../lib/daidai-api';

export const dynamic = 'force-dynamic';
export default async function Activity() {
  const { token, invoices } = await requirePrivate();
  const results = invoices ? await Promise.all(invoices.slice(0, 8).map(row => getAuthoritativeInvoice(row.id, token))) : [];
  const observed = results.flatMap(result => result.kind === 'invoice' ? [result.invoice] : []);
  return <><h1 className="title">Settlement activity</h1>
    {invoices === null || results.some(r => r.kind !== 'invoice') ? <p role="status">Some invoice evidence is unavailable.</p> : null}
    {observed.length === 0 && <p role="status">No settlement observations are available for this workspace.</p>}
    {observed.map(i => <section className="panel product-evidence" key={i.id}>
      <h2><a href={'/invoices/' + encodeURIComponent(i.id)}>{i.id}</a></h2><p>{i.settlement === 'settled' ? 'Settled' : 'Not settled'}</p>
      {(['conversion','payout'] as const).map(operation => <div key={operation}><strong>{operation === 'conversion' ? 'Conversion' : 'Payout'}</strong>
        <p>{i[operation].state.replaceAll('-', ' ')}</p>
        {i[operation].evidence && <code>{i[operation].evidence.hash}</code>}</div>)}
    </section>)}
    {(invoices?.length ?? 0) > 8 && <p><a href="/invoices">View all invoices</a> for individual evidence.</p>}
  </>;
}
