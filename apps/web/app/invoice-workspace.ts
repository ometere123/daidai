import { fixtures, type Invoice } from './model';

/** Client display data. This snapshot carries no authority to sign, execute, or settle. */
export type FixtureWorkspace = Readonly<{
  source: 'fixture';
  authoritative: false;
  execution: 'disabled';
  observedAtMs: number;
  invoices: readonly Invoice[];
}>;

/** Server-owned fixture adapter. No wallet, RPC, credentials, or database access. */
export function readFixtureWorkspace(now: number): FixtureWorkspace {
  return {
    source: 'fixture',
    authoritative: false,
    execution: 'disabled',
    observedAtMs: now,
    invoices: fixtures(now),
  };
}
