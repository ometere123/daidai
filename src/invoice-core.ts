/**
 * Worker-safe invoice core (P10.4): corridor constants, validation, commitment and attribution.
 * No node:sqlite or other Node-only storage, so it loads in Cloudflare Workers (with nodejs_compat for node:crypto)
 * as well as in Node. invoice.ts re-exports everything here, so existing imports are unchanged.
 */
import { createHash } from 'node:crypto';
import { fromDataSuffix, toDataSuffix } from '@celo/attribution-tags';
import type { Hex } from 'viem';

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
