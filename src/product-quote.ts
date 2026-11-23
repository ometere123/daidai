import { atomic, cngn, chain, usdt } from './invoice-core.ts';
import type { Revision } from './product-contract.ts';

export type TextilePreviewRequest = Readonly<{ chainId: typeof chain; sellToken: typeof usdt; buyToken: typeof cngn; buyAmount: string }>;
export type PreviewSource = (request: TextilePreviewRequest) => Promise<unknown>;
export const textilePreviewPath = '/v2/rfq/preview';
const amount = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 78) throw Error('amount');
  return atomic(v);
};
const record = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export async function preparePreview(invoice: Revision, source: PreviewSource, clock: () => number) {
  const start = clock(), reviewUntil = Math.min(invoice.expiry, start + 30_000);
  if (invoice.state !== 'committed' || !invoice.digest || reviewUntil <= start) return { kind: 'expired' } as const;
  const request: TextilePreviewRequest = Object.freeze({ chainId: chain, sellToken: usdt, buyToken: cngn, buyAmount: invoice.target });
  try {
    const body = record(record(await source(request)).data);
    if (clock() >= reviewUntil) return { kind: 'expired' } as const;
    if (body.status === 'no_quote') return { kind: 'unavailable' } as const;
    if (body.status !== 'preview') return { kind: 'invalid' } as const;
    const buy = amount(body.buyAmount), debit = amount(body.takerPays), fee = amount(body.feeAmount);
    // Preview does not echo route identity. Bind the request to this corridor and never promote the response to settlement evidence.
    if (buy !== atomic(invoice.target) || debit <= 0n || fee >= debit) return { kind: 'invalid' } as const;
    if (debit > atomic(invoice.cap)) return { kind: 'over-cap' } as const;
    return { kind: 'indicative', debit: debit.toString(), fee: fee.toString(), base: (debit - fee).toString(), reviewUntil } as const;
  } catch { return { kind: 'unavailable' } as const; }
}

export const simulatedTextilePreview: PreviewSource = async ({ buyAmount }) => {
  // Synthetic 1 USDt = 1,500 cNGN, rounded up to the next USDt atomic unit.
  const base = (BigInt(buyAmount) + 1499n) / 1500n;
  const fee = (base + 999n) / 1000n;
  return { data: { status: 'preview', buyAmount, takerPays: String(base + fee), feeAmount: String(fee) } };
};
