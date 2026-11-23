// Public, non-spending connectivity and finality probe using immutable P08 evidence.
import { createCeloRpc } from '../src/celo-rpc.ts';
import { chain, registry, verifyTag } from '../src/invoice-core.ts';

const hash = '0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b';
const rpc = createCeloRpc({ url: 'https://forno.celo.org', timeoutMs: 8000 });
let phase = 'chain';
try {
  const chainId = await rpc('eth_chainId', []);
  if (typeof chainId !== 'string' || BigInt(chainId) !== BigInt(chain)) throw Error('chain mismatch');
  phase = 'registration-transaction';
  const tx = await rpc('eth_getTransactionByHash', [hash]);
  phase = tx ? 'registration-receipt' : 'historical-transaction-unavailable';
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (!tx || !receipt || tx.hash !== hash || receipt.transactionHash !== hash || tx.to?.toLowerCase() !== registry ||
      tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || receipt.status !== '0x1') throw Error('registration evidence mismatch');
  phase = 'canonical-finality';
  const canonical = await rpc('eth_getBlockByNumber', [tx.blockNumber, false]);
  const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (canonical?.hash !== tx.blockHash || canonical?.number !== tx.blockNumber ||
      typeof finalized?.number !== 'string' || BigInt(finalized.number) < BigInt(tx.blockNumber)) throw Error('canonical finality unavailable');
  phase = 'attribution';
  verifyTag(tx.input, 'celo_597f1146c487');
  console.log(JSON.stringify({ result: 'PASS', chain, receiptHeight: Number(BigInt(tx.blockNumber)), finalizedHeight: Number(BigInt(finalized.number)), evidence: 'registration-only' }));
} catch (err) {
  const code = err instanceof Error && 'code' in err ? err.code : 'invalid-or-unavailable-evidence';
  console.log(JSON.stringify({ result: 'BLOCKED', phase, code }));
  process.exitCode = 1;
}
