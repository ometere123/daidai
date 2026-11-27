// M0 read-only qualification of the RPC providers (and the public Textile schema) that live execution would rely on.
// It sends only read requests plus one eth_simulateV1 of a ZERO-value token transfer, which is a simulation: nothing is
// signed, nothing is broadcast, no state changes. Provider URLs (which usually embed an API key) are read from the
// environment and are NEVER printed: the report carries only a label and a vendor guess taken from the host suffix.
//
//   DAIDAI_RPC_URLS="https://a...,https://b..." node scripts/m0-qualify.mjs [--out evidence.json]
//
// Exit code 0 only when the evidence supports live-readiness on all three gates (simulation with transfer logs,
// finality, two-provider agreement). Documented support is not a passing probe; only a result printed here is.
import { writeFileSync } from 'node:fs';
import { encodeFunctionData } from 'viem';

export const REGISTRATION_TX = '0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b';
const CNGN = '0xf6829d7393dae24509eb1e52ee8e572e2e271a4f';
const WALLET = '0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e';
const SINK = '0x000000000000000000000000000000000000d103';
const ORACLE = '0x420000000000000000000000000000000000000F';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const VENDORS = [['alchemy.com', 'alchemy'], ['quiknode.pro', 'quicknode'], ['quicknode.com', 'quicknode'], ['ankr.com', 'ankr'],
  ['celo.org', 'forno'], ['chainstack.com', 'chainstack'], ['publicnode.com', 'publicnode'], ['infura.io', 'infura']];
const transferAbi = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }];
const l1FeeAbi = [{ name: 'getL1Fee', type: 'function', stateMutability: 'view', inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ type: 'uint256' }] }];

