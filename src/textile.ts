import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData,
  erc20Abi, parseAbi, parseAbiParameters, type Hex,
} from 'viem';
import { address, atomic, chain, check, reactor, type Invoice, type Quote, type Tx } from './invoice.ts';

export const reactorAbi = parseAbi([
  'function execute((bytes order, bytes sig) order) payable',
  'function executeBatch((bytes order, bytes sig)[] orders) payable',
]);
export const orderAbi = parseAbiParameters(
  '((address reactor, address swapper, uint256 nonce, uint256 deadline, address validator, bytes validation) info, (address token, uint256 amount, uint256 maxAmount) input, (address token, uint256 amount, address recipient)[] outputs) order',
);
export const fillerAbi = parseAbiParameters('address[] fillers, uint256 exclusiveUntil');
export const preferredFiller = '0x10b9eba3a175df418a35cb8329a527691ee258c5';

function object(value: unknown): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid Textile object');
  return value as Record<string, unknown>;
}

function string(value: unknown) {
  check(typeof value === 'string', 'invalid Textile string');
  return value;
}

function timestamp(value: unknown) {
  const iso = string(value);
  const millis = Date.parse(iso);
  check(Number.isFinite(millis) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(iso), 'invalid Textile timestamp');
  const canonical = iso.replace(/(?:\.(\d{1,3}))?Z$/, (_, digits: string | undefined) =>
    '.' + (digits ?? '').padEnd(3, '0') + 'Z');
  check(new Date(millis).toISOString() === canonical, 'invalid Textile calendar date');
  return millis;
}

function hex(value: unknown): Hex {
  check(typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(value), 'invalid Textile calldata');
  return value.toLowerCase() as Hex;
}

function transaction(value: unknown, target: string): Tx {
  const tx = object(value);
  check(tx.chainId === chain && tx.value === '0' && address(string(tx.to)) === target, 'wrong Textile transaction envelope');
  return { to: target, chainId: chain, value: '0', data: hex(tx.data) };
}

export function exactOutRequest(invoice: Invoice) {
  return Object.freeze({
    chainId: chain, sellToken: invoice.sell, buyToken: invoice.buy,
    buyAmount: invoice.buyAmount, taker: invoice.taker,
  });
}

export function parseTextileQuote(body: unknown, invoice: Invoice): Quote | { status: 'no_quote' } {
  const data = object(object(body).data);
  if (data.status === 'no_quote') return { status: 'no_quote' };
  check(data.status === 'quoted' && data.route === undefined && data.attributionSuffix == null,
    'unsupported Textile quote route or attribution');
  const q = object(data.quote);
  check(address(string(q.taker)) === invoice.taker && address(string(q.reactor)) === reactor &&
    (q.spender === undefined || address(string(q.spender)) === reactor), 'wrong Textile taker or spender');
  const txs = object(data.transactions);
  const approval = transaction(txs.approval, invoice.sell);
  const swap = transaction(txs.swap, reactor);
  const buyAmount = string(q.buyAmount);
  const takerPays = string(q.takerPays);
  const feeAmount = string(q.feeAmount);
  const debit = atomic(takerPays);
  const fee = atomic(feeAmount);
  check(atomic(buyAmount) === atomic(invoice.buyAmount), 'wrong exact output');
  check(debit > fee && debit <= atomic(invoice.maxSell), 'debit cap');
  check(approval.data === encodeFunctionData({ abi: erc20Abi, functionName: 'approve',
    args: [reactor, debit] }), 'incorrect Textile approval calldata');

  const call = decodeFunctionData({ abi: reactorAbi, data: swap.data });
  check(encodeFunctionData({ abi: reactorAbi, ...call }) === swap.data, 'noncanonical swap calldata');
  const orders = call.functionName === 'execute' ? [call.args[0]] : call.args[0];
  check(orders.length > 0, 'empty Textile batch');
  let signedDebit = 0n;
  let signedBuy = 0n;
  const orderDeadline = timestamp(q.orderDeadline);
  const latestDeadline = timestamp(q.latestOrderDeadline);
  const expiresAt = timestamp(q.expiresAt);
  let earliest: bigint | undefined;
  let latest = 0n;
  const permits = new Set<string>();
  for (const { order, sig } of orders) {
    const [decoded] = decodeAbiParameters(orderAbi, order);
    const { info, input, outputs } = decoded;
    check(encodeAbiParameters(orderAbi, [decoded]).toLowerCase() === order.toLowerCase() &&
      sig.length > 2, 'invalid signed order encoding');
    check(address(info.reactor) === reactor && address(info.validator) === preferredFiller, 'unverified order validator');
    const [fillers, exclusiveUntil] = decodeAbiParameters(fillerAbi, info.validation);
    check(fillers.length === 1 && address(fillers[0]) === invoice.taker &&
      exclusiveUntil >= info.deadline, 'signed order not restricted to taker');
    const permit = address(info.swapper) + ':' + info.nonce;
    check(!permits.has(permit), 'duplicate maker permit');
    permits.add(permit);
    check(address(input.token) === invoice.buy && input.amount > 0n && input.amount <= input.maxAmount &&
      outputs.length > 0, 'wrong signed input token or amount');
    signedBuy += input.amount;
    for (const output of outputs) {
      check(address(output.token) === invoice.sell && output.amount > 0n, 'wrong signed output token or amount');
      address(output.recipient);
      signedDebit += output.amount;
    }
    earliest = earliest === undefined || info.deadline < earliest ? info.deadline : earliest;
    if (info.deadline > latest) latest = info.deadline;
  }
  check(signedBuy === atomic(buyAmount) && signedDebit + fee === debit, 'signed order totals differ from quote');
  check(earliest! * 1000n === BigInt(orderDeadline) && latest * 1000n === BigInt(latestDeadline) &&
    expiresAt <= orderDeadline, 'signed deadlines differ from quote');
  return {
    status: 'quoted', chain, sell: invoice.sell, buy: invoice.buy, taker: invoice.taker,
    buyAmount, takerPays, feeAmount, expiresAt, orderDeadline, transactions: { approval, swap },
  };
}
