// Demo-only invoice model for the Daidai frontend. Nothing here talks to a wallet or a chain.

export const groups = ['Needs you', 'Needs reconciliation', 'In progress', 'Waiting for signatures', 'Settled'] as const;
export type Group = typeof groups[number];
export const groupSlugs: Record<Group, string> = {
  'Needs you': 'needs-you', 'Needs reconciliation': 'needs-reconciliation', 'In progress': 'in-progress',
  'Waiting for signatures': 'waiting', 'Settled': 'settled',
};
export const groupShort: Record<Group, string> = {
  'Needs you': 'Needs you', 'Needs reconciliation': 'Recon.', 'In progress': 'In progress',
  'Waiting for signatures': 'Waiting', 'Settled': 'Settled',
};

/** One half of the invoice-bound EIP-712 SignedAuthorization in src/authorization.ts. */
export type Signed = { signer: string; purpose: 'invoice approval' | 'recipient consent'; expiresAtMs: number };

export type Flow =
  | 'setup'                 // preparing: consent, limit, allowance, quote
  | 'conversion-submitted'  // conversion broadcast, not confirmed
  | 'conversion-confirmed'  // in a block, waiting for finality
  | 'converted'             // conversion final: cNGN in the taker wallet, recipient not paid
  | 'payout-declined'       // operator declined the payout in the wallet
  | 'payout-submitted'      // payout broadcast, not verified
  | 'payout-reverted'       // payout reverted onchain (confirmed)
  | 'uncertain'             // payout outcome unknown: reconciliation required, retry blocked
  | 'checked'               // checked: payout did not land, retry safe
  | 'verified';             // payout evidence found (settled only if it matches exactly)

export type Invoice = {
  id: string;
  recipient: string; recipientRole: string; recipientCity: string;
  approver: string; operator: string;
  wallet: string; target: bigint; cap: bigint; allowance: bigint;
  auth: { approval?: Signed; consent?: Signed };
  quote?: { pay: bigint; fee: bigint; expires: number; invalid?: boolean };
  flow: Flow;
  evidence?: { recipient: string; amount: bigint; debit: bigint };
};

export const UNIT = 1_000_000n;
export type Token = 'cNGN' | 'USDt' | 'CELO';

export function parseAtomic(input: string) {
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, '0'));
}

const grouping = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 0 });

/** Number part only. USDt always shows at least 2 decimals; cNGN shows decimals only when present. */
export function formatNumber(value: bigint, unit: Token, minFraction = unit === 'USDt' ? 2 : 0) {
  const abs = value < 0n ? -value : value;
  const whole = grouping.format(abs / UNIT);
  const digits = String(abs % UNIT).padStart(6, '0').replace(/0+$/, '').padEnd(minFraction, '0');
  return (value < 0n ? '−' : '') + whole + (digits ? '.' + digits : '');
}

/** The single amount formatter: number, a no-break space, then the unit. */
export function formatTokenAmount(value: bigint, unit: Token, minFraction?: number) {
  return formatNumber(value, unit, minFraction) + ' ' + unit;
}
/** Alias kept for older call sites and tests. */
export const amount = formatTokenAmount;

export function signaturesValid(i: Invoice, now: number) {
  const { approval, consent } = i.auth;
  return Boolean(approval && consent && approval.expiresAtMs > now && consent.expiresAtMs > now);
}
export function missingSignatures(i: Invoice, now: number) {
  const out: string[] = [];
  const check = (s: Signed | undefined, who: string, what: string) => {
    if (!s) out.push(who + '’s ' + what + ' signature is missing');
    else if (s.expiresAtMs <= now) out.push(who + '’s ' + what + ' signature has expired');
  };
  check(i.auth.approval, i.approver, 'approval');
  check(i.auth.consent, i.recipient, 'consent');
  return out;
}

export function settled(i: Invoice) {
  return i.flow === 'verified' && Boolean(i.auth.approval && i.auth.consent) &&
    i.evidence?.recipient.toLowerCase() === i.wallet.toLowerCase() &&
    i.evidence.amount === i.target && i.evidence.debit >= 0n && i.evidence.debit <= i.cap;
}

export function phase(i: Invoice): Group {
  if (settled(i)) return 'Settled';
  if (i.flow === 'uncertain' || i.flow === 'verified') return 'Needs reconciliation';
  if (!i.auth.approval || !i.auth.consent) return 'Waiting for signatures';
  if (i.flow === 'conversion-submitted' || i.flow === 'conversion-confirmed' || i.flow === 'payout-submitted') return 'In progress';
  return 'Needs you';
}

