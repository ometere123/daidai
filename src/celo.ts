import { createPublicClient, http, decodeEventLog, erc20Abi, toHex, type Hex } from 'viem';
import { celo } from 'viem/chains';
import { estimateTotalFee } from 'viem/op-stack';
import type { Receipt, Tx } from './invoice.ts';

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type ReadCall = { from: string; to: string; data: Hex; value: '0x0' };
type Log = { address: string; data: Hex; topics: [Hex, ...Hex[]]; removed?: boolean; transactionHash?: Hex; blockHash?: Hex; logIndex?: Hex };
type Block = { number: Hex; hash: Hex };
type Transaction = { hash: Hex; blockHash: Hex; blockNumber: Hex; chainId: Hex; from: string; to: string; input: Hex; value: Hex; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
type ChainReceipt = { transactionHash: Hex; blockHash: Hex; blockNumber: Hex; from: string; to: string; status: Hex; logs: Log[] };
export type Settlement = { action: 'swap' | 'payout'; hash: Hex; sender: string; recipient: string; buyToken: string; sellToken: string; amount: bigint; debit: bigint; tx: Tx; bounds: { nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };
export type FeeCeilings = { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; totalWei: bigint; rollupReserveWei: bigint };
const evidence = new WeakMap<object, { receipt: Receipt; hash: Hex }>();
export type VerifiedSettlement = { readonly receipt: Receipt; readonly hash: Hex };
export function verified(value: VerifiedSettlement) { return evidence.get(value); }
const equal = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const hashPattern = /^0x[\da-f]{64}$/i;
function quantity(value: unknown) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw Error('invalid RPC quantity');
  return BigInt(value);
}

function movements(logs: Log[], plan: Pick<Settlement, 'sender' | 'recipient' | 'buyToken' | 'sellToken' | 'action'>) {
  let debit = 0n;
  let received = 0n;
  let unexpected = false;
  for (const log of logs) {
    if (log.removed) throw Error('removed RPC log');
    const buy = equal(log.address, plan.buyToken);
    if (!buy && !equal(log.address, plan.sellToken)) continue;
    if (!equal(log.topics[0], '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')) continue;
    const { args: { from, to, value } } = decodeEventLog({
      abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics, strict: true,
    });
    const outgoing = equal(from, plan.sender);
    const incoming = equal(to, plan.sender);
    if (plan.action === 'swap') {
      if (buy && incoming && !outgoing) received += value;
      else if (!buy && outgoing && !incoming) debit += value;
      else if (incoming || outgoing) unexpected = true;
    } else if (buy && outgoing && equal(to, plan.recipient) && !incoming) {
      received += value;
    } else if (incoming || outgoing || (buy && equal(to, plan.recipient))) unexpected = true;
  }
  return { debit, received, unexpected };
}

export class CeloReader {
  readonly #rpc: Rpc;
  readonly #estimateTotal: (call: ReadCall) => Promise<bigint>;

  constructor(rpc: Rpc, estimateTotal: (call: ReadCall) => Promise<bigint>) {
    this.#rpc = rpc;
    this.#estimateTotal = estimateTotal;
  }

  async #checkChain() {
    if (await this.#rpc('eth_chainId', []) !== '0xa4ec') throw Error('untrusted RPC chain');
  }

  async verifySettlement(plan: Settlement): Promise<VerifiedSettlement | undefined> {
    if (!hashPattern.test(plan.hash) || plan.tx.chainId !== 42220) return;
    await this.#checkChain();
    const tx = await this.#rpc('eth_getTransactionByHash', [plan.hash]) as Transaction | null;
    const receipt = await this.#rpc('eth_getTransactionReceipt', [plan.hash]) as ChainReceipt | null;
    if (!tx || !receipt || !equal(tx.hash, plan.hash) || !equal(receipt.transactionHash, plan.hash) ||
      tx.chainId !== '0xa4ec' || !equal(tx.from, plan.sender) || !equal(receipt.from, plan.sender) ||
      !equal(tx.to, plan.tx.to) || !equal(receipt.to, plan.tx.to) || !equal(tx.input, plan.tx.data) ||
      quantity(tx.value) !== BigInt(plan.tx.value) || tx.nonce !== plan.bounds.nonce ||
      quantity(tx.gas) > quantity(plan.bounds.gas) || quantity(tx.maxFeePerGas) > quantity(plan.bounds.maxFeePerGas) ||
      quantity(tx.maxPriorityFeePerGas) > quantity(plan.bounds.maxPriorityFeePerGas) || receipt.status !== '0x1' ||
      !hashPattern.test(receipt.blockHash) || !equal(tx.blockHash, receipt.blockHash) ||
      tx.blockNumber !== receipt.blockNumber) return;
    const finalized = await this.#rpc('eth_getBlockByNumber', ['finalized', false]) as Block | null;
    const canonical = await this.#rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) as Block | null;
    if (!canonical || !finalized || canonical.number !== receipt.blockNumber ||
      !equal(canonical.hash, receipt.blockHash) || quantity(finalized.number) < quantity(receipt.blockNumber)) return;
    const indices = new Set<string>();
    for (const log of receipt.logs) {
      if (!equal(log.transactionHash, plan.hash) || !equal(log.blockHash, receipt.blockHash) ||
        typeof log.logIndex !== 'string' || indices.has(log.logIndex)) return;
      indices.add(log.logIndex);
    }
    const { debit, received, unexpected } = movements(receipt.logs, plan);
    if (unexpected || debit !== plan.debit || received !== plan.amount) return;
    const result = Object.freeze({ hash: plan.hash, receipt: Object.freeze({
      ok: true, finalized: true, chain: 42220, from: plan.sender, to: plan.recipient,
      token: plan.buyToken, amount: received.toString(), debit: debit.toString(),
      tx: Object.freeze({ ...plan.tx }),
    }) });
    evidence.set(result, result);
    return result;
  }

  async preflight(call: ReadCall, ceilings: FeeCeilings, swap?: Pick<Settlement,
    'sender' | 'recipient' | 'buyToken' | 'sellToken' | 'action' | 'amount' | 'debit'>) {
    const limits = { ...ceilings };
    if (limits.gas <= 0n || limits.maxFeePerGas <= 0n || limits.maxPriorityFeePerGas < 0n ||
      limits.maxPriorityFeePerGas > limits.maxFeePerGas || limits.rollupReserveWei < 0n ||
      limits.gas * limits.maxFeePerGas + limits.rollupReserveWei > limits.totalWei) throw Error('invalid gas or fee ceilings');
    await this.#checkChain();
    if (await this.#rpc('eth_getCode', [call.from, 'latest']) !== '0x') throw Error('smart or delegated wallet unsupported');
    const fees = { gas: toHex(limits.gas), maxFeePerGas: toHex(limits.maxFeePerGas),
      maxPriorityFeePerGas: toHex(limits.maxPriorityFeePerGas) };
    const unsigned = { ...call, ...fees };
    const estimate = quantity(await this.#rpc('eth_estimateGas', [unsigned]));
    const block = await this.#rpc('eth_getBlockByNumber', ['latest', false]) as { baseFeePerGas: Hex };
    if (estimate === 0n || estimate > limits.gas ||
      quantity(block.baseFeePerGas) + limits.maxPriorityFeePerGas > limits.maxFeePerGas ||
      await this.#estimateTotal(call) > limits.totalWei) throw Error('gas or fee ceiling exceeded');
    if (quantity(await this.#rpc('eth_getBalance', [call.from, 'latest'])) < limits.totalWei) throw Error('insufficient native gas balance');
    const callResult = await this.#rpc('eth_call', [unsigned, 'latest']);
    if (typeof callResult !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(callResult) ||
      callResult === '0x' + '00'.repeat(32)) throw Error('unsuccessful eth_call');
    if (swap) {
      const simulation = await this.#rpc('eth_simulateV1', [{
        blockStateCalls: [{ calls: [unsigned] }], validation: true,
      }, 'latest']) as { calls: { status: Hex; logs: Log[] }[] }[];
      const simulated = simulation[0]?.calls?.[0];
      if (simulation.length !== 1 || simulation[0]?.calls.length !== 1 || simulated?.status !== '0x1') throw Error('swap simulation unavailable');
      const result = movements(simulated.logs, swap);
      if (result.unexpected || result.debit !== swap.debit || result.received !== swap.amount) throw Error('swap simulation mismatch');
    }
    const nonce = toHex(quantity(await this.#rpc('eth_getTransactionCount', [call.from, 'pending'])));
    return { ...fees, nonce };
  }
}

// Only trusted server configuration supplies this URL. The browser never supplies receipt fields or RPC endpoints.
export function celoReader(url: string) {
  if (new URL(url).protocol !== 'https:') throw Error('Celo RPC must use HTTPS');
  const client = createPublicClient({ chain: celo, transport: http(url, { timeout: 10_000, retryCount: 0 }) });
  return new CeloReader((method, params) => client.request({ method, params } as never),
    call => estimateTotalFee(client, { account: call.from as Hex, to: call.to as Hex,
      data: call.data, value: 0n }));
}
