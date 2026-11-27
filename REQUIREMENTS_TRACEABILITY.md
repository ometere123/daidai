# Requirements traceability

Baseline: the repository documents (README, P08–P13 records, the P09C design brief) and the delivery requests reflected in them. The original hackathon rules, Preliminary Build Specification, Master Build Specification and cross-examination notes are **not available** in the repository or the audit session, so rows trace to the earliest available source and anything older is flagged as blocked (R32). Nothing here is reconstructed from memory.

Audited head: `e999622` (main). Evidence paths are relative to `docs/audit/`.

## Status summary (32 requirements)

| Status | Count |
| --- | --- |
| Fully implemented and verified | 14 |
| Implemented but unverified | 6 |
| Partially implemented | 3 |
| Missing | 1 |
| Incorrectly implemented | 2 |
| Mocked or simulated | 4 |
| Blocked | 2 |
| Intentionally changed or removed | 0 |

Code existing is not counted as complete: every 'Fully implemented and verified' row has an executed test or a rendered inspection behind it.

## Matrix

### R01 — ERC-8004 identity for Daidai registered on Celo Mainnet

| Field | Detail |
| --- | --- |
| Source | P08-CLOSEOUT.md; README.md |
| Expected | Agent ID and registry transaction exist and are finalized |
| Actual | Agent #10103; registration tx recorded; /agent and /proof display it |
| Evidence | P08B23-REGISTRATION-OUTCOME.md; /proof screenshot |
| Verification | Read the repo evidence and rendered pages. Onchain re-check NOT possible here: Forno and Ankr are unreachable from the audit sandbox |
| Status | **Implemented but unverified** |
| Gap | The audit could not independently re-confirm the mint |
| Severity | Medium |
| Corrective action | Re-run `scripts/p12-celo-observe.mjs` from an unrestricted network and attach the output |

### R02 — Independent two-provider public verification of the registration

| Field | Detail |
| --- | --- |
| Source | P11-DELIVERY.md; P12-CONTROLLED-LAUNCH.md |
| Expected | /agent and /proof corroborate the mint with two providers |
| Actual | Implemented, fails closed to "unresolved" |
| Evidence | apps/web/app/agent, /proof; shots/proof-desktop.png |
| Verification | Rendered: both providers 'provider unavailable' in the sandbox, status 'unresolved' |
| Status | **Partially implemented** |
| Gap | A judge on a restrictive network sees 'unresolved' as the headline status; there is no labelled last-verified snapshot |
| Severity | High |
| Corrective action | Add a dated, clearly labelled verified snapshot beside the live check |

### R03 — Attribution tag in registration calldata

| Field | Detail |
| --- | --- |
| Source | P08-CLOSEOUT.md; WALLET-ARCHITECTURE-DECISION.md |
| Expected | One attribution suffix on the registration transaction |
| Actual | Documented as present; operator confirmed in the organizer dashboard |
| Evidence | P08-CLOSEOUT.md |
| Verification | Documentation read only; calldata not decoded (no RPC) |
| Status | **Implemented but unverified** |
| Gap | Not independently decoded in this audit |
| Severity | Low |
| Corrective action | Decode the registration calldata once and record the suffix check |

### R04 — Loops enrollment confirmed

| Field | Detail |
| --- | --- |
| Source | P08-CLOSEOUT.md |
| Expected | Operator confirmed dashboard checks |
| Actual | Recorded as confirmed by the operator |
| Evidence | P08-CLOSEOUT.md |
| Verification | External dashboard, not reachable |
| Status | **Implemented but unverified** |
| Gap | External state, unverifiable here |
| Severity | Low |
| Corrective action | Keep a dated screenshot as evidence |

### R05 — Exact-amount cNGN recipient commitment, immutable once committed

| Field | Detail |
| --- | --- |
| Source | README.md; P10.2 |
| Expected | Commitment digest binds amount, tokens, recipient, taker, revision |
| Actual | Implemented; digest shown on invoice detail |
| Evidence | workers/api tests; shots-product/invoice-detail-mobile.png |
| Verification | Worker/D1 tests 158/158; full-stack journey 30/30 |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R06 — Maximum all-in USDt debit cap enforced before conversion

