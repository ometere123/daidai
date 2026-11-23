// P10.5 C1–C3: the read-only Celo RPC transport against a deterministic JSON-RPC HTTP server, through the real
// chain-evidence adapters and the projector. Loopback only; nothing is signed or broadcast.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { createCeloRpc, CeloRpcError } from '../src/celo-rpc.ts';
import { canonicalBlockReader, transactionVerifier } from '../src/chain-evidence.ts';
import { envelopeOf, type AttemptLineage } from '../src/attempt-lineage.ts';
import { attest } from '../src/evidence-attestation.ts';
import { readAuthoritativeInvoice, type ProjectionSources } from '../src/authoritative-invoice.ts';
import { chain, cngn, commit, reactor, tag, usdt, type Invoice } from '../src/invoice-core.ts';

const code = 'daidai';
const taker = '0x' + '33'.repeat(20), recipient = '0x' + '22'.repeat(20), approver = '0x' + '44'.repeat(20);
const T0 = 1_800_000_000_000;
const invoice: Invoice = { id: 'inv-1', version: 1, source: 'src', nonce: '12'.repeat(16), chain, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6,
  buyAmount: '150000000000', recipient, maxSell: '105000000', approver, taker, expires: T0 + 86_400_000 };
const { digest } = commit(invoice);
const convHash = ('0x' + 'a1'.repeat(32)) as Hex, payHash = ('0x' + 'b2'.repeat(32)) as Hex;
const swapData = tag('0xdeadbeef', code);
const payoutData = tag(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient as Hex, BigInt(invoice.buyAmount)] }), code);

const log = (token: string, from: string, to: string, value: bigint, tx: Hex, block: Hex, i: number) => ({
  address: token, removed: false, transactionHash: tx, blockHash: block, logIndex: '0x' + i.toString(16),
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});
type ChainState = { chainId: string; finalized: bigint; blocks: Map<string, { hash: Hex; ts: number }>; txs: Map<string, { to: string; input: Hex; block: bigint; logs: unknown[]; status?: string; returnedHash?: Hex }>;
  delayMs?: number; oversized?: boolean; rpcError?: boolean; badId?: boolean; onBlockRead?: (n: bigint, count: number) => void; blockReads: Map<string, number>; calls: string[] };

function baseState(o: { payoutAmount?: bigint; debit?: bigint; payoutToken?: string; payoutTo?: string; finalized?: bigint } = {}): ChainState {
  const b100 = ('0x' + '10'.repeat(32)) as Hex, b105 = ('0x' + '15'.repeat(32)) as Hex;
  return {
    chainId: '0xa4ec', finalized: o.finalized ?? 120n, calls: [], blockReads: new Map(),
    blocks: new Map([['100', { hash: b100, ts: (T0 + 1000) / 1000 }], ['105', { hash: b105, ts: (T0 + 2000) / 1000 }], ['120', { hash: ('0x' + '20'.repeat(32)) as Hex, ts: (T0 + 9000) / 1000 }], ['102', { hash: ('0x' + '12'.repeat(32)) as Hex, ts: (T0 + 1500) / 1000 }]]),
    txs: new Map([
      [convHash, { to: reactor, input: swapData, block: 100n, logs: [log(usdt, taker, reactor, o.debit ?? 102_480_000n, convHash, b100, 0), log(cngn, reactor, taker, BigInt(invoice.buyAmount), convHash, b100, 1)] }],
      [payHash, { to: cngn, input: payoutData, block: 105n, logs: [log(o.payoutToken ?? cngn, taker, o.payoutTo ?? recipient, o.payoutAmount ?? BigInt(invoice.buyAmount), payHash, b105, 0)] }],
    ]),
  };
}