export type QuoteState = 'none' | 'held' | 'expired' | 'over' | 'invalid';
export function quoteState(i: Invoice, now: number): QuoteState {
  const q = i.quote;
  if (!q) return 'none';
  if (q.invalid) return 'invalid';
  if (q.pay > i.cap) return 'over';
  if (now >= q.expires) return 'expired';
  return 'held';
}

export const stages = ['Consent', 'Limit', 'Allowance', 'Quote', 'Approve'] as const;
/** Index of the stage that is open on the review screen. 5 means every stage is done. */
export function currentStage(i: Invoice, now: number) {
  if (i.flow !== 'setup') return 5;
  if (!signaturesValid(i, now)) return 0;
  if (i.cap <= 0n) return 1;
  if (i.allowance < i.cap) return 2;
  return 3;
}

/** The next action for the invoice, in plain words, for dashboard rows and the focus pane. */
export function nextAction(i: Invoice, now: number) {
  if (settled(i)) return 'Receipt ready';
  switch (i.flow) {
    case 'uncertain': return 'Checking a submitted payout';
    case 'verified': return 'Amounts differ. Check the evidence';
    case 'conversion-submitted': return 'Conversion submitted';
    case 'conversion-confirmed': return 'Conversion confirmed, waiting for finality';
    case 'payout-submitted': return 'Payout submitted, waiting for confirmation';
    case 'converted': return 'Approve payout to ' + i.recipient;
    case 'payout-declined': return 'You declined the payout. Check status';
    case 'payout-reverted': return 'Payout reverted. Review payout again';
    case 'checked': return 'Payout did not land. Review payout';
    case 'setup': break;
  }
  if (!signaturesValid(i, now)) {
    if (!i.auth.consent && !i.auth.approval) return 'Waiting for both signatures';
    return !i.auth.consent || i.auth.consent.expiresAtMs <= now ? 'Waiting for ' + i.recipient + '’s consent' : 'Waiting for ' + i.approver + '’s approval';
  }
  if (i.allowance < i.cap) return 'Review allowance';
  const q = quoteState(i, now);
  return q === 'held' ? 'Review conversion' : q === 'over' ? 'Quote over limit. Edit limit' : 'Get a new quote';
}

/** Which view a row opens. */
export const opensProgress = (i: Invoice) => i.flow !== 'setup';

// ---------------------------------------------------------------- demo cast (section 13)

export const OPERATOR = 'Daidai ops';
/** Visibly fake addresses: they contain DEMO and are not valid hex. */
export const demoWallet = (n: number) => '0xDEMO' + '0'.repeat(32) + 'A' + String(n).padStart(3, '0');
export const demoSpender = '0xDEMO' + '0'.repeat(32) + 'S001';

const day = 86_400_000;
const BASE_TARGET = 150_000n * UNIT;

export function fixtures(now: number): Invoice[] {
  const quote = { pay: 102_480_000n, fee: 200_000n, expires: now + 42_000 };
  const expires = now + 6 * day;
  const cast = [
    { id: 'INV-0042', recipient: 'Amaka Nwosu', recipientRole: 'Product designer', recipientCity: 'Enugu', approver: 'Tunde Okafor', naira: 150_000n, flow: 'setup' as Flow },
    { id: 'INV-0041', recipient: 'Chinedu Obi', recipientRole: 'Photographer', recipientCity: 'Lagos', approver: 'Adaeze Eze', naira: 48_500n, flow: 'converted' as Flow },
    { id: 'INV-0039', recipient: 'Zainab Musa', recipientRole: 'Tailor', recipientCity: 'Kano', approver: 'Ibrahim Yusuf', naira: 92_000n, flow: 'uncertain' as Flow },
    { id: 'INV-0038', recipient: 'Femi Adebayo', recipientRole: 'Developer', recipientCity: 'Ibadan', approver: 'Ngozi Okeke', naira: 67_500n, flow: 'conversion-submitted' as Flow },
    { id: 'INV-0035', recipient: 'Halima Bello', recipientRole: 'Caterer', recipientCity: 'Abuja', approver: 'Bisi Adeyemi', naira: 23_500n, flow: 'setup' as Flow },
    { id: 'INV-0032', recipient: 'Kemi Bello', recipientRole: 'Copywriter', recipientCity: 'Port Harcourt', approver: 'Emeka Nnadi', naira: 150_000n, flow: 'verified' as Flow },
  ];
  return cast.map((p, n): Invoice => {
    const target = p.naira * UNIT;
    // USDt figures scale with the cNGN target (rounded to cents) so each invoice has a distinct quote and limit.
    const base = target === BASE_TARGET;
    const pay = base ? quote.pay : ((quote.pay * target) / BASE_TARGET / 10_000n) * 10_000n;
    const cap = base ? 105_000_000n : ((pay * 1025n) / 1000n / 10_000n) * 10_000n;
    const fee = base ? quote.fee : ((quote.fee * target) / BASE_TARGET / 10_000n) * 10_000n;
    const wallet = demoWallet(n + 1);
    const waiting = p.id === 'INV-0035';
    return {
      id: p.id, recipient: p.recipient, recipientRole: p.recipientRole, recipientCity: p.recipientCity,
      approver: p.approver, operator: OPERATOR, wallet, target, cap,
      allowance: waiting ? 0n : cap,
      auth: {
        approval: { signer: p.approver, purpose: 'invoice approval', expiresAtMs: expires },
        consent: waiting ? undefined : { signer: p.recipient, purpose: 'recipient consent', expiresAtMs: expires },
      },
      quote: waiting ? undefined : { pay, fee, expires: quote.expires },
      flow: p.flow,
      evidence: p.flow === 'verified' ? { recipient: wallet, amount: target, debit: pay } : undefined,
    };
  });
}