| Field | Detail |
| --- | --- |
| Source | README.md; P10.x |
| Expected | Quotes above the cap are rejected |
| Actual | Cap logic implemented and unit-tested against fixture quotes |
| Evidence | src/, test/ (279 tests) |
| Verification | Root tests 279/279; no live quote exercised |
| Status | **Mocked or simulated** |
| Gap | Enforcement proven only against fixtures |
| Severity | Medium |
| Corrective action | Exercise against a live indicative quote (no reservation) and record the result |

### R07 — Conversion and payout are separate, independently evidenced steps

| Field | Detail |
| --- | --- |
| Source | README.md; P08B22 |
| Expected | Two attempts, two evidence trails, separate approvals |
| Actual | Implemented in lineage and UI; dispatch is simulated |
| Evidence | src/claim-coordinator.ts; /invoices/[id] |
| Verification | Tests pass with a simulated dispatcher only |
| Status | **Mocked or simulated** |
| Gap | No real dispatch exists in the codebase by design |
| Severity | High |
| Corrective action | First real settlement is a separately authorised milestone |

### R08 — Textile indicative pricing (no reservation)

| Field | Detail |
| --- | --- |
| Source | P11/P12; P13-DELIVERY.md |
| Expected | Live indicative quote or 'Quote unavailable' |
| Actual | Integration code exists; CI runs with the preview disabled |
| Evidence | scripts/p11-textile-preview.mjs; apps/web /pay |
| Verification | Not exercised live in this audit (egress) |
| Status | **Implemented but unverified** |
| Gap | No recorded live quote in the repo |
| Severity | High |
| Corrective action | Run once against the live endpoint and commit the sanitized transcript |

### R09 — Textile firm RFQ and USDt→cNGN settlement

| Field | Detail |
| --- | --- |
| Source | WALLET-ARCHITECTURE-DECISION.md |
| Expected | Firm quote, conversion, payout on Celo |
| Actual | Adapter and tests only; no live settlement has ever happened |
| Evidence | WALLET-ADAPTER-TEST-REPORT.md ('Still blocked for live use') |
| Verification | Documentation and tests |
| Status | **Mocked or simulated** |
| Gap | The headline capability has never run for real |
| Severity | Critical |
| Corrective action | Authorised, funded, single-transaction settlement with finalized two-provider evidence |

### R10 — No autonomous signing; dedicated wallet owner approves each operation

| Field | Detail |
| --- | --- |
| Source | README.md |
| Expected | No key or signer in the product |
| Actual | No signer, key or broadcast path in the codebase; wallet calls = 0 in browser journeys |
| Evidence | e2e output; history secret scan |
| Verification | 30/30 journey checks include 'no wallet-provider calls' |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R11 — Invoice-bound approval and recipient consent signatures verified

| Field | Detail |
| --- | --- |
| Source | P10.x |
| Expected | Both signatures verified, unexpired, digest-bound |
| Actual | Implemented; 'Verified' rows with signer, audience, digest, expiry |
| Evidence | shots-product/invoice-detail-mobile.png |
| Verification | Worker tests and journey |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R12 — Tenant isolation and capability revocation

| Field | Detail |
| --- | --- |
| Source | P10.3; P10.5 |
| Expected | Cross-tenant invoice never readable |
| Actual | Cross-tenant read returns 'not available' |
| Evidence | e2e: cross-tenant check |
| Verification | Worker tests and journey |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R13 — Service HMAC auth, replay protection, CSRF, hardened session cookie

| Field | Detail |
| --- | --- |
| Source | P10.5; P13 |
| Expected | Signed requests, nonce table, __Host- HttpOnly Secure SameSite=Strict |
| Actual | Implemented and tested |
| Evidence | e2e cookie checks; adversarial tests |
| Verification | Worker tests, journey |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R14 — Private routes closed in the public release profile

| Field | Detail |
| --- | --- |
| Source | P13-DELIVERY.md |
| Expected | 404 with no-store |
| Actual | 404 for /login, /invoices, /activity, /api/session, /api/product |
| Evidence | TEST_RESULTS.md route matrix |
| Verification | curl matrix against a production build |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R15 — No automatic retry after an unknown financial outcome

