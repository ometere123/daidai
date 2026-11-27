# Architecture — controlled pilot, not a new platform
## Baseline and decisions
Keep Node 22 / TypeScript, root viem 2.45.0, attribution SDK 0.5.0; web Next 16.4.6 React 19.3.1 and existing CSS; Worker viem 2.58.4, Miniflare 4.20260730.0. Versions observed in manifests, use lockfiles; no dependency upgrades absent a demonstrated compatibility/security need. Do not assume Node SQLite runs in a Worker or serverless disk is durable. Keep exact public gate/proxy and read-only Worker boundaries.

P0 financial pilot is **one persistent local Node process + SQLite execution journal + existing loopback MetaMask bridge**. This is a deliberate narrower release than a hosted multi-tenant financial product. Public Next site is a reviewer-facing demo/read-only proof. Existing Worker/D1 authenticated invoice journey remains a local product/fixture path; do not wire it to a second financial writer. For the controlled pilot, import a verified immutable agreement into the Node journal using reviewed operator flow; display/publish only read-only projections from that journal or explicitly consented dated evidence export. If local Next integration is feasible, use a read-only loopback projection; otherwise use a minimal existing local review shell for the actual pilot, not a fake connected dashboard. Do not make two product stores authoritative. No remote Worker launch required for P0. This reconciles the old hosted-product aspiration with the scope/time constraint.

~~~mermaid
flowchart LR
  S[Supplier agreement and consent] --> N[Local Node obligation coordinator]
  P[Payer authorisation] --> N
  N <--> J[(SQLite authoritative journal)]
  N --> T[Textile v2 RFQ]
  N <--> B[Loopback review bridge]
  B --> M[MetaMask owner confirms]
  M --> C[Celo mainnet]
  N <--> R[Independent RPC verification]
  R --> C
  N --> E[Consent-reviewed evidence export]
  E --> W[Public Next proof page]
  D[Local D1 fixture / authenticated read-only UI] -. separate .-> W
~~~

## Source map and implementation boundaries
| Path | Use |
|---|---|
| src/invoice-core.ts, authorization.ts | Canonical Invoice, commit, EIP-712 proof, atomic amounts; reverify signatures on restart |
| src/product-contract.ts, workers/api/src/product.ts, product-schema.ts | Existing draft/revision/share contract; not same digest as Invoice v1. Do not silently equate them. Explicit reviewed mapping to canonical pilot invoice once; verify terms, identity, version and stable ID. |
| src/textile.ts, product-quote.ts, textile-preview-source.ts, taker-proof.ts | Existing strict parser, preview and proof primitives; add real firm transport behind explicit approval |
| src/settlement-review.ts, celo.ts, celo-rpc.ts, celo-quorum.ts, chain-evidence.ts, evidence-attestation.ts | Exact preflight and verification; existing CeloReader verification is not automatically two-provider quorum. Compose independently verified matching canonical observations; reject disagreement. |
| src/attempt-lineage.ts, lineage-schema.ts, claim-coordinator.ts | Existing append-only claims, nonce reservations, verified closure. Coordinator explicitly simulated today; keep mock path and add a separate reviewed live adapter. |
| src/wallet.ts, wallet-boundary.ts, wallet-host.ts, browser-wallet.ts | Existing pinned EIP-1193 boundary; do not use legacy Spike or MockChain as live journal. Inspect and adapt only low-level reviewed envelope handoff. |
| apps/web/app, apps/web/lib, workers/api/src | Public proof, isolated demo, local authenticated product. Render shared view components with typed projections, never fixture data in real path. |

