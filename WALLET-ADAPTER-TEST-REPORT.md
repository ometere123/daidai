# Daidai | Wallet adapter test report

## Reproduction and evidence

P08B.7 results on 22 November 2026. Strict TypeScript checking passed. The suite has 49 passing tests, including the 19 original invoice cases and all 24 prior adapter cases with their fixtures updated for the new verification boundary. The six added cases cover timeout with an unknown hash, forged receipt objects, EIP-712 roles, finalized RPC evidence, bounded simulation, and the authenticated browser boundary.

Use Node 22.23.3, npm 10.9.9, TypeScript 5.9.3, viem 2.45.0 and @celo/attribution-tags 0.5.0. The lockfile pins dependencies.

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
~~~

The test process uses mock wallet and Celo clients, synthetic orders and RPC receipts, temporary SQLite databases, and ephemeral local signer fixtures for cryptographic verification. The main RFQ fixture buys 1,500.000000 cNGN for 1.100220 USDt, including a synthetic 0.000220 USDt fee, with a 1.200000 USDt cap. The suite was also run with the exact public code supplied by Loops through DAIDAI_ATTRIBUTION_CODE. The original 19 regression cases were copied into the root suite with the import pointed at the shared state-machine module. The preserved research copy remains available locally.

## Coverage

| Area | What is tested |
|---|---|
| Execution identity | The pinned EOA is put in from and in Textile taker. Wrong sender, chain, changed account/network, disconnect, and delegated account code stop the handoff |
| Textile wire format | Exact-output body, nested wire outcome, spender and transaction envelope, cap, ISO deadlines, ERC-20 approval, full reactor batch, signed filler and signed order totals |
| Calldata and attribution | The direct provider request carries exact tagged approval, registration, swap or payout calldata. Pretagged swap bytes and cloned prepared requests are rejected |
| Wallet outcome | Explicit rejection and timeout are journaled. A fresh quote and matching simulated transfer amounts are required before handing bytes to the provider |
| Idempotency | Persisted claim prevents duplicate sends after reopening SQLite. Concurrent payout submissions send once. A hash mismatch blocks reconciliation |
| Late settlement | Textile status alone cannot transition the invoice. A matching synthetic finalized receipt is required, and short output is rejected |

## Interfaces checked and evidence limits

The implementation was compared with Textile's public OpenAPI and RFQ docs, the verified Celo reactor ABI and source, Textile's preferred-filler contract source, Celo's register(string) interface, the installed attribution package, and MetaMask's EIP-1193 send method. Celo public contract documentation and local package execution are separate evidence. The immediate direct reactor path intentionally rejects recall, other spenders, unknown validators and callback variants. Fixture maker signatures are synthetic. No fresh quote was obtained to confirm the venue's current emitted bytes for this corridor.

## Resolved in code

- Node derives settlement evidence using its configured read-only Celo RPC. The stored wallet hash, exact call and nonce are required. It verifies chain, sender, destination, calldata, value, success, canonical finality, and token-log provenance and amounts. Caller-created receipt objects cannot advance the invoice. Missing hashes stay in reconciliation without automatic recovery.
- Two role-specific EIP-712 signatures bind the payable invoice digest, chain, audience and expiry. Tests exercise invalid signer, altered digest, wrong audience, expiry and replay. The synthetic approval path is available only with the explicitly injected mock chain.
- The loopback wallet boundary gates jobs on origin and a randomly issued bearer, with one job outstanding and one completion per job. Browser-side code rechecks the selected account and chain before handing a reviewed request to EIP-1193. SQLite stays in Node.
- Read-only gas estimate, account code, balance, eth_call, rollup fee estimate, and exact swap log simulation gates run before handoff. The wallet request carries explicit gas, fee per gas, priority fee and nonce. Rollup overhead uses an estimate and configured reserve. A wallet override can only be detected afterward by checking the actual transaction.

## Still blocked for live use

No browser host, bearer bootstrap, approved MetaMask binding, real approver or recipient authorization, Textile control-proof flow, live firm quote, or Loops credit has been verified. Validate that a vetted Celo RPC supports finalized block queries, the required simulation method, and rollup fee estimation. Missing capabilities fail closed. RPC identity and canonical chain truth depend on the independently configured server endpoint. The estimates cannot guarantee future L1 fees or inclusion. No cross-process wallet scheduler, unknown-hash recovery, or production deployment is included. A locally timed-out prompt may remain open in the wallet. Do not resend. Wallet enrollment and the first live settlement require separate approval.

[Textile OpenAPI](https://api.textilecredit.com/v2/openapi.json) · [RFQ documentation](https://docs.textilecredit.com/api/v2/rfq.html) · [Verified deployed reactor source and ABI](https://celo.blockscout.com/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3?tab=contract) · [Preferred filler source](https://github.com/textile-protocol/textile-contracts-v3/blob/main/contracts/v3/filler/PreferredFillerValidation.sol) · [ERC-8004](https://docs.celo.org/build/agents/8004) · [Attribution SDK](https://github.com/celo-org/attribution-tags/blob/main/sdk/README.md) · [MetaMask direct send](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/)
