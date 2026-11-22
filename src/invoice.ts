import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fromDataSuffix, toDataSuffix } from '@celo/attribution-tags';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';

export const chain = 42220;
export const usdt = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e';
export const cngn = '0xf6829d7393dae24509eb1e52ee8e572e2e271a4f';
export const reactor = '0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3';
export const registry = '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432';

export function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}

export type Invoice = {
  id: string; version: number; source: string; nonce: string; chain: number;
  sell: string; sellDecimals: number; buy: string; buyDecimals: number;
  buyAmount: string; recipient: string; maxSell: string; approver: string;
  taker: string; expires: number;
};
export const address = (value: string) => {
  check(/^0x[0-9a-fA-F]{40}$/.test(value) && BigInt(value) !== 0n, 'invalid address');
  return value.toLowerCase();
};
export const atomic = (value: string) => {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'invalid atomic units');
  const amount = BigInt(value);
  check(amount < 2n ** 256n, 'atomic overflow');
  return amount;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function commit(i: Invoice) {
  check(i.id && i.source && /^[a-f0-9]{32}$/.test(i.nonce), 'invalid invoice identity');
  check(Number.isSafeInteger(i.version) && i.version > 0 && Number.isSafeInteger(i.expires), 'invalid version or expiry');
  const invoice = Object.freeze({
    id: i.id, version: i.version, source: i.source, nonce: i.nonce, chain: i.chain,
    sell: address(i.sell), sellDecimals: i.sellDecimals, buy: address(i.buy), buyDecimals: i.buyDecimals,
    buyAmount: i.buyAmount, recipient: address(i.recipient), maxSell: i.maxSell,
    approver: address(i.approver), taker: address(i.taker), expires: i.expires,
  });
  check(invoice.chain === chain && invoice.sell === usdt && invoice.buy === cngn &&
    invoice.sellDecimals === 6 && invoice.buyDecimals === 6, 'invoice corridor');
  check(atomic(invoice.buyAmount) > 0n && atomic(invoice.maxSell) > 0n, 'zero amount');
  return Object.freeze({ invoice, digest: hash(['Daidai invoice v1', invoice]) });
}

export function tag(data: Hex, code: string): Hex {
  check(!fromDataSuffix(data), 'already attributed');
  return `${data}${toDataSuffix(code).slice(2)}`;
}
export function verifyTag(data: Hex, code: string) {
  const parsed = fromDataSuffix(data);
  check(parsed?.schemaId === 0 && parsed.codes.length === 1 && parsed.codes[0] === code, 'attribution');
}
export type Tx = { to: string; data: Hex; chainId: number; value: string };
function sameTransaction(actual: Tx, expected: Tx | undefined) {
  return expected !== undefined && address(actual.to) === expected.to &&
    actual.data.toLowerCase() === expected.data.toLowerCase() &&
    actual.chainId === expected.chainId && actual.value === expected.value;
}
export type Quote = {
  status: 'quoted'; chain: number; sell: string; buy: string; taker: string;
  buyAmount: string; takerPays: string; feeAmount: string; expiresAt: number; orderDeadline: number;
  transactions: { approval: Tx; swap: Tx };
};
export type Receipt = {
  ok: boolean; finalized: boolean; chain: number; from: string; to: string; token: string;
  amount: string; debit: string; tx: Tx;
};
type Approval = { digest: string; approver: string };
type Consent = { digest: string; recipient: string; evidence: string };
export type Funds = { usdt: bigint; cngn: bigint; gas: bigint; allowance: bigint;
  swapGas: bigint; payoutGas: bigint };
const transitions = {
  draft: ['authorized', 'rejected'], authorized: ['quote_pending'],
  quote_pending: ['quoted', 'failed', 'rejected'], quoted: ['swap_broadcast', 'rejected'],
  swap_broadcast: ['needs_reconciliation', 'converted'],
  converted: ['payout_pending'], payout_pending: ['payout_broadcast', 'needs_reconciliation'],
  payout_broadcast: ['paid', 'needs_reconciliation'],
  needs_reconciliation: ['converted', 'paid'], paid: [], failed: [], rejected: [],
} as const;
type State = keyof typeof transitions;
type RecordData = {
  state: State; revision: number; commitment: ReturnType<typeof commit>; history: State[];
  approval?: Approval; consent?: Consent; quote?: Quote; swap?: Tx; payout?: Tx;
  swapId?: string; payoutId?: string;
};

