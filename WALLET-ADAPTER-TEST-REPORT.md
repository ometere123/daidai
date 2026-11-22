# Daidai | Wallet adapter test report

## Reproduction and evidence

Final results on 22 November 2026. Strict TypeScript checking exited 0. Both the fixture-tag and issued-tag runs passed 43/43 tests with zero failures or skips. The suite includes all 19 P08 regression cases and 24 adapter cases.

Use Node 22.23.3, npm 10.9.9, TypeScript 5.9.3, viem 2.45.0 and @celo/attribution-tags 0.5.0. The lockfile pins dependencies.

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
~~~

The test process uses only mock providers, synthetic order bytes and receipt evidence, and temporary SQLite databases. The suite was also run with the exact public code supplied by Loops through DAIDAI_ATTRIBUTION_CODE. The original 19 regression cases were copied into the root suite with the import pointed at the shared state-machine module. The preserved research copy remains available locally.

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

Live work still needs an approved MetaMask binding, a Textile proof-of-control flow, verified fresh balances and allowance, enforcement of native gas ceilings, independent exact-call simulation, and trusted chain receipt discovery and normalization. The adapter requires simulation output for swap transfer totals, but it supplies no RPC implementation. Receipt input must come from independent finalized chain evidence. For an unknown hash, a match must be corroborated against sender, exact call, nonce/history and transfers before supplying it. An open wallet prompt cannot be canceled by the local timer. Ambiguous outcomes fail closed and require manual reconciliation. Live wallet control, real signer behavior, market-maker acceptance, settlement, and Loops attribution credit remain unverified.

[Textile OpenAPI](https://api.textilecredit.com/v2/openapi.json) · [RFQ documentation](https://docs.textilecredit.com/api/v2/rfq.html) · [Verified deployed reactor source and ABI](https://celo.blockscout.com/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3?tab=contract) · [Preferred filler source](https://github.com/textile-protocol/textile-contracts-v3/blob/main/contracts/v3/filler/PreferredFillerValidation.sol) · [ERC-8004](https://docs.celo.org/build/agents/8004) · [Attribution SDK](https://github.com/celo-org/attribution-tags/blob/main/sdk/README.md) · [MetaMask direct send](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/)
