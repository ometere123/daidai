# P10 provisional fixture integration

No earlier P10 definition was found in the available conversation or repository history. This first slice uses the provisional scope supplied at closeout.

The Next.js server page requests a fresh typed FixtureWorkspace from the read-only fixture adapter. The workspace declares fixture provenance, non-authoritative evidence and disabled execution. It crosses the React server-to-client boundary with native BigInt atomic amounts. The Ink and Brass workspace consumes that snapshot and applies existing local demo overlays. Reloads recreate fixtures. There are no public write endpoints, production adapters, signer imports or wallet calls in this slice.

Authoritative settlement stays in the backend. A subsequent server projection should carry invoice digest and revision, trusted timestamped balance and allowance observations, authorization summaries and separate finalized conversion and payout evidence. UI fixture signatures and receipts confer no authority. Existing backend EIP-712 recovery, exact-output and debit bounds, transaction envelope checks, attribution, durable claims and finalized receipt verification remain independent.

Before live integration, require trusted server-owned balances and allowances, finalized allowance verification, scoped approver and recipient signatures, durable cross-invoice nonce coordination, exact reviewed envelopes for swap and payout, explicit recovery of missing or ambiguous hashes, and full gas and rollup fee review. Unknown outcomes must retain their attempt and block duplicate dispatch. No live settlement is authorized by this PR.

## Verification

Root strict TypeScript passed, followed by 54/54 regression tests and 33/33 isolated browser tests. Frontend strict TypeScript and production build passed. The frontend preview was built with NEXT_PUBLIC_DAIDAI_DEMO_TOOLS=1 and tested on loopback with 14/14 passing checks. The four additional P10 model cases passed using Node's test runner and native TypeScript stripping.

The architecture audit found no earlier P10 definition and reviewed the server/client read model. The security audit reviewed trusted inputs, dispatch and reconciliation gates. A separate test agent added the presentation failure cases. This branch adds no financial execution code.
