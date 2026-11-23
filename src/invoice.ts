import { isVerifiedAuthorization, type VerifiedAuthorization } from './authorization.ts';
import { verified, type VerifiedSettlement } from './celo.ts';
import { DatabaseSync } from 'node:sqlite';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';

import { chain, usdt, cngn, reactor, registry, check, address, atomic, commit, tag, verifyTag, type Invoice } from './invoice-core.ts';
export { chain, usdt, cngn, reactor, registry, check, address, atomic, commit, tag, verifyTag };
export type { Invoice };

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
  authorizeVerified(id: string, proof: VerifiedAuthorization, now: number) {
    const r = this.read(id);
    const { invoice, digest } = r.commitment;
    check(isVerifiedAuthorization(proof) && proof.digest === digest && proof.approver === invoice.approver &&
      proof.recipient === invoice.recipient && proof.expires === invoice.expires && now < proof.expires,
      'verified authorization required');
    this.move(r, 'authorized', {
      approval: { digest, approver: proof.approver },
      consent: { digest, recipient: proof.recipient, evidence: 'verified EIP-712 recipient consent' },
    });
  }
  authorize(id: string, approval: Approval, consent: Consent | undefined, now: number) {
    check(this.wallet, 'synthetic authorization is restricted to the mock chain');
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
  reconcileSwap(id: string, report: 'failed' | 'expired' | 'filled', evidence?: VerifiedSettlement | null) {
    const r = this.read(id);
    check(r.swapId && r.swap && !r.payoutId &&
      (r.state === 'swap_broadcast' || r.state === 'needs_reconciliation'), 'no unsettled swap');
    const receipt = evidence === undefined ? this.wallet?.receipt(r.swapId) : evidence ? verified(evidence)?.receipt : undefined;
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
  reconcilePayout(id: string, evidence?: VerifiedSettlement | null) {
    const r = this.read(id);
    check(r.payoutId && r.payout && (r.state === 'payout_broadcast' || r.state === 'needs_reconciliation'), 'no unsettled payout');
    const receipt = evidence === undefined ? this.wallet?.receipt(r.payoutId) : evidence ? verified(evidence)?.receipt : undefined;
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
