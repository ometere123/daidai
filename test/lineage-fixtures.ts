// Test helper: records 'verified-final' the only legitimate way, from attested evidence bound to the attempt.
// Tests stand in for the trusted adapters here (deterministic chain data); production evidence comes from
// src/chain-evidence.ts. Nothing is sent to any network.
import { attest } from '../src/evidence-attestation.ts';
import type { AttemptLineageStore } from '../src/attempt-lineage.ts';
import type { CanonicalBlockObservation, ObservedTransaction } from '../src/authoritative-invoice.ts';

export function attestedEvidenceFor(store: AttemptLineageStore, attemptId: string) {
  const r = store.db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId) as Record<string, unknown>;
  if (!r) throw Error('unknown attempt');
  const blockHash = '0x' + 'b1'.repeat(32);
  const tx = attest<ObservedTransaction>({
    source: 'transaction-verifier', tenantId: String(r.tenant_id), invoiceId: String(r.invoice_id), digest: String(r.digest),
    revision: Number(r.recorded_revision), operation: r.operation as 'conversion' | 'payout', attemptId, hash: String(r.hash),
    chainId: 42220, buyToken: '0x' + '0c'.repeat(20), sellToken: '0x' + '0d'.repeat(20), sender: '0x' + '33'.repeat(20),
    recipient: '0x' + '22'.repeat(20), amountAtomic: '1', debitAtomic: r.operation === 'payout' ? '0' : '1',
    blockNumber: '100', blockHash, success: true, observedAtMs: 1,
  });
  const canonical = attest<CanonicalBlockObservation>({
    source: 'canonical-chain-reader', chainId: 42220, blockNumber: '100', blockHash, blockTimestampMs: 1,
    finalizedBlockNumber: '120', finalizedBlockHash: '0x' + 'f1'.repeat(32), observedAtMs: 1,
  });
  return { tx, canonical };
}

export function verifyFinal(store: AttemptLineageStore, attemptId: string, atMs: number) {
  const { tx, canonical } = attestedEvidenceFor(store, attemptId);
  store.recordVerifiedFinal(attemptId, tx, canonical, atMs);
}