| Field | Detail |
| --- | --- |
| Source | P10.5 claim coordinator |
| Expected | Unknown outcome blocks further attempts |
| Actual | Implemented against a simulated dispatcher |
| Evidence | test/p105-claim-coordinator.test.ts |
| Verification | Root tests |
| Status | **Mocked or simulated** |
| Gap | Proven only in simulation |
| Severity | Medium |
| Corrective action | Re-prove during the authorised first settlement |

### R16 — UI never claims 'Settled' without verified evidence

| Field | Detail |
| --- | --- |
| Source | P09C; P10 |
| Expected | Reconciliation required when evidence is missing |
| Actual | Invoice detail shows 'Reconciliation required' and 'No verified chain evidence' |
| Evidence | shots-product/invoice-detail-mobile.png |
| Verification | Rendered and read |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R17 — Ink and Brass identity per the P09C spec on the demo workspace

| Field | Detail |
| --- | --- |
| Source | P09C spec |
| Expected | Ink slab, brass marks, status glyphs, spec-mandated demo violet |
| Actual | Faithful on /demo |
| Evidence | shots/demo-desktop.png, demo-mobile.png |
| Verification | Rendered at desktop and mobile; spec read line by line for palette and demo strip |
| Status | **Fully implemented and verified** |
| Gap | None found on /demo itself |
| Severity | — |
| Corrective action | — |

### R18 — Ink and Brass applied across the whole product

| Field | Detail |
| --- | --- |
| Source | P09C spec |
| Expected | One system on every screen |
| Actual | Private product pages use generic stacked bordered cards, raw ids, no ink slab or status marks |
| Evidence | shots-product/invoices-desktop.png, invoice-new-desktop.png |
| Verification | Rendered and compared with /demo |
| Status | **Partially implemented** |
| Gap | Two visual languages; the real product is the weaker one |
| Severity | High |
| Corrective action | See DESIGN_AUDIT.md D-03 |

### R19 — Mobile hierarchy: next action first, sticky action bar

| Field | Detail |
| --- | --- |
| Source | P09C spec |
| Expected | Primary action never at the end of a long scroll |
| Actual | Implemented on /demo list; the sticky action bar was not exercised |
| Evidence | shots/demo-mobile.png |
| Verification | List screen rendered at 390 px only |
| Status | **Implemented but unverified** |
| Gap | Action-bar and review dialog not inspected |
| Severity | Medium |
| Corrective action | Inspect the review dialog and sticky bar at 375 px |

### R20 — Motion: under 250 ms, no transition:all, one authored moment, reduced-motion variants

| Field | Detail |
| --- | --- |
| Source | P09C spec §11 |
| Expected | Disciplined motion |
| Actual | CSS conforms; no transition:all; reduced-motion block present |
| Evidence | apps/web/app/daidai.css |
| Verification | Static CSS audit; computed animations under reduced motion = 0 on home |
| Status | **Implemented but unverified** |
| Gap | Runtime motion on dialogs and verdict not recorded |
| Severity | Low |
| Corrective action | Record a short capture of the verdict moment |

### R21 — Accessibility baseline: focus, landmarks, skip link, targets

| Field | Detail |
| --- | --- |
| Source | P09C; guidelines |
| Expected | No serious axe violations |
| Actual | 0 serious; moderate landmark issues; 6 sub-24 px targets per page |
| Evidence | shots/report.json |
| Verification | axe-core 4.10.2 on 15 public renders |
| Status | **Partially implemented** |
| Gap | Landmark structure and small targets |
| Severity | Medium |
| Corrective action | DESIGN_AUDIT.md D-09 |

### R22 — Demo is synthetic and labelled, nothing onchain

| Field | Detail |
| --- | --- |
| Source | P13 |
| Expected | Visible label on every demo screen |
| Actual | 'Demo workspace. Nothing here happened onchain.' strip |
| Evidence | shots/demo-*.png |
| Verification | Rendered |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R23 — Public pages: landing, /agent, /proof, /demo, /pay availability notice

