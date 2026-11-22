import { spawn } from 'node:child_process';
import { accountTransferLogs } from '../src/celo.ts';

const demo = 'https://docs-demo.celo-mainnet.quiknode.pro/';
const endpoint = process.env.DAIDAI_CELO_RPC_URL ?? (process.argv.includes('--forno') ? 'https://forno.celo.org' :
  process.argv.includes('--publicnode') ? 'https://celo-rpc.publicnode.com' : demo);
const label = process.env.DAIDAI_CELO_RPC_URL ? 'configured endpoint (redacted)' : endpoint;
const sender = '0x000000000000000000000000000000000000d101';
const maker = '0x000000000000000000000000000000000000d102';
const target = '0x000000000000000000000000000000000000d103';
const sellToken = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e';
const buyToken = '0xf6829d7393dae24509eb1e52ee8e572e2e271a4f';
const debit = 1100220n;
const amount = 1500000000n;
let id = 0;
const curl = process.argv.includes('--curl');
if (curl && process.env.DAIDAI_CELO_RPC_URL) throw Error('Curl mode is limited to the built-in public endpoints.');

function publicCurl(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl',
      ['--silent', '--max-time', '15', '--write-out', '\n%{http_code}', '-H', 'Content-Type: application/json',
        '--data-binary', '@-', endpoint], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(Error('public curl request failed')); return; }
      const split = output.lastIndexOf('\n');
      try { resolve({ status: Number(output.slice(split + 1)), body: JSON.parse(output.slice(0, split)) }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(body);
  });
}

async function request(method, params) {
  try {
    if (new URL(endpoint).protocol !== 'https:') return { failure: 'HTTPS required' };
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params, id: ++id });
    const answer = curl ? await publicCurl(payload) : await (async () => {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: payload, signal: AbortSignal.timeout(10000), redirect: 'error' });
      return { status: r.status, body: await r.json() };
    })();
    // Provider messages may contain credential-bearing URLs. Output codes only.
    return { http: answer.status, errorCode: Number.isInteger(answer.body.error?.code) ? answer.body.error.code : undefined, result: answer.body.result };
  } catch (error) {
    const code = error?.cause?.code;
    return { failure: /^[A-Z0-9_]{1,40}$/.test(code ?? '') ? code : 'network or response failure' };
  }
}
let queue = Promise.resolve();
function rpc(method, params) {
  const result = queue.then(async () => {
    const response = await request(method, params);
    if (response.http !== 429) return response;
    await new Promise(resolve => setTimeout(resolve, 2000));
    return request(method, params);
  });
  queue = result.then(() => new Promise(resolve => setTimeout(resolve, 500)));
  return result;
}
const summary = ({ result, ...status }, fields) => ({ ...status, result: fields });
const word = text => text.replace(/^0x/, '').padStart(64, '0');
const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// The overrides install LOG3-only runtimes. No token storage is read or changed.
const emitter = (from, to, quantity) => '0x7f' + word(quantity.toString(16)) + '6000527f' +
  word(to) + '7f' + word(from) + '7f' + transferTopic + '60206000a300';
const callEmitter = token => '6000600060006000600073' + token.slice(2) + '61fffff150';

const [chain, finalized, latest] = await Promise.all([
  rpc('eth_chainId', []), rpc('eth_getBlockByNumber', ['finalized', true]), rpc('eth_getBlockByNumber', ['latest', false]),
]);
const block = finalized.result;
const tx = block?.transactions?.find(tx => tx.type === '0x2' && tx.chainId === '0xa4ec') ??
  block?.transactions?.find(tx => tx.chainId === '0xa4ec');
const call = { from: sender, to: target, value: '0x0', data: '0x', gas: '0x30d40',
  maxFeePerGas: '0x' + (BigInt(latest.result?.baseFeePerGas ?? '0x1') * 2n + 1n).toString(16), maxPriorityFeePerGas: '0x1' };
const [simple, sim, canonical, lookup, receipt] = await Promise.all([
  rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ to: sellToken, data: '0x313ce567' }] }], validation: true }, 'latest']),
  rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [call], stateOverrides: {
    [sender]: { balance: '0xde0b6b3a7640000' },
    [target]: { code: '0x' + callEmitter(sellToken) + callEmitter(buyToken) + '00' },
    [sellToken]: { code: emitter(sender, maker, debit) }, [buyToken]: { code: emitter(maker, sender, amount) },
  } }], validation: true }, 'latest']),
  block ? rpc('eth_getBlockByNumber', [block.number, false]) : Promise.resolve({}),
  tx ? rpc('eth_getTransactionByHash', [tx.hash]) : Promise.resolve({}),
  tx ? rpc('eth_getTransactionReceipt', [tx.hash]) : Promise.resolve({}),
]);
const calls = sim.result?.[0]?.calls;
let account;
let rejectsAlteredLogs = false;
if (sim.result?.length === 1 && calls?.length === 1 && calls[0].status === '0x1' && Array.isArray(calls[0].logs)) {
  try {
    const plan = { action: 'swap', sender, recipient: sender, buyToken, sellToken };
    account = accountTransferLogs(calls[0].logs, plan);
    const altered = accountTransferLogs(calls[0].logs.slice(0, 1), plan);
    rejectsAlteredLogs = altered.received !== amount || altered.debit !== debit || altered.unexpected;
  } catch { account = undefined; }
}
const readPass = chain.result === '0xa4ec' && !!block?.hash && block.hash === canonical.result?.hash &&
  !!tx && lookup.result?.hash === tx.hash && lookup.result.chainId === '0xa4ec' &&
  lookup.result.blockHash === block.hash && receipt.result?.blockHash === block.hash &&
  receipt.result.transactionHash === tx.hash && ['0x1', '0x0'].includes(receipt.result.status);
const blockAge = value => value?.timestamp ? Math.floor(Date.now() / 1000) - Number(BigInt(value.timestamp)) : null;
const finalizedAgeSeconds = blockAge(block);
const latestAgeSeconds = blockAge(latest.result);
// Qualification rejects stale or future-dated snapshots, even when the endpoint is internally consistent.
const fresh = finalizedAgeSeconds !== null && finalizedAgeSeconds >= -30 && finalizedAgeSeconds <= 4 * 3600 &&
  latestAgeSeconds !== null && latestAgeSeconds >= -30 && latestAgeSeconds <= 300;
const simulationPass = simple.result?.[0]?.calls?.[0]?.status === '0x1' &&
  BigInt(simple.result[0].calls[0].returnData) === 6n && account?.debit === debit &&
  account.received === amount && !account.unexpected && rejectsAlteredLogs;
console.log(JSON.stringify({
  utc: new Date().toISOString(), endpoint: label, readPass, simulationPass, fresh, finalizedAgeSeconds, latestAgeSeconds,
  chain, finalized: summary(finalized, block && { hash: block.hash, number: block.number }),
  canonical: summary(canonical, canonical.result?.hash),
  lookup: summary(lookup, lookup.result && { hash: lookup.result.hash, chainId: lookup.result.chainId,
    blockHash: lookup.result.blockHash, type: lookup.result.type }),
  receipt: summary(receipt, receipt.result && { hash: receipt.result.transactionHash,
    blockHash: receipt.result.blockHash, status: receipt.result.status, logs: receipt.result.logs?.length }),
  decimals: summary(simple, simple.result?.[0]?.calls?.[0]),
  simulation: summary(sim, calls && calls.map(c => ({ status: c.status, logs: c.logs, errorCode: c.error?.code }))),
  account, rejectsAlteredLogs,
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
process.exitCode = readPass && simulationPass && fresh ? 0 : 2;
