/**
 * Trusted, read-only evidence adapters for the authoritative projection (P10.3).
 *
 * Each adapter performs its own verification and only then attests the record it returns
 * (evidence-attestation.ts). Nothing here can write, sign or dispatch:
 *  - chain access goes through `readOnlyRpc`, which refuses every method except four read calls;
 *  - SQLite is opened with `readOnly: true` and `query_only`;
 *  - authorization signatures are only *recovered* (pure EIP-712 recovery), never requested.
 *
 * These adapters are internal and injectable. They are not wired to any route: production storage, a reviewed RPC
 * endpoint and viewer authentication are prerequisites (see P10.3-READ-ONLY-BOUNDARIES.md).
 */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { authorizationMessage } from './authorization.ts';
import { accountTransferLogs } from './celo.ts';
import { attest } from './evidence-attestation.ts';
import { chain, cngn, commit, reactor, usdt, verifyTag, type Invoice } from './invoice.ts';
import type {
  AuthorizationPurpose, CanonicalBlockObservation, CommitmentBinding, ObservedAuthorization, ObservedTransaction,
  StoredAttempt, StoredInvoice, ViewerGrant,
} from './authoritative-invoice.ts';

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
const readMethods = new Set(['eth_chainId', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']);
const hashPattern = /^0x[0-9a-f]{64}$/;
const quantityPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const equal = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
function quantity(value: unknown) {
  if (typeof value !== 'string' || !quantityPattern.test(value.toLowerCase())) throw Error('invalid RPC quantity');
  return BigInt(value);
}

/** Wraps an RPC transport so that only the four read methods used here can ever be called. */
export function readOnlyRpc(transport: Rpc): Rpc {
  return async (method, params) => {
    if (!readMethods.has(method)) throw Error('read-only RPC: method not allowed');
    return transport(method, params);
  };
}

// ---------------------------------------------------------------- committed invoice snapshots

/** Server directory of tenant ownership. Never derived from client input. */
export type TenantDirectory = (invoiceId: string) => Promise<string | null>;

/**
 * Reads committed invoice snapshots from the invoice store (the harness `invoices` table: id, body, revision)
 * through a read-only connection, re-derives the commitment digest and rejects any record that doesn't match it.
 */
export function invoiceSnapshotReader(file: string, tenants: TenantDirectory, clock: () => number) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec('PRAGMA query_only = ON;');
  return {
    async readInvoice(grant: ViewerGrant): Promise<StoredInvoice | null> {
      if (await tenants(grant.invoiceId) !== grant.tenantId) return null;
      const row = db.prepare('SELECT body, revision FROM invoices WHERE id = ?').get(grant.invoiceId) as { body: string; revision: number } | undefined;
      if (!row) return null;
      let record: { commitment: { invoice: Invoice; digest: string }; revision: number };
      try { record = JSON.parse(String(row.body)); } catch { return null; }
      const committed = commit(record.commitment.invoice);
      if (committed.digest !== record.commitment.digest || record.revision !== Number(row.revision)) return null;
      return attest<StoredInvoice>({
        source: 'invoice-store', tenantId: grant.tenantId, invoice: committed.invoice, digest: committed.digest,
        revision: Number(row.revision), observedAtMs: clock(),
      });
    },
    close() { db.close(); },
  };
}

// ---------------------------------------------------------------- authorization summaries

/** Server-side store of the two signatures returned by the approver and recipient (SignedAuthorization). */
export type SignatureStore = (binding: CommitmentBinding) => Promise<Readonly<{ approval: Hex; consent: Hex }> | null>;

/**
 * Recovers the signer of the stored EIP-712 authorization for the given purpose. Time-independent on purpose:
 * the projector, not this adapter, decides whether the authorization is current or was valid at execution.
 */
export function authorizationObserver(signatures: SignatureStore, snapshot: (b: CommitmentBinding) => Promise<StoredInvoice | null>,
  audience: string, clock: () => number) {
  return async function observeAuthorization(binding: CommitmentBinding, purpose: AuthorizationPurpose): Promise<ObservedAuthorization | null> {
    const stored = await snapshot(binding);
    if (!stored || stored.digest !== binding.digest || stored.tenantId !== binding.tenantId) return null;
    const pair = await signatures(binding);
    const signature = purpose === 'invoice approval' ? pair?.approval : pair?.consent;
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
    let signer: string;
    try {
      signer = (await recoverTypedDataAddress({ ...authorizationMessage(stored.invoice, binding.digest, purpose, audience), signature })).toLowerCase();
    } catch { return null; }
    const expected = purpose === 'invoice approval' ? stored.invoice.approver : stored.invoice.recipient;
    if (signer !== expected) return null;
    return attest<ObservedAuthorization>({
      source: 'authorization-verifier', ...binding, purpose, signer, audience, expiresAtMs: stored.invoice.expires, observedAtMs: clock(),
    });
  };
}

// ---------------------------------------------------------------- transaction receipts

type RpcTransaction = { hash: string; blockHash: string; blockNumber: string; chainId: string; from: string; to: string; input: Hex; value: string };
type RpcLog = { address: string; data: Hex; topics: [Hex, ...Hex[]]; removed?: boolean; transactionHash?: Hex; blockHash?: Hex; logIndex?: Hex };
type RpcReceipt = { transactionHash: string; blockHash: string; blockNumber: string; from: string; to: string; status: string; logs: RpcLog[] };

/**
 * Independently verifies the transaction behind a recorded attempt:
 * chain, sender (taker), envelope (to, data digest, value) against what the attempt recorded, Daidai attribution,
 * receipt success, log integrity, and the exact token movements (exact cNGN output; USDt debit within the cap for a
 * conversion, none for a payout). The result is bound to the attempt and to the revision it was recorded at.
 * Finality is a separate observation (canonicalBlockReader).
 */
export function transactionVerifier(rpc: Rpc, attributionCode: string, clock: () => number) {
  const read = readOnlyRpc(rpc);
  return async function observeTransaction(attempt: StoredAttempt, invoice: Invoice): Promise<ObservedTransaction | null> {
    if (attempt.lineage !== 'recorded' || attempt.recordedRevision === null || !attempt.envelope || !attempt.hash ||
        !hashPattern.test(attempt.hash)) return null;
    if (await read('eth_chainId', []) !== '0xa4ec' || invoice.chain !== chain) return null;
    const tx = await read('eth_getTransactionByHash', [attempt.hash]) as RpcTransaction | null;
    const receipt = await read('eth_getTransactionReceipt', [attempt.hash]) as RpcReceipt | null;
    if (!tx || !receipt) return null;
    const operation = attempt.operation;
    const expectedTo = operation === 'conversion' ? reactor : cngn;
    const env = attempt.envelope;
    const dataSha256 = createHash('sha256').update(String(tx.input).toLowerCase()).digest('hex');
    if (!equal(tx.hash, attempt.hash) || !equal(receipt.transactionHash, attempt.hash) || tx.chainId !== '0xa4ec' ||
        env.chainId !== chain || env.to !== expectedTo || !equal(tx.to, env.to) || !equal(receipt.to, env.to) ||
        dataSha256 !== env.dataSha256 || quantity(tx.value) !== BigInt(env.value) ||
        !equal(tx.from, invoice.taker) || !equal(receipt.from, invoice.taker) || receipt.status !== '0x1' ||
        !hashPattern.test(String(receipt.blockHash).toLowerCase()) || !equal(tx.blockHash, receipt.blockHash) ||
        tx.blockNumber !== receipt.blockNumber) return null;
    try { verifyTag(tx.input, attributionCode); } catch { return null; }
    if (!Array.isArray(receipt.logs)) return null;
    // Deduplicate on the numeric index: '0x1' and '0x01' are the same log and must not be counted twice.
    const indices = new Set<bigint>();
    for (const log of receipt.logs) {
      let index: bigint;
      try { index = quantity(log.logIndex); } catch { return null; }
      if (log.removed || !equal(log.transactionHash, attempt.hash) || !equal(log.blockHash, receipt.blockHash) ||
          indices.has(index)) return null;
      indices.add(index);
    }
    let accounted;
    try {
      accounted = accountTransferLogs(receipt.logs, {
        action: operation === 'conversion' ? 'swap' : 'payout', sender: invoice.taker, recipient: invoice.recipient,
        buyToken: invoice.buy, sellToken: invoice.sell,
      });
    } catch { return null; }
    if (accounted.unexpected || accounted.received !== BigInt(invoice.buyAmount)) return null;
    if (operation === 'conversion' ? accounted.debit <= 0n || accounted.debit > BigInt(invoice.maxSell) : accounted.debit !== 0n) return null;
    return attest<ObservedTransaction>({
      source: 'transaction-verifier', tenantId: attempt.tenantId, invoiceId: attempt.invoiceId, digest: attempt.digest,
      revision: attempt.recordedRevision, operation, attemptId: attempt.id, hash: attempt.hash, chainId: chain,
      buyToken: cngn, sellToken: usdt, sender: invoice.taker, recipient: operation === 'conversion' ? invoice.taker : invoice.recipient,
      amountAtomic: accounted.received.toString(), debitAtomic: accounted.debit.toString(),
      blockNumber: quantity(receipt.blockNumber).toString(), blockHash: receipt.blockHash.toLowerCase(), success: true, observedAtMs: clock(),
    });
  };
}

// ---------------------------------------------------------------- canonical blocks and finality

type RpcBlock = { number: string; hash: string; timestamp: string };

/** Reads the canonical block at a height (hash and timestamp) and the current finalized head. */
export function canonicalBlockReader(rpc: Rpc, clock: () => number) {
  const read = readOnlyRpc(rpc);
  return async function observeCanonicalBlock(chainId: number, blockNumber: string): Promise<CanonicalBlockObservation | null> {
    if (chainId !== chain || !/^[1-9][0-9]{0,30}$/.test(blockNumber)) return null;
    if (await read('eth_chainId', []) !== '0xa4ec') return null;
    const height = '0x' + BigInt(blockNumber).toString(16);
    const block = await read('eth_getBlockByNumber', [height, false]) as RpcBlock | null;
    const finalized = await read('eth_getBlockByNumber', ['finalized', false]) as RpcBlock | null;
    if (!block || !finalized || block.number !== height || !hashPattern.test(String(block.hash).toLowerCase()) ||
        !hashPattern.test(String(finalized.hash).toLowerCase())) return null;
    const timestampMs = Number(quantity(block.timestamp)) * 1000;
    if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) return null;
    return attest<CanonicalBlockObservation>({
      source: 'canonical-chain-reader', chainId: chain, blockNumber, blockHash: block.hash.toLowerCase(), blockTimestampMs: timestampMs,
      finalizedBlockNumber: quantity(finalized.number).toString(), finalizedBlockHash: finalized.hash.toLowerCase(), observedAtMs: clock(),
    });
  };
}
