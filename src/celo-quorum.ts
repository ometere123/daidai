import { readOnlyRpc, type Rpc } from './chain-evidence.ts';

const hash = /^0x[0-9a-f]{64}$/i;
const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
type Block = { number: string; hash: string; timestamp: string };

function block(value: unknown): Block {
  const b = value as Block | null;
  if (!b || !quantity.test(b.number) || !hash.test(b.hash) || !quantity.test(b.timestamp)) throw Error('invalid block');
  return { number: b.number.toLowerCase(), hash: b.hash.toLowerCase(), timestamp: b.timestamp.toLowerCase() };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}
function agreed<T>(items: readonly T[]): T {
  if (items[0] === null || items[0] === undefined || items.some(v => stable(v) !== stable(items[0]))) throw Error('providers disagree or evidence unavailable');
  return items[0];
}

/** Conservative all-provider policy for owner review. Use genuinely independent upstreams. */
export function celoQuorum(providers: readonly Rpc[]): Rpc {
  if (providers.length < 2 || new Set(providers).size !== providers.length) throw Error('independent providers required');
  const readers = providers.map(readOnlyRpc);
  return readOnlyRpc(async (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') {
      const heads = (await Promise.all(readers.map(read => read(method, params)))).map(block);
      const min = heads.reduce((a, b) => BigInt(a.number) < BigInt(b.number) ? a : b);
      const canonical = agreed((await Promise.all(readers.map(read => read(method, [min.number, false])))).map(block));
      if (canonical.number !== min.number || heads.some(head => head.number === min.number && head.hash !== canonical.hash)) throw Error('finalized head mismatch');
      return canonical;
    }
    const items = await Promise.all(readers.map(read => read(method, params)));
    if (method === 'eth_chainId' && items.some(v => v !== '0xa4ec')) throw Error('wrong chain');
    if (method === 'eth_getBlockByNumber') return agreed(items.map(block));
    return agreed(items);
  });
}
