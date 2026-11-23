import { createCeloRpc } from '../src/celo-rpc.ts';
import { registry, verifyTag } from '../src/invoice-core.ts';

const hash = '0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b';
const sender = '0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e';
const sources = { forno: 'https://forno.celo.org', drpc: 'https://celo.drpc.org/', ankr: 'https://rpc.ankr.com/celo', community: 'https://rpc.celo-community.org' };
const results = await Promise.all(Object.entries(sources).map(async ([name, url]) => {
  const rpc = createCeloRpc({ url });
  const safe = async (method, params) => {
    try { return { value: await rpc(method, params) }; }
    catch (e) { return { error: e?.code ?? 'unavailable' }; }
  };
  const [chain, transaction, receipt, head] = await Promise.all([
    safe('eth_chainId', []), safe('eth_getTransactionByHash', [hash]), safe('eth_getTransactionReceipt', [hash]), safe('eth_getBlockByNumber', ['finalized', false]),
  ]);
  const t = transaction.value, r = receipt.value, f = head.value;
  const height = r?.blockNumber ?? t?.blockNumber;
  const canonical = height ? await safe('eth_getBlockByNumber', [height, false]) : {};
  const replay = height ? await safe('eth_getBlockByNumber', [height, false]) : {};
  const b = canonical.value;
  let valid = false;
  try {
    verifyTag(t.input, 'celo_597f1146c487');
    valid = chain.value === '0xa4ec' && t.hash === hash && r.transactionHash === hash && r.status === '0x1' &&
      t.from.toLowerCase() === sender && r.from.toLowerCase() === sender && t.to.toLowerCase() === registry &&
      r.to.toLowerCase() === registry && BigInt(t.value) === 0n && t.blockNumber === r.blockNumber &&
      t.blockHash === r.blockHash && t.blockHash === b.hash && b.hash === replay.value.hash && b.number === height &&
      /^0x[0-9a-f]{64}$/i.test(f.hash) && BigInt(f.number) >= BigInt(height);
  } catch { /* incomplete provider evidence */ }
  return { name, valid, chain: chain.error ?? chain.value ?? 'missing', transaction: transaction.error ?? (t ? 'present' : 'missing'),
    receipt: receipt.error ?? (r ? 'present' : 'missing'), canonical: canonical.error ?? (b ? 'present' : 'missing'),
    finalized: head.error ?? f?.number ?? 'missing', height, blockHash: valid ? b.hash : undefined };
}));
const valid = results.filter(r => r.valid);
console.log(JSON.stringify({ evidence: 'P08 registration only', results,
  independentAgreement: valid.length >= 2 && new Set(valid.map(r => r.blockHash)).size === 1 }, null, 2));
