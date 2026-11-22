import { type CeloReader, type FeeCeilings } from './celo.ts';
import { verifyAuthorization, type SignedAuthorization } from './authorization.ts';
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';
import {
  address, atomic, chain, check, reactor, registry, tag, verifyTag,
  type Funds, type Spike, type Tx,
} from './invoice.ts';
import { exactOutRequest, parseTextileQuote } from './textile.ts';

export interface InjectedProvider {
  request(args: { method: string; params?: unknown[] }, deadline?: number): Promise<unknown>;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

const identityAbi = parseAbi(['function register(string agentURI) returns (uint256)']);
type Action = 'approval' | 'register' | 'swap' | 'payout';
type WalletRequest = Readonly<{ from: string; to: string; data: Hex; value: '0x0'; chainId: '0xa4ec' }>;
type Attempt = { status: string; hash: string | null; request: string };
type Prepared = Readonly<{ action: Action; request: WalletRequest; expires: number }>;
type Intent = { key: string; id?: string; revision?: number; funds?: Funds; raw: Tx; prepared: Prepared };

const walletEvents = ['accountsChanged', 'chainChanged', 'disconnect'];
const isHash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value);

export class WalletAdapter {
  readonly #sender: string;
  readonly #provider: InjectedProvider;
  readonly #spike: Spike;
  readonly #reader: CeloReader;
  readonly #fees: FeeCeilings;
  readonly #origin: string;
  readonly #timeoutMs: number;
  readonly #clock: () => number;
  readonly #prepared = new WeakMap<Prepared, Intent>();
  #invalidated = false;
  #busy = false;
  readonly #invalidate = () => { this.#invalidated = true; };