export class MockChain {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS broadcast (id TEXT PRIMARY KEY, tx TEXT, receipt TEXT)');
  }
  send(id: string, tx: Tx) {
    this.db.prepare('INSERT INTO broadcast (id, tx) VALUES (?, ?)').run(id, JSON.stringify(tx));
  }
  count() {
    return Number(this.db.prepare('SELECT count(*) AS n FROM broadcast').get()?.n);
  }
  settle(id: string, evidence: Omit<Receipt, 'tx'>) {
    const row = this.db.prepare('SELECT tx FROM broadcast WHERE id = ?').get(id);
    check(row, 'unknown mock transaction');
    this.db.prepare('UPDATE broadcast SET receipt = ? WHERE id = ?')
      .run(JSON.stringify({ ...evidence, tx: JSON.parse(String(row.tx)) }), id);
  }
  receipt(id: string): Receipt | undefined {
    const row = this.db.prepare('SELECT receipt FROM broadcast WHERE id = ?').get(id);
    return row?.receipt ? JSON.parse(String(row.receipt)) : undefined;
  }
  close() { this.db.close(); }
}

export class Spike {
  db: DatabaseSync;
  readonly wallet: MockChain | undefined;
  readonly code: string;
  constructor(file: string, wallet: MockChain | undefined, code: string) {
    this.wallet = wallet;
    this.code = code;
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, body TEXT, revision INTEGER)');
  }
  create(invoice: Invoice) {
    const commitment = commit(invoice);
    const record: RecordData = { state: 'draft', commitment, revision: 0, history: ['draft'] };
    this.db.prepare('INSERT INTO invoices VALUES (?, ?, 0)').run(invoice.id, JSON.stringify(record));
    return commitment;
  }
  read(id: string): RecordData {
    const row = this.db.prepare('SELECT body FROM invoices WHERE id = ?').get(id);
    check(row, 'missing invoice');
    const record: RecordData = JSON.parse(String(row.body));
    check(commit(record.commitment.invoice).digest === record.commitment.digest, 'commitment integrity');
    return record;
  }
  private move(record: RecordData, state: State, patch: Partial<RecordData> = {}) {
    check((transitions[record.state] as readonly State[]).includes(state), 'invalid transition');
    const next = { ...record, ...patch, state, revision: record.revision + 1, history: [...record.history, state] };
    const result = this.db.prepare('UPDATE invoices SET body = ?, revision = ? WHERE id = ? AND revision = ?')
      .run(JSON.stringify(next), next.revision, record.commitment.invoice.id, record.revision);
    check(result.changes === 1, 'concurrent claim');
  }
  authorize(id: string, approval: Approval, consent: Consent | undefined, now: number) {
    const r = this.read(id);
    const { invoice, digest } = r.commitment;
    if (approval.digest !== digest || approval.approver !== invoice.approver || now >= invoice.expires ||
      consent?.digest !== digest || consent.recipient !== invoice.recipient || !consent.evidence.trim()) {
      this.move(r, 'rejected');
      throw Error('approval or consent');
    }
    this.move(r, 'authorized', { approval, consent });
  }
  request(id: string) { this.move(this.read(id), 'quote_pending'); }
  receive(id: string, response: Quote | { status: 'no_quote' }, now: number, funds: Funds) {
    const r = this.read(id);
    if (response.status === 'no_quote') {
      this.move(r, 'failed');
      return;
    }
    try {
      this.validateQuote(r.commitment.invoice, response, now, funds);
    } catch (error) {
      this.move(r, 'rejected');
      throw error;
    }
    this.move(r, 'quoted', { quote: response });
  }
  validateQuote(i: Invoice, q: Quote, now: number, funds: Funds) {
    check(q.chain === i.chain && q.sell === i.sell && q.buy === i.buy && q.taker === i.taker, 'quote corridor or taker');
    check(now < i.expires && now < q.expiresAt && now < q.orderDeadline, 'quote expired');
    const debit = atomic(q.takerPays);
    check(atomic(q.buyAmount) === atomic(i.buyAmount), 'exact output');
    check(debit > 0n && debit <= atomic(i.maxSell) && atomic(q.feeAmount) <= debit, 'debit cap');
    const { approval, swap } = q.transactions;
    check(approval.chainId === i.chain && swap.chainId === i.chain &&
      approval.to === i.sell && swap.to === reactor && approval.value === '0' && swap.value === '0', 'transaction envelope');
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
    check(decoded.functionName === 'approve' && decoded.args[0].toLowerCase() === reactor &&
      decoded.args[1] === debit, 'incorrect spender or allowance amount');
    check(funds.usdt >= debit && funds.allowance >= debit &&
      funds.gas >= funds.swapGas + funds.payoutGas, 'insufficient balance, confirmed allowance, or gas');
  }
  claimSwap(id: string, now: number, funds: Funds) {
    const r = this.read(id);
    check(r.state === 'quoted' && r.quote, 'swap already attempted or unavailable');
    this.validateQuote(r.commitment.invoice, r.quote, now, funds);
    const raw = r.quote.transactions.swap;
    const swap = { ...raw, data: tag(raw.data, this.code) };
    verifyTag(swap.data, this.code);
    const swapId = `${r.commitment.digest}:swap`;
    this.move(r, 'swap_broadcast', { swapId, swap });
    return { swapId, swap };
  }
  swap(id: string, now: number, funds: Funds) {
    check(this.wallet, 'mock wallet required');
    const { swapId, swap } = this.claimSwap(id, now, funds);
    this.wallet.send(swapId, swap);
    return swapId;
  }
  reconcileSwap(id: string, report: 'failed' | 'expired' | 'filled', evidence?: Receipt | null) {
    const r = this.read(id);
    check(r.swapId && r.swap && !r.payoutId &&
      (r.state === 'swap_broadcast' || r.state === 'needs_reconciliation'), 'no unsettled swap');
    const receipt = evidence === undefined ? this.wallet?.receipt(r.swapId) : evidence;
    const { invoice } = r.commitment;
    if (receipt?.ok && receipt.finalized && receipt.chain === invoice.chain &&
      receipt.from === invoice.taker && receipt.to === invoice.taker && receipt.token === invoice.buy &&
      receipt.amount === invoice.buyAmount && receipt.debit === r.quote?.takerPays &&
      sameTransaction(receipt.tx, r.swap)) {
      this.move(r, 'converted');
    } else if (r.state === 'swap_broadcast') {
      this.move(r, 'needs_reconciliation');
    }
    return report;
  }
  claimPayout(id: string) { this.move(this.read(id), 'payout_pending'); }
  claimTransfer(id: string, tx: Tx, now: number, funds: Funds) {
    const r = this.read(id);
    check(r.state === 'payout_pending' && !r.payoutId, 'payout already claimed or unavailable');
    const { invoice, digest } = r.commitment;
    check(now < invoice.expires && r.consent?.digest === digest, 'payout authorization expired');
    check(tx.chainId === invoice.chain && tx.to === invoice.buy && tx.value === '0', 'payout envelope');
    verifyTag(tx.data, this.code);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    check(decoded.functionName === 'transfer' && decoded.args[0].toLowerCase() === invoice.recipient &&
      decoded.args[1] === atomic(invoice.buyAmount), 'payout recipient or amount');
    check(funds.cngn >= atomic(invoice.buyAmount) && funds.gas >= funds.payoutGas, 'insufficient payout funding');
    const payoutId = `${digest}:payout`;
    this.move(r, 'payout_broadcast', { payoutId, payout: tx });
    return payoutId;
  }
  payout(id: string, tx: Tx, now: number, funds: Funds, crash = false) {
    check(this.wallet, 'mock wallet required');
    const payoutId = this.claimTransfer(id, tx, now, funds);
    this.wallet.send(payoutId, tx);
    if (crash) throw Error('simulated crash after payout broadcast');
    return payoutId;
  }
  reconcilePayout(id: string, evidence?: Receipt | null) {
    const r = this.read(id);
    check(r.payoutId && r.payout && (r.state === 'payout_broadcast' || r.state === 'needs_reconciliation'), 'no unsettled payout');
    const receipt = evidence === undefined ? this.wallet?.receipt(r.payoutId) : evidence;
    const { invoice } = r.commitment;
    if (receipt?.ok && receipt.finalized && receipt.chain === invoice.chain &&
      receipt.from === invoice.taker && receipt.to === invoice.recipient && receipt.token === invoice.buy &&
      receipt.amount === invoice.buyAmount && sameTransaction(receipt.tx, r.payout)) {
      this.move(r, 'paid');
    } else if (r.state === 'payout_broadcast') {
      this.move(r, 'needs_reconciliation');
    }
  }
  close() { this.db.close(); }
}