const vendorOf = url => { try { const h = new URL(url).hostname; return VENDORS.find(([s]) => h === s || h.endsWith('.' + s))?.[1] ?? 'other'; } catch { return 'invalid'; } };
const scrub = (text, urls) => urls.reduce((t, u) => { try { const x = new URL(u); return t.split(u).join('[url]').split(x.host).join('[host]').split(x.pathname.replace(/^\//, '') || '\u0000').join('[path]'); } catch { return t; } }, String(text)).slice(0, 90);

/** One JSON-RPC call. No retries (a retry of a read is harmless, but an unbounded loop is not), 10 s timeout, 1 MB cap. */
export function jsonRpc(fetchImpl = fetch) {
  let id = 0;
  return async (url, method, params) => {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    const text = await res.text();
    if (text.length > 1_000_000) throw Error('response too large');
    if (!res.ok) throw Error('HTTP ' + res.status);
    const body = JSON.parse(text);
    if (body.error) throw Object.assign(Error(String(body.error.message ?? 'rpc error').slice(0, 80)), { rpcCode: body.error.code });
    return body.result;
  };
}

async function attempt(work, urls) { try { return { ok: true, value: await work() }; } catch (e) { return { ok: false, error: scrub(e.message, urls), code: e.rpcCode }; } }
const hex = v => { try { return BigInt(v); } catch { return null; } };

export async function probeProvider(url, call, urls) {
  const r = (method, params) => call(url, method, params);
  const out = { vendor: vendorOf(url) };
  const chain = await attempt(() => r('eth_chainId', []), urls);
  out.chainId = chain.ok ? { ok: chain.value === '0xa4ec', value: chain.value } : { ok: false, error: chain.error };
  if (!out.chainId.ok) return out; // nothing else is meaningful on the wrong chain
  const latest = await attempt(() => r('eth_getBlockByNumber', ['latest', false]), urls);
  const finalized = await attempt(() => r('eth_getBlockByNumber', ['finalized', false]), urls);
  out.finality = finalized.ok && finalized.value?.hash ? { ok: true, finalizedBlock: String(hex(finalized.value.number)),
    lagBlocks: latest.ok && latest.value ? String(hex(latest.value.number) - hex(finalized.value.number)) : 'unknown', hash: finalized.value.hash }
    : { ok: false, error: finalized.error ?? 'no finalized block' };
  out.baseFee = { ok: latest.ok && !!latest.value?.baseFeePerGas };
  const tx = await attempt(() => r('eth_getTransactionByHash', [REGISTRATION_TX]), urls);
  const receipt = await attempt(() => r('eth_getTransactionReceipt', [REGISTRATION_TX]), urls);
  const block = receipt.ok && receipt.value ? await attempt(() => r('eth_getBlockByNumber', [receipt.value.blockNumber, false]), urls) : null;
  out.registrationRead = { ok: !!(tx.ok && tx.value && receipt.ok && receipt.value?.status === '0x1' && block?.ok && block.value?.hash === receipt.value.blockHash),
    blockNumber: receipt.ok && receipt.value ? String(hex(receipt.value.blockNumber)) : null, blockHash: block?.ok ? block.value?.hash ?? null : null,
    note: tx.ok && tx.value && receipt.ok && !receipt.value ? 'transaction visible but receipt missing' : undefined };
  const data = encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [SINK, 0n] });
  const sim = await attempt(() => r('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from: WALLET, to: CNGN, data, value: '0x0' }] }], validation: false }, 'latest']), urls);
  if (!sim.ok) out.simulation = { status: sim.code === -32601 || /not (found|supported|available)|unsupported|method/i.test(sim.error) ? 'method-not-supported' : 'error', error: sim.error };
  else {
    const call = sim.value?.[0]?.calls?.[0];
    const logs = Array.isArray(call?.logs) ? call.logs : null;
    out.simulation = { status: call?.status !== '0x1' ? 'reverted' : logs === null ? 'supported-no-logs' : logs.some(l => l?.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC) ? 'supported-with-logs' : 'supported-no-transfer-log', logCount: logs?.length ?? 0 };
  }
  const gasPrice = await attempt(() => r('eth_gasPrice', []), urls);
  const l1 = await attempt(() => r('eth_call', [{ to: ORACLE, data: encodeFunctionData({ abi: l1FeeAbi, functionName: 'getL1Fee', args: ['0x00'] }) }, 'latest']), urls);
  out.feeEstimation = { ok: gasPrice.ok && (hex(gasPrice.value) ?? 0n) > 0n && l1.ok && hex(l1.value) !== null, gasPrice: gasPrice.ok, l1Fee: l1.ok, error: l1.ok ? undefined : l1.error };
  return out;
}

/** Two independently operated providers must report the same canonical block for the same height. */
async function agreement(urls, call, providers) {
  const usable = providers.map((p, i) => ({ p, url: urls[i] })).filter(({ p }) => p.chainId?.ok && p.finality?.ok);
  if (usable.length < 2) return { ok: false, reason: usable.length === 0 ? 'no usable provider' : 'fewer than two usable providers' };
  const heads = usable.map(({ p }) => BigInt(p.finalizedBlock ?? p.finality.finalizedBlock));
  const min = heads.reduce((a, b) => a < b ? a : b);
  const height = '0x' + min.toString(16);
  const seen = await Promise.all(usable.map(({ url }) => attempt(() => call(url, 'eth_getBlockByNumber', [height, false]), urls)));
  if (seen.some(s => !s.ok || !s.value?.hash)) return { ok: false, reason: 'a provider could not return the shared finalized block' };
  const distinct = new Set(seen.map(s => s.value.hash));
  const reg = usable.map(({ p }) => p.registrationRead?.blockHash);
  return { ok: distinct.size === 1 && reg.every(h => h && h === reg[0]), comparedHeight: String(min), distinctFinalizedHashes: distinct.size, registrationBlockAgrees: reg.every(h => h && h === reg[0]) };
}

export async function textileSchema(base, fetchImpl = fetch) {
  const url = new URL('/v2/openapi.json', base);
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text(); if (text.length > 5_000_000) return { ok: false, error: 'schema too large' };
    const doc = JSON.parse(text);
    const rfqPaths = Object.keys(doc.paths ?? {}).filter(p => /rfq/i.test(p)).sort();
    return { ok: rfqPaths.length > 0, status: res.status, openapi: doc.openapi ?? null, version: doc.info?.version ?? null, rfqPaths };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 80) }; }
}

export async function qualify({ urls, fetchImpl = fetch, textileBase = 'https://api.textilecredit.com' }) {
  if (!urls.length) throw Error('set DAIDAI_RPC_URLS to one or more provider URLs');
  const call = jsonRpc(fetchImpl);
  const providers = [];
  for (const [i, url] of urls.entries()) providers.push({ label: `provider-${i + 1}`, ...await probeProvider(url, call, urls) });
  const agree = await agreement(urls, call, providers.map(p => ({ ...p, finalizedBlock: p.finality?.finalizedBlock })));
  const textile = await textileSchema(textileBase, fetchImpl);
  const gates = {
    simulationWithTransferLogs: providers.some(p => p.simulation?.status === 'supported-with-logs'),
    finality: providers.some(p => p.finality?.ok && p.registrationRead?.ok),
    twoProviderAgreement: agree.ok === true,
    feeEstimation: providers.some(p => p.feeEstimation?.ok),
    textileSchemaReadable: textile.ok === true,
  };
  return { generatedAt: new Date().toISOString(), credentialsPrinted: false, providers, agreement: agree, textile, gates,
    liveReady: gates.simulationWithTransferLogs && gates.finality && gates.twoProviderAgreement && gates.feeEstimation };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const urls = (process.env.DAIDAI_RPC_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const report = await qualify({ urls });
  const text = JSON.stringify(report, null, 2);
  const outAt = process.argv.indexOf('--out');
  if (outAt > 0) writeFileSync(process.argv[outAt + 1], text + '\n');
  console.log(text);
  process.exitCode = report.liveReady ? 0 : 1;
}
