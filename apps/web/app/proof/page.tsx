import { connection } from 'next/server';
import { publicObservation } from '../../lib/public-observation';
import { LiveCheck, RecordedRegistration, RegistrationVerdict } from '../evidence';
import { SiteNav } from '../site-nav';

import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Public verification', description: 'Independent Celo observation of Daidai’s public registration evidence.' };

export default async function Proof() {
  await connection();
  const report = await publicObservation();
  const fresh = Date.now() - report.observedAt <= 120_000;
  const corroborated = fresh && report.status === 'independently verified';
  return <><SiteNav /><main id="main" className="product-shell"><h1 className="title">Public verification</h1>
    <p>Two separate questions: is this agent registered, and has it settled any money? They have separate evidence and are never mixed.</p>
    <h2 className="proof-heading">1. Registration</h2>
    <RegistrationVerdict corroborated={corroborated} />
    <RecordedRegistration />
    <LiveCheck status={fresh ? report.status : 'unresolved · observation stale'} observedAt={report.observedAt} providers={report.providers} />
    <h2 className="proof-heading">2. Settlement</h2>
    <section className="panel" aria-labelledby="settlement-title">
      <h2 id="settlement-title">Settlement evidence</h2>
      <p>No verified USDt conversion or cNGN payout has been published.</p>
      <p className="evidence-note">When one exists it will appear here with both transaction references, the actual USDt debit including the fee, the exact cNGN credited, the date each was verified, and the recipient’s acknowledgement. Live settlement is not yet authorised.</p>
    </section>
  </main></>;
}
