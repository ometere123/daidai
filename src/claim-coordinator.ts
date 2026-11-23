/**
 * Claim-time attempt lineage (P10.5), for an ISOLATED TEST ENVIRONMENT ONLY.
 *
 * Order of operations, every time:
 *   1. preflight (injected, side-effect free)            — refuse before anything is written
 *   2. claim: recordAttempt + taker-nonce reservation     — ONE transaction, persisted before any dispatch
 *   3. dispatch through a SimulatedDispatcher             — the only dispatcher that exists in this codebase
 *   4. recordHash, or recordOutcomeUnknown if no hash     — never retry
 *
 * Crash anywhere after step 2 leaves a retained, open attempt that blocks every further attempt for the invoice
 * operation (lineage triggers), and its nonce stays reserved. There is no automatic retry path: a new attempt needs
 * authoritative reconciliation, which is disabled until it exists (P10.3 review, blocker 2).
 *
 * No real dispatch is possible: the coordinator refuses any dispatcher whose `kind` is not 'simulated', and the
 * simulated dispatcher never touches a network, a wallet or a key.
 */
import { createHash } from 'node:crypto';
import type { AttemptLineageStore, NewAttempt, NonceReservation } from './attempt-lineage.ts';

export type SimulatedTransaction = Readonly<{ chainId: number; to: string; data: string; value: string; sender: string; nonce: number }>;
export interface SimulatedDispatcher {
  readonly kind: 'simulated';
  /** Returns a deterministic fake hash, returns null to simulate "broadcast but no hash", or throws to simulate a crash. */
  dispatch(tx: SimulatedTransaction): Promise<string | null>;
}

export function simulatedDispatcher(behaviour: (tx: SimulatedTransaction, call: number) => 'hash' | 'no-hash' | 'throw' = () => 'hash') {
  const calls: SimulatedTransaction[] = [];
  const d: SimulatedDispatcher & { calls: readonly SimulatedTransaction[] } = {
    kind: 'simulated',
    calls,
    async dispatch(tx) {
      calls.push(tx);
      const mode = behaviour(tx, calls.length);
      if (mode === 'throw') throw Error('simulated crash during dispatch');
      if (mode === 'no-hash') return null;
      return '0x' + createHash('sha256').update(JSON.stringify(tx) + ':' + calls.length).digest('hex');
    },
  };
  return d;
}

export type ClaimRequest = Readonly<{ attempt: NewAttempt; reservation: NonceReservation; tx: SimulatedTransaction }>;
export type ClaimOutcome =
  | Readonly<{ outcome: 'refused'; reason: string }>
  | Readonly<{ outcome: 'hash-recorded'; attemptId: string; hash: string }>
  | Readonly<{ outcome: 'outcome-unknown'; attemptId: string }>;

export type CoordinatorHooks = Readonly<{
  /** Side-effect-free checks (balances, allowance, fee ceilings, quote validity). Throw to refuse. */
  preflight?: (req: ClaimRequest) => Promise<void> | void;
  /** Test-only crash injection points. */
  afterClaim?: () => void;
  afterDispatch?: () => void;
  clock: () => number;
}>;

export class ClaimCoordinator {
  readonly #store: AttemptLineageStore;
  readonly #dispatcher: SimulatedDispatcher;
  readonly #hooks: CoordinatorHooks;
  constructor(store: AttemptLineageStore, dispatcher: SimulatedDispatcher, hooks: CoordinatorHooks) {
    if (!dispatcher || (dispatcher as { kind?: unknown }).kind !== 'simulated' || typeof dispatcher.dispatch !== 'function') {
      throw Error('only a simulated dispatcher is permitted in this environment');
    }
    this.#store = store; this.#dispatcher = dispatcher; this.#hooks = hooks;
  }

  async claimAndDispatch(req: ClaimRequest): Promise<ClaimOutcome> {
    const { attempt, reservation, tx } = req;
    // The transaction must be exactly what the attempt and reservation recorded.
    if (tx.chainId !== reservation.chainId || tx.sender !== reservation.sender || tx.nonce !== reservation.nonce ||
        tx.chainId !== attempt.envelope.chainId || tx.to.toLowerCase() !== attempt.envelope.to || tx.value !== attempt.envelope.value ||
        createHash('sha256').update(tx.data.toLowerCase()).digest('hex') !== attempt.envelope.dataSha256) {
      return { outcome: 'refused', reason: 'transaction does not match the claimed envelope or reservation' };
    }
    try { await this.#hooks.preflight?.(req); }
    catch (e) { return { outcome: 'refused', reason: 'preflight: ' + String((e as Error).message).slice(0, 120) }; }
    // 2. Persist the claim (attempt + nonce) before anything can be dispatched.
    let claimed: 'created' | 'existing';
    try { claimed = this.#store.recordAttempt(attempt, reservation); }
    catch (e) { return { outcome: 'refused', reason: String((e as Error).message) }; }
    if (claimed === 'existing') return { outcome: 'refused', reason: 'attempt already claimed; no retry' };
    this.#hooks.afterClaim?.();
    // 3. Simulated dispatch.
    let hash: string | null;
    try { hash = await this.#dispatcher.dispatch(tx); }
    catch {
      this.#store.recordOutcomeUnknown(attempt.attemptId, this.#hooks.clock(), 'dispatch failed after claim');
      return { outcome: 'outcome-unknown', attemptId: attempt.attemptId };
    }
    this.#hooks.afterDispatch?.();
    // 4. Record what we know. No hash means unknown, and unknown is never retried.
    if (hash === null) {
      this.#store.recordOutcomeUnknown(attempt.attemptId, this.#hooks.clock(), 'dispatcher returned no hash');
      return { outcome: 'outcome-unknown', attemptId: attempt.attemptId };
    }
    this.#store.recordHash(attempt.attemptId, hash, this.#hooks.clock());
    return { outcome: 'hash-recorded', attemptId: attempt.attemptId, hash };
  }
}