// ---------------------------------------------------------------- demo scenarios (?demo=…)

export type Scenario = { label: string; id: string; view: 'detail' | 'progress'; patch: (i: Invoice, now: number) => Invoice };
export const scenarios: Record<string, Scenario> = {
  'signatures-missing': { label: 'Waiting for consent', id: 'INV-0042', view: 'detail', patch: i => ({ ...i, auth: { approval: i.auth.approval } }) },
  'signature-expired': { label: 'Consent expired', id: 'INV-0042', view: 'detail', patch: (i, now) => ({ ...i, auth: { approval: i.auth.approval, consent: i.auth.consent && { ...i.auth.consent, expiresAtMs: now - 60_000 } } }) },
  'allowance-needed': { label: 'Allowance needed', id: 'INV-0042', view: 'detail', patch: i => ({ ...i, allowance: 0n, quote: undefined }) },
  'no-quote': { label: 'No quote available', id: 'INV-0042', view: 'detail', patch: i => ({ ...i, quote: undefined }) },
  'quote-held': { label: 'Quote held', id: 'INV-0042', view: 'detail', patch: i => i },
  'expiring': { label: 'Quote under 15 s', id: 'INV-0042', view: 'detail', patch: (i, now) => ({ ...i, quote: i.quote && { ...i.quote, expires: now + 12_000 } }) },
  'expired': { label: 'Quote expired', id: 'INV-0042', view: 'detail', patch: (i, now) => ({ ...i, quote: i.quote && { ...i.quote, expires: now - 1_000 } }) },
  'over-limit': { label: 'Over limit', id: 'INV-0042', view: 'detail', patch: i => ({ ...i, quote: i.quote && { ...i.quote, pay: 106_100_000n } }) },
  'invalid-quote': { label: 'Invalid quote', id: 'INV-0042', view: 'detail', patch: i => ({ ...i, quote: i.quote && { ...i.quote, invalid: true } }) },
  'conversion-submitted': { label: 'Conversion submitted', id: 'INV-0038', view: 'progress', patch: i => i },
  'conversion-confirmed': { label: 'Confirmed, not final', id: 'INV-0038', view: 'progress', patch: i => ({ ...i, flow: 'conversion-confirmed' }) },
  'converted': { label: 'Conversion final', id: 'INV-0041', view: 'progress', patch: i => i },
  'declined': { label: 'Wallet declined', id: 'INV-0041', view: 'progress', patch: i => ({ ...i, flow: 'payout-declined' }) },
  'payout-submitted': { label: 'Payout submitted', id: 'INV-0041', view: 'progress', patch: i => ({ ...i, flow: 'payout-submitted' }) },
  'reverted': { label: 'Reverted', id: 'INV-0041', view: 'progress', patch: i => ({ ...i, flow: 'payout-reverted' }) },
  'unknown': { label: 'Unknown outcome', id: 'INV-0039', view: 'progress', patch: i => i },
  'mismatch': { label: 'Mismatch', id: 'INV-0039', view: 'progress', patch: i => ({ ...i, flow: 'verified', evidence: { recipient: i.wallet, amount: 91_800n * UNIT, debit: i.quote?.pay ?? 0n } }) },
  'checked': { label: 'Checked, safe to retry', id: 'INV-0039', view: 'progress', patch: i => ({ ...i, flow: 'checked' }) },
  'settled': { label: 'Settled', id: 'INV-0032', view: 'progress', patch: i => i },
};
