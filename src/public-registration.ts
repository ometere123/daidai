import { createCeloRpc } from './celo-rpc.ts';
import { registry, verifyTag } from './invoice-core.ts';
import type { Rpc } from './chain-evidence.ts';

export const registration = Object.freeze({
  agent: 10103, chain: 42220, wallet: '0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e', registry,
  hash: '0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b',
});
const hash = /^0x[0-9a-f]{64}$/i;
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const obj = (v: unknown) => v && typeof v === 'object' ? v as Record<string, unknown> : {};
const hex = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b;

export async function observeRegistration(sources: Readonly<Record<string, Rpc>>, clock: () => number = Date.now) {
  const providers = await Promise.all(Object.entries(sources).map(async ([name, read]) => {
    try {
      const [chain, txValue, receiptValue, finalValue] = await Promise.all([
        read('eth_chainId', []), read('eth_getTransactionByHash', [registration.hash]), read('eth_getTransactionReceipt', [registration.hash]), read('eth_getBlockByNumber', ['finalized', false]),
      ]);
      const tx = obj(txValue), receipt = obj(receiptValue), finalized = obj(finalValue);
      if (chain !== '0xa4ec') return { name, kind: 'wrong chain' } as const;
      if (!txValue || !receiptValue) return { name, kind: 'missing transaction or receipt' } as const;
      const height = receipt.blockNumber, blockHash = receipt.blockHash, head = finalized.number;
      if (!hex(height, quantity) || !hex(head, quantity) || !hex(blockHash, hash) || !hex(finalized.hash, hash) ||
          tx.blockNumber !== height || tx.blockHash !== blockHash || !same(tx.hash, registration.hash) ||
          !same(receipt.transactionHash, registration.hash) || receipt.status !== '0x1' ||
          !same(tx.from, registration.wallet) || !same(receipt.from, registration.wallet) || !same(tx.to, registry) || !same(receipt.to, registry) ||
          tx.value !== '0x0' || typeof tx.input !== 'string') return { name, kind: 'inconsistent receipt' } as const;
      verifyTag(tx.input as `0x${string}`, 'celo_597f1146c487');
      const agentTopic = '0x' + registration.agent.toString(16).padStart(64, '0');
      const ownerTopic = '0x' + registration.wallet.slice(2).padStart(64, '0');
      const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
      const minted = logs.filter(value => {
        const log = obj(value), topics = log.topics;
        return same(log.address, registry) && same(log.transactionHash, registration.hash) && same(log.blockHash, blockHash.toLowerCase()) &&
          log.removed !== true && log.data === '0x' && Array.isArray(topics) && topics.length === 4 &&
          topics[0] === transfer && topics[1] === '0x' + '0'.repeat(64) && topics[2] === ownerTopic && topics[3] === agentTopic;
      });
      if (minted.length !== 1) return { name, kind: 'identity event unavailable' } as const;
      const first = obj(await read('eth_getBlockByNumber', [height, false]));
      const second = obj(await read('eth_getBlockByNumber', [height, false]));
      if (first.hash !== blockHash || second.hash !== blockHash || first.number !== height || second.number !== height) return { name, kind: 'canonical blocks disagree' } as const;
      if (BigInt(head) < BigInt(height)) return { name, kind: 'not finalized' } as const;
      return { name, kind: 'finalized registration', height, blockHash, head } as const;
    } catch { return { name, kind: 'provider unavailable' } as const; }
  }));
  const first = providers[0];
  const agreed = providers.length >= 2 && first?.kind === 'finalized registration' && providers.every(p =>
    p.kind === 'finalized registration' && p.blockHash === first.blockHash && p.height === first.height);
  return { observedAt: clock(), status: agreed ? 'independently verified' : 'unresolved', providers };
}
export const observePublicRegistration = () => observeRegistration({
  Forno: createCeloRpc({ url: 'https://forno.celo.org', timeoutMs: 4_000, maxBytes: 256_000 }),
  Ankr: createCeloRpc({ url: 'https://rpc.ankr.com/celo', timeoutMs: 4_000, maxBytes: 256_000 }),
});
