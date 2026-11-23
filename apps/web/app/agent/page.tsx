import { connection } from 'next/server';
import { registration } from '../../../../src/public-registration';
import { publicObservation } from '../../lib/public-observation';
import { SiteNav } from '../site-nav';
import { DecisionRecords } from '../decision-records';

import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Agent #10103', description: 'Daidai’s Celo ERC-8004 identity and its financial controls.' };

export default async function Agent() {
  await connection();
  const report = await publicObservation();
  const corroborated = report.status === 'independently verified' && Date.now() - report.observedAt <= 120_000;
  return <><SiteNav /><main className="product-shell"><h1 className="title">Daidai agent #10103</h1>
    <p>Celo ERC-8004 identity. Daidai checks invoice terms, all-in debit and evidence for each settlement step.</p>
    <section className="panel"><h2>Financial controls</h2><p>Exact output, a hard USDt cap, invoice-bound consent, separate finality checks, and no automatic retry after an unknown outcome.</p><p>Financial execution is disabled.</p></section>
    <h2>Public observations</h2>
    <DecisionRecords rows={[{ rule: 'Independent canonical registration', outcome: corroborated ? 'met' : 'unresolved',
      reason: 'The identity is corroborated only when both providers agree on a successful finalized mint and canonical block.',
      input: report.providers.map(p => p.name + ': ' + p.kind).join(' · '), observedAt: report.observedAt,
      provenance: 'Celo JSON-RPC', correlation: 'ERC-8004 #' + registration.agent }]} />
    <a href="/proof">Inspect public evidence ↗</a>
  </main></>;
}
