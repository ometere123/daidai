/**
 * Server-internal attestation brand for authoritative evidence.
 *
 * A `source: '…'` label is plain data: anything can claim it. Evidence is treated as authoritative only when
 * the very object was produced in this process by a trusted adapter, which registers it here after performing its
 * own verification. Objects that crossed a serialization boundary (JSON, structured clone, HTTP) lose the brand,
 * so client-supplied or replayed evidence can never be authoritative.
 *
 * This module must only be imported by trusted server composition: the adapters in `evidence-adapters.ts`,
 * `attempt-lineage.ts`, `viewer-access.ts`, the projector, and deterministic tests. It is never bundled for the client.
 */
const attested = new WeakSet<object>();

export function attest<T extends object>(value: T): Readonly<T> {
  const frozen = Object.freeze(value);
  attested.add(frozen);
  return frozen;
}

export function isAttested(value: unknown): boolean {
  return typeof value === 'object' && value !== null && attested.has(value);
}
