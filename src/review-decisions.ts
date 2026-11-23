export type Decision = Readonly<{
  rule: string; outcome: 'met' | 'blocked' | 'unresolved'; reason: string; input: string;
  observedAt: number; provenance: string; correlation: string;
}>;
type Review = { quote?: 'indicative' | 'over-cap' | 'expired' | 'invalid' | 'unavailable'; approval?: string;
  consent?: string; conversion?: string; payout?: string; observedAt: number; correlation: string; provenance: string };
export function reviewDecisions(r: Review): Decision[] {
  const row = (rule: string, outcome: Decision['outcome'], input: string, reason: string, provenance = r.provenance): Decision =>
    ({ rule, outcome, input, reason, observedAt: r.observedAt, provenance, correlation: r.correlation });
  return [
    row('Exact output and all-in cap', r.quote === 'indicative' ? 'met' : r.quote === 'over-cap' || r.quote === 'invalid' ? 'blocked' : 'unresolved',
      r.quote ?? 'no quote evidence', 'Only an exact-output indicative response within the cap passes quote review.', r.quote ? 'Textile FX preview' : r.provenance),
    row('Quote expiry and liquidity', r.quote === 'expired' ? 'blocked' : 'unresolved', r.quote ?? 'no quote evidence',
      'Indicative pricing reserves no maker liquidity. A firm order must be fresh at execution review.', r.quote ? 'Textile FX preview' : r.provenance),
    row('Invoice approval and recipient consent', r.approval === 'verified' && r.consent === 'verified' ? 'met' : 'blocked',
      [r.approval ?? 'missing', r.consent ?? 'missing'].join(' / '), 'Both permissions must be verified for this commitment.'),
    row('Wallet, gas and allowance', 'unresolved', 'No trusted funding evidence', 'Readiness requires the enrolled signer, balances, native gas and confirmed allowance.'),
    row('Separate finalized conversion and payout', r.conversion === 'verified' && r.payout === 'verified' ? 'met' : 'unresolved',
      [r.conversion ?? 'unverified', r.payout ?? 'unverified'].join(' / '), 'Both steps require canonical evidence. Missing or conflicting evidence blocks settlement.'),
    row('Duplicate and unknown attempt protection', 'blocked', r.payout ?? 'No verified payout',
      'The review interface cannot dispatch. An unknown prior attempt requires authoritative reconciliation.'),
  ];
}