  constructor(options: {
    sender: string; provider: InjectedProvider; spike: Spike;
    reader: CeloReader; fees: FeeCeilings; origin: string;
    timeoutMs?: number; clock?: () => number;
  }) {
    this.#sender = address(options.sender);
    this.#provider = options.provider;
    this.#spike = options.spike;
    this.#reader = options.reader;
    this.#fees = Object.freeze({ ...options.fees });
    this.#origin = options.origin;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#clock = options.clock ?? Date.now;
    check(Number.isSafeInteger(this.#timeoutMs) && this.#timeoutMs > 0, 'invalid timeout');
    this.#spike.db.exec(`CREATE TABLE IF NOT EXISTS wallet_attempts (
      key TEXT PRIMARY KEY, sender TEXT NOT NULL, request TEXT NOT NULL,
      status TEXT NOT NULL, hash TEXT
    )`);
    for (const event of walletEvents) this.#provider.on(event, this.#invalidate);
  }

  dispose() {
    this.#invalidate();
    for (const event of walletEvents) this.#provider.removeListener(event, this.#invalidate);
  }

  async checkWallet() {
    check(!this.#invalidated, 'wallet session changed or disconnected');
    const accounts = await this.#provider.request({ method: 'eth_accounts' });
    const network = await this.#provider.request({ method: 'eth_chainId' });
    check(!this.#invalidated, 'wallet session changed or disconnected');
    check(Array.isArray(accounts) && typeof accounts[0] === 'string' &&
      address(accounts[0]) === this.#sender, 'wrong selected sender');
    check(network === '0xa4ec', 'wrong wallet chain');
    return this.#sender;
  }

  #invoice(id: string) {
    const r = this.#spike.read(id);
    check(r.commitment.invoice.taker === this.#sender, 'invoice taker differs from pinned wallet');
    check(this.#clock() < r.commitment.invoice.expires, 'invoice expired');
    return r;
  }

  async authorizeInvoice(id: string, proof: SignedAuthorization) {
    const { invoice, digest } = this.#invoice(id).commitment;
    const verified = await verifyAuthorization(invoice, digest, this.#origin, proof, this.#clock());
    this.#spike.authorizeVerified(id, verified, this.#clock());
  }

  async prepareRfq(id: string) {
    await this.checkWallet();
    const r = this.#invoice(id);
    check(r.state === 'authorized' || r.state === 'quote_pending', 'invoice cannot request a quote');
    return exactOutRequest(r.commitment.invoice);
  }

  acceptQuote(id: string, body: unknown, funds: Funds) {
    const r = this.#invoice(id);
    check(r.state === 'quote_pending', 'no pending quote');
    const quote = parseTextileQuote(body, r.commitment.invoice);
    const db = this.#spike.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#spike.receive(id, quote, this.#clock(), funds);
      if (quote.status === 'quoted') {
        db.prepare('INSERT INTO wallet_attempts VALUES (?, ?, ?, ?, NULL)').run(
          JSON.stringify(['quote', id]), this.#sender, JSON.stringify(quote), 'validated_quote');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  prepareApproval(id: string, limit: bigint) {
    const r = this.#invoice(id);
    const i = r.commitment.invoice;
    check(r.state === 'authorized', 'allowance must be prepared before firm quote');
    check(limit > 0n && limit <= atomic(i.maxSell), 'approval cap');
    return this.#prepare('approval', JSON.stringify(['approval', id]), i.sell,
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [reactor, limit] }),
      i.expires, id, r.revision);
  }

  prepareRegistration(uri: string, expires: number) {
    check(/^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(uri), 'invalid agent URI');
    check(Number.isSafeInteger(expires) && expires > this.#clock(), 'expired registration authorization');
    return this.#prepare('register', JSON.stringify(['register', this.#sender]), registry,
      encodeFunctionData({ abi: identityAbi, functionName: 'register', args: [uri] }), expires);
  }

  prepareSwap(id: string, funds: Funds) {
    const r = this.#invoice(id);
    check(r.state === 'quoted' && r.quote, 'swap already attempted or unavailable');
    this.#spike.validateQuote(r.commitment.invoice, r.quote, this.#clock(), funds);
    // Re-parse the original wire response via acceptQuote before using this adapter.
    const attested = this.attempt(JSON.stringify(['quote', id]));
    const tx = r.quote.transactions.swap;
    check(attested?.request === JSON.stringify(r.quote), 'quote was not validated by Textile adapter');
    return this.#prepare('swap', JSON.stringify(['swap', id]), tx.to, tx.data,
      Math.min(r.commitment.invoice.expires, r.quote.expiresAt, r.quote.orderDeadline), id, r.revision, funds);
  }

  preparePayout(id: string, funds: Funds) {
    const r = this.#invoice(id);
    const i = r.commitment.invoice;
    check(r.state === 'payout_pending', 'payout already claimed or unavailable');
    return this.#prepare('payout', JSON.stringify(['payout', id]), i.buy,
      encodeFunctionData({ abi: erc20Abi, functionName: 'transfer',
        args: [i.recipient as Hex, atomic(i.buyAmount)] }), i.expires, id, r.revision, funds);
  }

  #prepare(action: Action, key: string, to: string, data: Hex, expires: number,
    id?: string, revision?: number, funds?: Funds) {
    const raw = { to, data, value: '0', chainId: chain };
    const request = Object.freeze({
      from: this.#sender, to, data: tag(data, this.#spike.code), value: '0x0', chainId: '0xa4ec',
    } as const);
    const prepared = Object.freeze({ action, request, expires });
    this.#prepared.set(prepared, { key, id, revision, raw, prepared, funds: funds && { ...funds } });
    return prepared;
  }

  attempt(key: string) {
    return this.#spike.db.prepare('SELECT status, hash, request FROM wallet_attempts WHERE key = ?')
      .get(key) as Attempt | undefined;
  }

  #checkIntent(intent: Intent) {
    const { prepared, raw, id, revision } = intent;
    const { request, action, expires } = prepared;
    check(this.#clock() + (action === 'swap' ? 5_000 : 0) < expires, 'expired or insufficient quote headroom');
    check(request.from === this.#sender && request.chainId === '0xa4ec' && request.value === '0x0' &&
      request.to === raw.to && request.data === tag(raw.data, this.#spike.code), 'wallet request changed');
    verifyTag(request.data, this.#spike.code);
    if (id) check(this.#invoice(id).revision === revision, 'invoice changed after preparation');
  }

  // The caller presents the exact frozen request for human review before invoking this method.
  async submit(prepared: Prepared) {
    const intent = this.#prepared.get(prepared);
    check(intent && !this.#busy && !this.attempt(intent.key), 'duplicate or unrecognized wallet intent');
    this.#busy = true;
    try {
      await this.checkWallet();
      this.#checkIntent(intent);
      const r = prepared.action === 'swap' ? this.#invoice(intent.id!) : undefined;
      const fees = await this.#reader.preflight(prepared.request, this.#fees, r && {
        action: 'swap', sender: this.#sender, recipient: this.#sender,
        buyToken: r.commitment.invoice.buy, sellToken: r.commitment.invoice.sell,
        amount: atomic(r.quote!.buyAmount), debit: atomic(r.quote!.takerPays),
      });
      await this.checkWallet();
      this.#checkIntent(intent);
      const request = Object.freeze({ ...prepared.request, ...fees });
      this.#claim(intent, request);
      return await this.#dispatch(intent, request);
    } finally {
      this.#busy = false;
    }
  }

  #claim(intent: Intent, request: WalletRequest) {
    const db = this.#spike.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#checkIntent(intent);
      db.prepare('INSERT INTO wallet_attempts VALUES (?, ?, ?, ?, NULL)').run(
        intent.key, this.#sender, JSON.stringify(request), 'pending_wallet');
      if (intent.prepared.action === 'swap') {
        const { swap } = this.#spike.claimSwap(intent.id!, this.#clock(), intent.funds!);
        check(swap.data === intent.prepared.request.data, 'state claimed different swap bytes');
      }
      if (intent.prepared.action === 'payout') {
        this.#spike.claimTransfer(intent.id!, { ...intent.raw, data: intent.prepared.request.data },
          this.#clock(), intent.funds!);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  async #dispatch({ key, id, prepared }: Intent, request: WalletRequest) {
    const update = this.#spike.db.prepare('UPDATE wallet_attempts SET status = ?, hash = ? WHERE key = ?');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('wallet response timeout')), this.#timeoutMs);
      });
      const result = await Promise.race([timeout,
        this.#provider.request({ method: 'eth_sendTransaction', params: [request] }, Date.now() + Math.min(this.#timeoutMs, prepared.expires - this.#clock()))]);
      check(isHash(result), 'wallet response has no transaction hash');
      update.run('hash_returned', result.toLowerCase(), key);
      return { status: 'hash_returned' as const, hash: result };
    } catch (error) {
      const rejected = typeof error === 'object' && error !== null && 'code' in error && error.code === 4001;
      const status = rejected ? 'user_rejected' as const : 'needs_reconciliation' as const;
      update.run(status, null, key);
      if (prepared.action === 'swap') this.#spike.reconcileSwap(id!, 'failed', null);
      if (prepared.action === 'payout') this.#spike.reconcilePayout(id!, null);
      return { status };
    } finally {
      clearTimeout(timer);
    }
  }

  async reconcileSwap(id: string, report: 'failed' | 'expired' | 'filled') {
    let verified;
    try { verified = await this.#verify(id, 'swap'); }
    finally { this.#spike.reconcileSwap(id, report, verified ?? null); }
  }

  async reconcilePayout(id: string) {
    let verified;
    try { verified = await this.#verify(id, 'payout'); }
    finally { this.#spike.reconcilePayout(id, verified ?? null); }
  }

  async #verify(id: string, action: 'swap' | 'payout') {
    const attempt = this.attempt(JSON.stringify([action, id]));
    check(attempt, 'missing durable wallet intent');
    // The hash must already be tied to this exact wallet prompt. Provider/API hints are insufficient.
    if (!isHash(attempt.hash)) return;
    const r = this.#spike.read(id);
    const invoice = r.commitment.invoice;
    const tx = action === 'swap' ? r.swap : r.payout;
    check(tx && invoice.taker === this.#sender, 'persisted transaction mismatch');
    const bounds = JSON.parse(attempt.request);
    return this.#reader.verifySettlement({
      action, hash: attempt.hash, sender: this.#sender,
      recipient: action === 'swap' ? this.#sender : invoice.recipient,
      buyToken: invoice.buy, sellToken: invoice.sell, amount: atomic(invoice.buyAmount),
      debit: action === 'swap' ? atomic(r.quote!.takerPays) : 0n, tx, bounds,
    });
  }
}