async function serve(state: ChainState): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const { id, method, params } = JSON.parse(body);
    state.calls.push(method);
    if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
    const blockOf = (n: bigint) => state.blocks.get(n.toString());
    let result: unknown = null;
    if (method === 'eth_chainId') result = state.chainId;
    else if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
      const t = state.txs.get(params[0]);
      if (t) {
        const bh = blockOf(t.block)!.hash, bn = '0x' + t.block.toString(16);
        result = method === 'eth_getTransactionByHash'
          ? { hash: t.returnedHash ?? params[0], blockHash: bh, blockNumber: bn, chainId: '0xa4ec', from: taker, to: t.to, input: t.input, value: '0x0' }
          : { transactionHash: params[0], blockHash: bh, blockNumber: bn, from: taker, to: t.to, status: t.status ?? '0x1', logs: t.logs };
      }
    } else if (method === 'eth_getBlockByNumber') {
      const n = params[0] === 'finalized' ? state.finalized : BigInt(params[0]);
      const k = n.toString(); const count = (state.blockReads.get(k) ?? 0) + 1; state.blockReads.set(k, count);
      state.onBlockRead?.(n, count);
      const b = blockOf(n);
      result = b ? { number: '0x' + n.toString(16), hash: b.hash, timestamp: '0x' + b.ts.toString(16) } : null;
    }
    let out = JSON.stringify(state.rpcError ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'boom' } } : { jsonrpc: '2.0', id: state.badId ? id + 1 : id, result });
    if (state.oversized) out = JSON.stringify({ jsonrpc: '2.0', id, result: 'x'.repeat(3_000_000) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(out);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('no address');
  return { url: `http://127.0.0.1:${addr.port}/`, server };
}

const attemptRow = (op: 'conversion' | 'payout', revision: number): AttemptLineage => attest<AttemptLineage>({
  source: 'attempt-store', id: op + '-1', tenantId: 't', invoiceId: invoice.id, digest, operation: op, lineage: 'recorded', recordedRevision: revision,
  authorization: { digest, approvalSigner: approver, consentSigner: recipient, expiresAtMs: invoice.expires },
  envelope: envelopeOf({ chainId: chain, to: op === 'conversion' ? reactor : cngn, data: op === 'conversion' ? swapData : payoutData, value: '0' }),
  hash: op === 'conversion' ? convHash : payHash, dispatch: 'hash-recorded', closed: null, createdAtMs: T0 + 1, history: [],
});

async function project(state: ChainState, t: { after: (f: () => void) => void }, rpcOpts: { timeoutMs?: number } = {}) {
  const { url, server } = await serve(state); t.after(() => server.close());
  const now = T0 + 10_000;
  const rpc = createCeloRpc({ url, ...rpcOpts });
  const sources: ProjectionSources<unknown> = {
    authorize: async () => ({ tenantId: 't', invoiceId: invoice.id }),
    readInvoice: async () => attest({ source: 'invoice-store' as const, tenantId: 't', invoice: commit(invoice).invoice, digest, revision: 3, observedAtMs: now }),
    observeAuthorization: async (b, purpose) => attest({ source: 'authorization-verifier' as const, ...b, purpose, signer: purpose === 'invoice approval' ? approver : recipient,
      audience: 'https://daidai.example', expiresAtMs: invoice.expires, observedAtMs: now }),
    readAttempts: async (_b, op) => [attemptRow(op, op === 'conversion' ? 1 : 2)],
    observeTransaction: transactionVerifier(rpc, code, () => now),
    observeCanonicalBlock: canonicalBlockReader(rpc, () => now),
  };
  return readAuthoritativeInvoice({ viewer: 'v', invoiceId: invoice.id }, sources, { nowMs: now, maxObservationAgeMs: 60_000, expectedAudience: 'https://daidai.example' });
}

test('C1: the transport refuses non-read methods before any network I/O, and validates its configuration', async () => {
  let fetched = 0;
  const rpc = createCeloRpc({ url: 'https://rpc.example.invalid', fetch: (async () => { fetched++; throw Error('no'); }) as typeof fetch });
  for (const m of ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'eth_call', 'wallet_addEthereumChain', 'eth_estimateGas'])
    await assert.rejects(rpc(m, []), /read-only RPC: method not allowed/, m);
  assert.equal(fetched, 0);
  for (const url of ['http://rpc.example.com', 'https://user:pw@rpc.example.com', 'ftp://x', 'not a url', 'https://rpc.example.com/#frag'])
    assert.throws(() => createCeloRpc({ url }), CeloRpcError, url);
  assert.throws(() => createCeloRpc({ url: 'https://x.example', timeoutMs: 0 }), /limits/);
});