## Data model
Existing schema source is authoritative, not these conceptual rows. Retain constraints and inspect actual SQL before additive migrations. Execution database is a persistent SQLite file outside the repo, one writer, transactionally durable (backup and restrictive permissions). D1 remains separate.
| Record | Required content / key |
|---|---|
| Obligation (new pilot record if needed) | stable id, tenant/owner, canonical invoice JSON + digest, signed approval/consent + audience, expiry, created time; immutable once authorised |
| Reviewed envelope (additive durable evidence) | invoice id/digest, operation, sender, chain, target, calldata, value, nonce, gas ceilings, quote/deadline metadata, expected amounts, envelope hash; no API key or claim token in public/export |
| attempts / attempt_events / nonce reservations | existing lineage-schema.ts; unique open/final operation across digest versions, unique tx hash, sender/chain/nonce reservation, append-only events |
| Verification evidence | actual tx/receipt, canonical block number/hash, finalized heads/provider IDs/time, exact token deltas, fee data and result; save provenance not just boolean |
| Public proof projection | explicitly redacted subset, source commit, date, chain/hash, status, actual amounts only with consent; never credentials or signatures |

Allowance (if required) is a separate reviewed and journaled wallet operation, with nonce and ambiguous outcome safeguards. Existing lineage schema only allows conversion/payout: use a small dedicated allowance-intent journal or a reviewed additive migration; do not falsely store approval as conversion. Recheck confirmed allowance before RFQ, cap it, and do not auto-repeat unknown approval. If preapproval unavailable, request/validate initial quote, approve exact required allowance, finalize, cancel/release unused quote if possible, then obtain a fresh quote. No unlimited allowance.

## Proposed state/action contract (not existing endpoints)
Use typed internal coordinator functions, not an invented public write API. Proposed discriminated operation commands: importAgreement(canonicalInvoice, signedAuthorization, audience), inspect(id), prepare(id, operation), approveReviewed(id, reviewFingerprint), reconcile(id), resume(id). Implement names after checking current exports; do not expose a generic RPC/sign endpoint. All results carry id/digest, current state, next action, reason and observation timestamp. No mutable financial terms accepted from UI during dispatch. Idempotent inspect/reconcile are read-only except append verified evidence; prepare may reserve RFQ only with specific authority. Approve requires explicit operator confirmation and exact fingerprint/expiry. Browser sends only wallet result/hash or rejection; server derives chain evidence. Never treat browser-supplied receipt as authoritative.
Existing API remains src/product-contract.ts and src/api-contract.ts: POST /v1/product (p11.v1 list/detail/save/commit/cancel/share/revoke/redeem); GET /v1/invoices/:id/authoritative; /v1/invoices and /v1/sessions via signed server client. Do not add remote financial dispatch route. Existing HMAC request binds method, path, body, viewer token, nonce/time; session scope and tenant isolation enforced server-side. Read actual contract before changing.

## Execution and restart
1. Import verified terms; pin same enrolled sender/taker/EOA. Validate current token contracts/decimals and wallet chain 42220. Verify source of funds and external recipient consent. Reserve only after read-only readiness. 
2. Preview optionally; firm RFQ POST /v2/rfq/request with chainId, sellToken, buyToken, buyAmount atomic string, taker; use exact documented shape. Keyless proof_of_control_required 401 → role-specific EIP-712 TakerControl in existing taker-proof.ts; do not generic-sign arbitrary payload. API key optional if approved; store claim token privately, use X-Rfq-Claim for cancel/status/submit as documented. No automatic repeat of unknown reservation; respect outstanding limits. Validate immediate response; status endpoint does not reconstruct lost signed bytes. Avoid pre-tagged response; includeAttribution off for partner key. Append own code once using existing SDK.
3. Check exact supported reactor, approval, full batch, taker/filler, signed amounts/deadline, fee, allowance and balances with pinned token addresses. Simulate exact attributed envelope and transfer logs, estimate L1/L2 fees; fail closed if unsupported. No eth_call-only substitution. Review and confirm once; recheck expiry/headroom and provider identity immediately before handoff. Record claim+nonce+immutable reviewed envelope in one SQLite transaction *before* wallet call. A timeout or rejection after handoff is not a license to resend.
4. Observe known hash via both independent providers. Check chain, sender, target, value, calldata, nonce, success, gas bounds, logs and canonical finalized block. Derive exact cNGN credited and USDt debited, compare with commitment/cap. Only promote when matched. Record attestation and durable proof; no single RPC fallback for acceptance.
5. On restart reload signed agreement and persisted envelope, independently reverify; rebuild process-local verified proof via reviewed verification functions, not serialized WeakSet identity or forged object. If conversion verified, prohibit another conversion; recheck consent/cNGN/gas, prepare payout. If expiry or evidence conflict blocks, escalate with existing state intact. Do not enable reconciled-not-landed closure in P0: unknown or definitively failed claimed attempt remains blocked for operator investigation. Known finalized conversion can be resumed without releasing any claim.
6. Payout uses exact ERC20 transfer to committed recipient, same wallet, separate tag/claim/review. Both verified → receipt. Source journal remains authoritative, export read-only evidence. No claim to atomic two-step settlement or control of owner actions outside application.

