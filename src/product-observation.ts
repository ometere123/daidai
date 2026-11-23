import type { Revision } from './product-contract.ts';

type SimulatedTransfer = { token: 'cNGN'; to: string; amount: string };
type Observation = { kind: 'unknown' } | { kind: 'seen'; transfer: SimulatedTransfer };
export type SimulatedPayout = Readonly<{ provenance: 'simulation'; state: 'reconciliation-required' | 'example-matches'; recipient: string; target: string }>;

export function simulatePayoutObservation(invoice: Revision, evidence: Observation): SimulatedPayout {
  const matches = evidence.kind === 'seen' && evidence.transfer.token === 'cNGN' &&
    evidence.transfer.to === invoice.recipient && evidence.transfer.amount === invoice.target;
  return { provenance: 'simulation', state: matches ? 'example-matches' : 'reconciliation-required',
    recipient: invoice.recipient, target: invoice.target };
}
