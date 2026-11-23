# P11 Delivery

P10.5 merged through PR #7. This branch adds an isolated, non-spending merchant and payer workflow around the existing authenticated Worker and Next.js application.

## Checkpoint 0

The base is the P10.5 normal merge commit. Its approved head passed all seven CI jobs. P11 tests have not run yet. Each checkpoint SHA is recorded by Git and the pull request.

## Architecture and acceptance

- Next.js owns the merchant and payer UI and the server-side signed Worker client.
- The Worker authorizes every invoice operation. D1 owns tenant permissions, draft revisions and immutable commitments. Product writes are confined to the local test runtime.
- Share capabilities are scoped, expiring, revocable and convey read-only access.
- Payment preparation shows the exact cNGN target and maximum all-in USDt debit. Simulated quotes and observations have distinct provenance from independently verified chain evidence.
- Browser and Worker tests must exercise the full create, edit, commit, share and payer review flow, including concurrent and unauthorized operations.
- CI must pass on the final head. Production identity, deployment and any financial execution require separate review and authorization.

Next action is to implement the versioned invoice contract and local D1 persistence. Public Celo RPC and official Textile interfaces still need qualification.

## Checkpoint 1

`ab5fe96` opened draft PR #8. Versioned product contracts and the loopback Worker route now use existing service HMAC, replay and session guards. Product D1 tables track immutable revisions, idempotency, merchant access and hashed share records. Product commitments use the existing invoice digest and do not enter financial attempt stores.

Tests are pending for this checkpoint. Next action is to wire the authenticated merchant and payer pages, then exercise the Worker and browser paths. No external service is needed for this slice.

## Checkpoint 2

`d164bdc` added the Worker/D1 product boundary. This checkpoint connects the authenticated merchant and payer screens, the signed server client, immutable revision history, and one-invoice read-only share links. Simulation uses documented Textile preview fields and a local review expiry. The product accepts no wallet or execution requests. Frontend strict TypeScript passed. The full-stack and D1 adversarial tests are next. Public RPC remains unqualified.


## Checkpoint 3

`bf3298f` wired the customer pages. The isolated D1 product tests now pass 6/6, including idempotent creation, revision races, immutable history, restart persistence, tenant and merchant isolation, scoped expiring/revocable sharing and database failure. Worker strict TypeScript passed after explicitly modeling the product request union. Next action is the end-to-end browser test and Celo/Textile evidence checkpoint. D1 and Next run on disposable local state only.


## Checkpoint 4

`1976543` verified the customer D1 boundary. Seven Textile preview contract tests passed. They check the documented preview request shape, exact cNGN, fee-inclusive USDt debit, deadline, no liquidity and rejection of a firm-quote payload. The app uses the deterministic source only. Official interface: https://docs.textilecredit.com/api/v2/rfq.html.

The public Forno probe used the existing four-method read-only transport against P08 registration evidence. It did not establish canonical finality: one probe failed receipt evidence validation and a follow-up timed out. Record this as blocked pending a qualified Celo provider. Deterministic Celo verification remains in the root suite. Active product commitments have no approved production payout observation pipeline.

Next action is to checkpoint the browser validation, then review dependency advisories and refresh the full CI run.


## Checkpoint 5

`9e0ed52` recorded Textile and Celo evidence. The newly reseeded local Miniflare D1 → Worker → Next.js production build → Chromium flow passed 28/28 checks, including 11 P11 product checks at a 390 px viewport. It created, edited and committed 1,500 cNGN, opened a scoped read-only payer view, displayed 1.001 USDt including the simulated fee, blocked cross-origin writes, demonstrated uncertain payout, revoked access and cancelled without erasing the commitment. Zero wallet-provider calls. CI now runs the same full-stack flow.

Reproduce from the repository root with Node 22 and Playwright Chromium: run npm ci in the root, apps/web and workers/api, then run the following. The seed resets only the ignored, disposable Worker D1 store.

```sh
npm --prefix apps/web run build
npm --prefix workers/api run seed
node workers/api/scripts/e2e-auth-flow.mjs --product
```

Next is dependency remediation and final security/operational review.


## Checkpoint 6

`820e4ac` added the browser integration. The next changes bind share capability generation to server-side entropy and the authenticated session, narrow merchant checks on D1 mutations, and apply explicit private/no-store and no-referrer headers on product views. The browser test now checks the narrow viewport for overflow. The extra fixed-endpoint Textile transport raises the quote and transport contract suite to 9/9. Its credentialless external probe returned unavailable, so the demo remains deterministic.

The earlier CI run exposed a NodeNext import-resolution mismatch. The root-compiled server imports now use explicit TypeScript extensions. Final CI and the updated dependency validation are pending. Next actions are the Worker toolchain audit, rerunning the integrated flow and recording exact-head CI.


## Checkpoint 7

`22431db` hardened the product route boundary. This checkpoint binds new product digests to tenant and invoice identity, adds a typed simulated observation that cannot produce a settled result, and documents the demo, isolated migration and launch runbook in P11-DEMO-AND-OPERATIONS.md.

The Worker upgrades Miniflare, esbuild and viem, removes unused Wrangler from the local dependency graph, and pins patched sharp, undici and Zod versions. The Worker npm audit on the updated lock reports zero findings. The P11 D1 suite passed 7/7 on Miniflare 4 before the patched transitive lock was applied. The focused quote, transport and observation suite passed 10/10. The browser flow passed 28/28 before the final UI hardening. Full final verification uses the new exact-head Actions run; the public Celo and Textile probes remain unqualified. Next action is to verify all jobs and review readiness without enabling product routes outside isolated storage.