| Field | Detail |
| --- | --- |
| Source | P13 |
| Expected | All return 200 |
| Actual | All return 200 with no console errors |
| Evidence | shots/report.json |
| Verification | 15 renders, 0 console errors, 0 failed requests |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R24 — Multipage product with working navigation

| Field | Detail |
| --- | --- |
| Source | P13 request |
| Expected | Every nav item works in every profile |
| Actual | Nav shows Invoices, Activity and Sign in on the public site; all three, and the hero CTA, return 404 |
| Evidence | TEST_RESULTS.md link crawl |
| Verification | Link crawl of 5 public pages |
| Status | **Incorrectly implemented** |
| Gap | 3 of 6 nav items plus the primary CTA are dead ends |
| Severity | High |
| Corrective action | Hide private links when the gate is closed; point the CTA at /demo |

### R25 — No fabricated transactions, traction or live activity

| Field | Detail |
| --- | --- |
| Source | P13 |
| Expected | Honest copy |
| Actual | Copy states no settlement exists; lint found no hype |
| Evidence | taste copy-lint output |
| Verification | Rendered and linted |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R26 — Hosted authenticated product

| Field | Detail |
| --- | --- |
| Source | P13; P12 |
| Expected | Hosted Worker + D1 + identity provider |
| Actual | No hosted backend in the repo. Yet the Vercel project holds production backend variables |
| Evidence | TEST_RESULTS.md Vercel section |
| Verification | Read-only Vercel inspection |
| Status | **Blocked** |
| Gap | Blocked on identity provider and operator approval; see C-01 |
| Severity | Critical |
| Corrective action | Resolve provenance first |

### R27 — Public Vercel deployment only after owner approval of exact destination

| Field | Detail |
| --- | --- |
| Source | P13 request |
| Expected | Deployment follows an approved packet |
| Actual | Production deployments exist from a commit not in this repository |
| Evidence | Vercel API (project prj_eH2I…) |
| Verification | Read-only Vercel inspection |
| Status | **Incorrectly implemented** |
| Gap | Provenance gap; see C-01 |
| Severity | Critical |
| Corrective action | Owner to confirm what is served and from which source |

### R28 — Public repo reviewable: README, license, offline tests, CI

| Field | Detail |
| --- | --- |
| Source | hackathon review |
| Expected | Clean clone builds and tests offline |
| Actual | README, Apache-2.0, `npm test` 279/279 offline; CI green on main |
| Evidence | TEST_RESULTS.md; Actions run 46010946874 |
| Verification | Clean-clone install and run |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R29 — Secrets hygiene across code and history

| Field | Detail |
| --- | --- |
| Source | standing rule |
| Expected | No keys, tokens or private RPC URLs |
| Actual | None found in tree or 98-commit history |
| Evidence | evidence/ |
| Verification | Pattern scan |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R30 — Dependency vulnerabilities

| Field | Detail |
| --- | --- |
| Source | standing rule |
| Expected | None known |
| Actual | 0 vulnerabilities in root, web and worker |
| Evidence | evidence/npm-audit.txt |
| Verification | npm audit, dev dependencies included |
| Status | **Fully implemented and verified** |
| Gap | None found |
| Severity | — |
| Corrective action | — |

### R31 — Hackathon submission artifacts: demo video, pitch, architecture diagram, demo link in README

| Field | Detail |
| --- | --- |
| Source | hackathon review |
| Expected | Judge can understand and try it in minutes |
| Actual | None in the repository |
| Evidence | repo tree |
| Verification | Absence confirmed |
| Status | **Missing** |
| Gap | Nothing for a judge to watch or click end to end |
| Severity | High |
| Corrective action | See PRIORITISED_CORRECTION_PLAN.md |

### R32 — Original hackathon rules, Preliminary and Master Build Specification, cross-examination notes

| Field | Detail |
| --- | --- |
| Source | this audit's brief |
| Expected | Used as the baseline |
| Actual | Not in the repository; the earliest available design brief is the P09C spec |
| Evidence | — |
| Verification | Searched repo and session history |
| Status | **Blocked** |
| Gap | Baseline reconstructed from repo documents only; rules not independently verified |
| Severity | High |
| Corrective action | Owner to supply the original documents |