test('C2: canonical, finalized, exact-output and max-debit evidence verifies through the real transport', async t => {
  const state = baseState();
  const r = await project(state, t);
  assert(r);
  assert.equal(r.conversion.state, 'verified');
  assert.equal(r.payout.state, 'verified');
  assert.equal(r.conversion.evidence?.debitAtomic, '102480000');
  assert.equal(r.payout.evidence?.amountAtomic, invoice.buyAmount);
  assert.equal(r.settlement, 'settled'); // deterministic test chain: proves the verification logic, not a live payment
  assert(state.calls.every(m => ['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber'].includes(m)));
});

const negative: Record<string, [() => ChainState, 'conversion' | 'payout', string, string?]> = {
  notFinal: [() => baseState({ finalized: 102n }), 'payout', 'reconciliation-required', 'not-final'],
  wrongTransaction: [() => { const s = baseState(); s.txs.get(payHash)!.returnedHash = convHash; return s; }, 'payout', 'unknown'],
  wrongToken: [() => baseState({ payoutToken: usdt }), 'payout', 'unknown'],
  wrongRecipient: [() => baseState({ payoutTo: approver }), 'payout', 'unknown'],
  shortOutput: [() => baseState({ payoutAmount: BigInt(invoice.buyAmount) - 1n }), 'payout', 'unknown'],
  overCap: [() => baseState({ debit: BigInt(invoice.maxSell) + 1n }), 'conversion', 'unknown'],
  failedTx: [() => { const s = baseState(); s.txs.get(payHash)!.status = '0x0'; return s; }, 'payout', 'unknown'],
  wrongChain: [() => { const s = baseState(); s.chainId = '0x1'; return s; }, 'payout', 'unknown'],
  rpcError: [() => { const s = baseState(); s.rpcError = true; return s; }, 'payout', 'unknown'],
  idMismatch: [() => { const s = baseState(); s.badId = true; return s; }, 'payout', 'unknown'],
  oversized: [() => { const s = baseState(); s.oversized = true; return s; }, 'payout', 'unknown'],
};
for (const [name, [make, op, state, reason]] of Object.entries(negative)) {
  test(`C3: ${name} never verifies`, async t => {
    const r = await project(make(), t);
    assert(r, name);
    assert.equal(r[op].state, state, name + ' ' + JSON.stringify(r[op]));
    if (reason) assert.equal(r[op].reason, reason);
    assert.notEqual(r.settlement, 'settled');
  });
}

test('C3: a reorg between the receipt and the canonical read is detected (reconciliation required)', async t => {
  const state = baseState();
  // The canonical block at the payout height changes hash on its first canonical read (as if reorged out).
  state.onBlockRead = (n, count) => { if (n === 105n && count === 1) state.blocks.set('105', { hash: ('0x' + '99'.repeat(32)) as Hex, ts: (T0 + 2000) / 1000 }); };
  const r = await project(state, t);
  assert(r);
  assert.equal(r.payout.state, 'reconciliation-required');
  assert.equal(r.payout.reason, 'mismatch');
  assert.notEqual(r.settlement, 'settled');
});

test('C1: a slow endpoint times out and yields unknown, never verified', async t => {
  const state = baseState(); state.delayMs = 400;
  const r = await project(state, t, { timeoutMs: 100 });
  assert(r);
  assert.equal(r.payout.state, 'unknown');
  assert.equal(r.conversion.state, 'unknown');
  assert.notEqual(r.settlement, 'settled');
});

test('C1: errors never include the endpoint URL (which may carry a provider key)', async t => {
  const state = baseState(); state.rpcError = true;
  const { url, server } = await serve(state); t.after(() => server.close());
  const rpc = createCeloRpc({ url: url + 'secret-key-in-path' });
  await assert.rejects(rpc('eth_chainId', []), (e: Error) => !e.message.includes('secret-key') && !e.message.includes('127.0.0.1') && e instanceof CeloRpcError);
});
