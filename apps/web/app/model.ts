export const groups = ['Needs you', 'Needs reconciliation', 'In progress', 'Waiting for payer', 'Settled'] as const;
export type Group = typeof groups[number];
export type Invoice = {
  id: string; recipient: string; payer: string; wallet: string; target: bigint; cap: bigint; allowance: bigint;
  consent: boolean; quote?: { pay: bigint; fee: bigint; expires: number };
  flow: 'setup' | 'converted' | 'submitted' | 'uncertain' | 'verified';
  evidence?: { recipient: string; amount: bigint; debit: bigint };
};

export function parseAtomic(input: string) {
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
}

export function amount(value: bigint, unit: 'cNGN' | 'USDt' | 'CELO') {
  const abs = value < 0n ? -value : value;
  const whole = new Intl.NumberFormat('en-GB').format(abs / 1000000n);
  const digits = String(abs % 1000000n).padStart(6, '0').replace(/0+$/, '');
  const fraction = unit === 'USDt' ? digits.padEnd(2, '0') : digits;
  return (value < 0n ? '−' : '') + whole + (fraction ? '.' + fraction : '') + '\u00a0' + unit;
}

export function settled(i: Invoice) {
  return i.flow === 'verified' && i.consent && i.evidence?.recipient.toLowerCase() === i.wallet.toLowerCase() &&
    i.evidence.amount === i.target && i.evidence.debit >= 0n && i.evidence.debit <= i.cap;
}
export function phase(i: Invoice): Group {
  if (settled(i)) return 'Settled';
  if (i.flow === 'uncertain' || i.flow === 'verified') return 'Needs reconciliation';
  if (!i.consent) return 'Waiting for payer';
  return i.flow === 'submitted' ? 'In progress' : 'Needs you';
}
export function stepsRemaining(i: Invoice) {
  if (i.flow === 'verified' || i.flow === 'uncertain' || i.flow === 'submitted') return 0;
  return i.flow === 'converted' ? 1 : i.allowance >= i.cap ? 2 : 3;
}
const wallet = '0x0000000000000000000000000000000000008a21';
const base = {recipient:'Amaka Nwosu',payer:'Tunde Okafor',wallet,target:150000000000n,cap:105000000n,allowance:105000000n,consent:true} as const;
export function fixtures(now: number): Invoice[] {
  const quote = {pay:102480000n,fee:200000n,expires:now+42000};
  return [
    {...base,id:'INV-0042',flow:'setup',quote},
    {...base,id:'INV-0041',payer:'Adaeze Eze',target:48500000000n,flow:'converted',quote},
    {...base,id:'INV-0039',payer:'Ibrahim Yusuf',target:92000000000n,flow:'uncertain',quote},
    {...base,id:'INV-0038',payer:'Chidi Obi',target:67500000000n,flow:'submitted',quote},
    {...base,id:'INV-0035',payer:'Bisi Adeyemi',target:23500000000n,consent:false,allowance:0n,flow:'setup'},
    {...base,id:'INV-0032',payer:'Kemi Bello',flow:'verified',quote,evidence:{recipient:wallet,amount:base.target,debit:quote.pay}},
  ];
}
