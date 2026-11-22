import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
import { CeloReader } from '../src/celo.ts';
import { cngn, usdt, type Tx } from '../src/invoice.ts';

export const origin = 'http://127.0.0.1:4321';
export const feeLimits = { gas: 100_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
  totalWei: 1_100_000n, rollupReserveWei: 100_000n };
export const feeFields = { gas: '0x186a0', maxFeePerGas: '0xa', maxPriorityFeePerGas: '0x1', nonce: '0x0' } as const;
export const blockHash: Hex = `0x${'33'.repeat(32)}`;
export const transactionHash: Hex = `0x${'11'.repeat(32)}`;

export function transfer(token: string, from: Hex, to: Hex, amount: bigint) {
  return { address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]) };
}

export function readFixture(sender: Hex, maker: Hex, amount: bigint, debit: bigint) {
  const transactions = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const state = { code: '0x', simulatedDebit: debit, gas: '0x5208', finalized: '0x3', blockHash, chain: '0xa4ec', fee: 500_000n };
  const calls: string[] = [];
  const tradeLogs = (payment: bigint, buy = amount) => [transfer(usdt, sender, maker, payment), transfer(cngn, maker, sender, buy)];
  const reader = new CeloReader(async (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId': return state.chain;
      case 'eth_getCode': return state.code;
      case 'eth_getTransactionByHash': return transactions.get(String(params[0])) ?? null;
      case 'eth_getTransactionReceipt': return receipts.get(String(params[0])) ?? null;
      case 'eth_getBlockByNumber': return { number: params[0] === 'finalized' ? state.finalized : '0x2',
        hash: state.blockHash, baseFeePerGas: '0x1' };
      case 'eth_getTransactionCount': return feeFields.nonce;
      case 'eth_estimateGas': return state.gas;
      case 'eth_getBalance': return '0x200000';
      case 'eth_call': return '0x';
      case 'eth_simulateV1': return [{ calls: [{ status: '0x1', logs: tradeLogs(state.simulatedDebit) }] }];
      default: throw Error('unexpected RPC method');
    }
  }, async () => state.fee);
  function mine(hash: Hex, tx: Tx, recipient: Hex, buy = amount) {
    transactions.set(hash, { hash, blockHash, blockNumber: '0x2', chainId: '0xa4ec',
      from: sender, to: tx.to, input: tx.data, value: '0x0', ...feeFields });
    const logs = recipient === sender ? tradeLogs(debit, buy) : [transfer(cngn, sender, recipient, buy)];
    receipts.set(hash, { transactionHash: hash, blockHash, blockNumber: '0x2', status: '0x1',
      from: sender, to: tx.to, logs: logs.map((log, index) => ({ ...log, transactionHash: hash, blockHash, logIndex: '0x' + index.toString(16) })) });
  }
  return { reader, state, transactions, receipts, mine, calls };
}
