import { encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { isVerifiedAuthorization, type VerifiedAuthorization } from './authorization.ts';
import { verified, type CeloReader, type FeeCeilings, type Settlement } from './celo.ts';
import { address, atomic, check, commit, reactor, tag, type Invoice, type Tx } from './invoice.ts';
import { exactOutRequest, parseTextileQuote } from './textile.ts';

export type FirmQuoteReader = (request: ReturnType<typeof exactOutRequest>) => Promise<unknown>;
type Balances = { chain: number; wallet: string; sellToken: string; buyToken: string; spender: string; observedAt: number;
  allowance: bigint; usdt: bigint; cngn: bigint; native: bigint };
type Ports = { clock: () => number; balances: (invoice: Readonly<Invoice>) => Promise<Balances>; reader: CeloReader };
type Policy = { code: string; swap: FeeCeilings; payout: FeeCeilings };

function scope(raw: Invoice, proof: VerifiedAuthorization, now: number) {
  const { invoice, digest } = commit(raw);
  check(Number.isSafeInteger(now) && isVerifiedAuthorization(proof) && proof.digest === digest && proof.approver === invoice.approver &&
    proof.recipient === invoice.recipient && proof.expires === invoice.expires && now < invoice.expires, 'missing current approval or consent');
  return { invoice, digest };
}
function assertBalances(i: Invoice, b: Balances, now: number) {
  check(b.chain === i.chain && address(b.wallet) === i.taker && address(b.sellToken) === i.sell &&
    address(b.buyToken) === i.buy && address(b.spender) === reactor, 'wrong balance scope');
  check(Number.isSafeInteger(b.observedAt) && b.observedAt <= now && b.observedAt > now - 10_000 &&
    [b.allowance, b.usdt, b.cngn, b.native].every(v => typeof v === 'bigint' && v >= 0n), 'stale or invalid balance evidence');
}
function reviewBound(i: Invoice, tx: Tx, action: Settlement['action'], debit: bigint) {
  return { tx: Object.freeze(tx), action, sender: i.taker, recipient: action === 'swap' ? i.taker : i.recipient,
    buyToken: i.buy, sellToken: i.sell, amount: atomic(i.buyAmount), debit };
}

type Bound = ReturnType<typeof reviewBound>;
type Candidate = Readonly<Bound & { digest: string; bounds: Settlement['bounds'] }>;
type Conversion = { readonly digest: string; readonly hash: Hex };
const prepared = new WeakSet<object>();
const finalizedConversion = new WeakSet<object>();

async function simulate(ports: Ports, bound: Bound, limits: FeeCeilings, digest: string): Promise<Candidate> {
  const bounds = await ports.reader.preflight({ from: bound.sender, to: bound.tx.to, data: bound.tx.data, value: '0x0' }, limits, bound);
  const result = Object.freeze({ ...bound, digest, bounds: Object.freeze(bounds) });
  prepared.add(result);
  return result;
}

/** Interface only. Any injected source used here must be isolated or explicitly owner-approved for firm requests. */
export async function readFirmFixture(invoice: Invoice, read: FirmQuoteReader) {
  return read(exactOutRequest(commit(invoice).invoice));
}

/** Read-only review of one already obtained response. Calling it again re-runs exact-envelope simulation. */
export async function reviewConversion(raw: Invoice, proof: VerifiedAuthorization, wire: unknown, ports: Ports, policy: Policy) {
  const { invoice, digest } = scope(raw, proof, ports.clock());
  const quote = parseTextileQuote(wire, invoice);
  if (quote.status === 'no_quote') return { kind: 'no-quote' } as const;
  const deadline = Math.min(quote.expiresAt, quote.orderDeadline, invoice.expires);
  const fresh = () => check(ports.clock() + 5_000 < deadline, 'quote no longer fresh');
  fresh();
  const funds = await ports.balances(invoice);
  assertBalances(invoice, funds, ports.clock());
  fresh();
  const debit = atomic(quote.takerPays);
  check(funds.usdt >= debit && funds.native >= policy.swap.totalWei + policy.payout.totalWei, 'insufficient stablecoin or gas balance');
  check(funds.allowance <= atomic(invoice.maxSell), 'confirmed allowance exceeds pilot cap');
  if (funds.allowance < debit) return { kind: 'allowance-required', spender: reactor, approvalAmount: debit } as const;
  const swap = { ...quote.transactions.swap, data: tag(quote.transactions.swap.data, policy.code) };
  const candidate = await simulate(ports, reviewBound(invoice, swap, 'swap', debit), policy.swap, digest);
  fresh();
  assertBalances(invoice, funds, ports.clock());
  return { kind: 'review', candidate, deadline, fee: atomic(quote.feeAmount), debit } as const;
}

export async function verifyConversion(candidate: Candidate, hash: Hex, reader: CeloReader): Promise<Conversion | null> {
  if (!prepared.has(candidate) || candidate.action !== 'swap') return null;
  const evidence = await reader.verifySettlement({ ...candidate, hash });
  if (!evidence || !verified(evidence)) return null;
  const result = Object.freeze({ digest: candidate.digest, hash });
  finalizedConversion.add(result);
  return result;
}

export async function reviewPayout(raw: Invoice, proof: VerifiedAuthorization, conversion: Conversion, ports: Ports, policy: Policy) {
  const { invoice, digest } = scope(raw, proof, ports.clock());
  check(finalizedConversion.has(conversion) && conversion.digest === digest, 'separate finalized conversion required');
  const funds = await ports.balances(invoice);
  assertBalances(invoice, funds, ports.clock());
  check(funds.cngn >= atomic(invoice.buyAmount) && funds.native >= policy.payout.totalWei, 'insufficient payout balance');
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [invoice.recipient as Hex, atomic(invoice.buyAmount)] });
  const candidate = await simulate(ports, reviewBound(invoice, { to: invoice.buy, data: tag(data, policy.code), value: '0', chainId: invoice.chain }, 'payout', 0n), policy.payout, digest);
  scope(raw, proof, ports.clock());
  assertBalances(invoice, funds, ports.clock());
  return candidate;
}

export async function verifyPayout(candidate: Candidate, hash: Hex, reader: CeloReader) {
  if (!prepared.has(candidate) || candidate.action !== 'payout') return null;
  const evidence = await reader.verifySettlement({ ...candidate, hash });
  return evidence && verified(evidence) ? evidence : null;
}
