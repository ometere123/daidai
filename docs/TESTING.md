# Testing and release criteria
Existing CI is baseline, not live certification. All routine CI is offline, no wallet secrets, no live firm reservations, no transactions. Keep synthetic and live data separate. Add focused regressions and run full affected suites; exact head CI must pass.

## Requirement traceability
| Requirement | Tests / evidence | Gate |
|---|---|---|
| R01 | invoice-core unit boundary, product mapping digest, mutation/ID/version/decimal/overflow tests | invalid terms refused, exact canonical roundtrip |
| R02 | authorization EIP-712 role/audience/expiry/signer/replay tests, real separately collected pilot signatures | fail closed; no approval from share link |
| R03 | parser and preview fixtures incl malformed batch, cap, fee, unknown validator, stale quote, mismatched taker, token and allowance, live preview/firm schema | no invalid dispatch; approved firm quote works |
| R04 | wallet bridge exact origin, pinned account, network/disconnect, altered reviewed copy, expired headroom, one completion, simulated wallet override; real extension read-only then approved send | exact reviewed payload, one tag, no generic signer |
| R05 | SQLite atomic claim, same-invoice across versions, concurrent calls, crash before/after dispatch, reopen database, unique hash and nonce; allowance ambiguous outcome | at most one controlled dispatch per claimed operation |
| R06 | two-provider chain/receipt/log/fee/canonical/finality mismatches, malformed log index, actual conversion receipt | exact credit/debit and agreed finality |
| R07 | payout only after conversion evidence, insufficient cNGN/gas/expired auth, wrong recipient, actual finalized payout | exact external transfer once |
| R08 | fresh process reload signed terms/envelope, reverify conversion, no second RFQ or conversion dispatch, payout-only path, expiry branch | actual interruption demo with known finalized conversion |
| R09 | timeout after provider send, missing hash, reorg/disagreement, wrong nonce, stale snapshot, restore | unresolved; no automatic replacement/release |
| R10 | receipt states, separate conversion/payout, real actual amounts and gas, no fake tx, redaction tests | only both verified yields settled |
| R11 | production build, gate/private 404 no-store, link crawl, fixture separation, accessibility, exact source commit and screenshots | reviewer can reach demo/proof, no broken CTA |
| R12 | registry and tag read-only verify; Loops current indexing, real job and recipient confirmation | eligibility verified separately from independent-user credit |

Existing tests include test/invoice.test.ts, integration.test.ts, security.test.ts, wallet.test.ts, attempt-lineage.test.ts, p105-claim-coordinator.test.ts, p105-celo-rpc.test.ts, p12-settlement.test.ts and p13-real.test.ts. Inspect fixture interfaces before adding tests. Test new actual pilot coordinator with injected deterministic providers and persisted temporary SQLite; ensure real dispatcher is unreachable in CI/demo. Do not turn synthetic tests into mainnet success claims.

## Failure/security matrix
Reject modified calldata, wrong chain/account/recipient/token, expired approval or quote, bad fee/cap, tampered proof, pretagged response, insufficient gas, unsafe allowance, duplicated hash/nonce, repeated request, forged client receipt, stale or conflicting chain evidence, off-origin calls, cross-tenant/viewer access, revoked share, replayed HMAC, unauthorized gate flags, mixed fixture/live journal. Test crash at claim/dispatch/hash/promotion and database restore; preserve claims. Test known conversion with expiry → block payout pending new legitimate continuation approval, never reset. Explicitly keep unknown attempt closure disabled. No active penetration tests against third-party production systems.

## Commands
Use README and .github/workflows/ci.yml as exact source. Root npm ci, npm run typecheck, npm test, npm run test:browser (Chromium). Worker npm ci/typecheck/test. Web npm ci/typecheck/test:model/build/test:browser/test:p104/test:p105 with appropriate local test server and browser path per CI. Full-stack: npm run demo:p12 -- product (disposable fixture) and CI e2e-auth-flow.mjs --product. node scripts/p12-config.mjs verifies closed release config. No live money in automated tests. Add new scripts only with actual implementation and update README.

## Product QA and performance
320/375/390/820/1024/1440 screenshots, 200% text, keyboard/forced-colors/reduced-motion, axe, no hidden focus, no horizontal overflow, no console errors. Link crawl public profile, clear availability notice, no wallet calls. Measure local production build load, network timeout behavior, largest JS chunk; target usable page under 2s excluding external requests. Report actual metrics not guarantees. Test degraded offline demo and dated snapshot separately from live check.

## Live gate checklist (owner approved)
Record exact reviewed commit, approved invoice, source of funds, recipient consent, cap and native fee limits (including allowance), wallet identity, live provider capabilities, actual quote and explicit approval at every send. Verify current chain/token addresses/decimals. No automatic retry. Confirm finalized conversion via both independent reads; stop process intentionally only after known conversion; reopen, reverify and approve only payout. Verify final payout and recipient acceptance. Keep actual transaction refs, observed block/time, tag and Loops credit; do not disclose credentials or private invoice details. Never rerun a real transaction solely to test or rehearse.

Complete means all R01–R12 pass with explicit offline/live evidence, successful exact-head CI, independently completed commercial job, no unresolved critical security/deployment issue and honest demo. If not, label status incomplete. Baseline reports remain historical.