## Integration verification matrix
| Component | Source / known constraint | Exit gate |
|---|---|---|
| Textile RFQ/auth | [RFQ](https://docs.textilecredit.com/api/v2/rfq.html), [auth](https://docs.textilecredit.com/api/v2/authentication.html), [OpenAPI](https://api.textilecredit.com/v2/openapi.json), [limits](https://docs.textilecredit.com/api/v2/errors.html): preview free/non-reserving; firm default 60s, taker-bound; exact output, claim credentials; limits may differ | read current OpenAPI, qualify live preview then one separately authorised firm request; capture sanitized schema, no credentials |
| RPC | [Alchemy Celo eth_simulateV1](https://www.alchemy.com/docs/chains/celo/celo-api-endpoints/eth-simulate-v-1), [QuickNode](https://www.quicknode.com/docs/celo/eth_simulateV1), [Geth](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth); Forno denied method in P08B8. Chainstack access not verified | read-only probe actual approved endpoint: chain, finalized/numbered block, tx/receipt, transfer logs in exact simulation, fee oracle; two independent canonical readers; no paid purchase without approval |
| Wallet | [MetaMask send](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/), [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193), [viem typed recovery](https://viem.sh/docs/utilities/recoverTypedDataAddress) | real extension connection and selected account/chain (read-only first); verify actual sent bytes after owner-approved operation |
| Identity/tag | [Celo ERC-8004](https://docs.celo.org/build/agents/8004), [attribution SDK](https://github.com/celo-org/attribution-tags) | check recorded identity and Loops entry, verify exactly one issued suffix and actual indexing; never replay registration |
| Runtime | [Next proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy), [Node SQLite](https://nodejs.org/api/sqlite.html), [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) | pinned dependencies and CI; local persisted SQLite, no serverless financial writer |
| Hosting | [Vercel plan terms](https://vercel.com/docs/plans/hobby), [runbook](../ops/P12-RUNBOOK.md) | reconcile actual project/commit/config first; noncommercial judge demo only if plan permits; commercial use requires compliant hosting and separate approval |

Documentation is not successful integration. No live probes performed in blueprint phase. Unknown auth/rate limits: use bounded timeout/backoff for reads only, confirm current vendor limits; no unbounded polling, no retry of dispatch. Missing quote or RPC returns user-facing actionable state.

## Threats and operations
Treat all invoice text, quote JSON and remote responses as untrusted. Validate lengths/types, exact origin, no wildcard CORS, no redirects to untrusted endpoints; secrets server-only, no provider URL tokens in repo, no shell/log leakage. Wallet connection invalidation on account/network/disconnect; protect loopback bearer, one-time bootstrap and job ID. Never allow fixture dispatcher in live mode. Separate fixture and pilot paths/storage; fail if mode unknown. Process single writer, durable lock/nonce claim, reconcile before new actions after backup/restore. If operator changes wallet or RPC disagrees, stop. Preserve audit trail; no destructive schema migration or journal reset. Escalate unknown outcomes with hash/nonce/receipt investigation, no guess. Public deployment closed and no-store private pages; don't open hosted identity/Worker until separately reviewed. Verify production provenance and rotate credentials if actual exposure confirmed; owner approves changes. Existing audit reports an untraced deployment; not independently confirmed. Compliance review before commercial launch.
