# Prioritised correction plan

Nothing in this plan has been implemented. Each item needs the owner's approval. Financial items stay behind their own separate authorisation. Order is by risk to the submission (deadline 7 December 2026, 09:00 GMT, per the organiser's message).

## Critical

| # | Issue | Why critical | Action | Owner decision needed |
| --- | --- | --- | --- | --- |
| C-01 | The public production deployment `daidai-product-ometere` (alias `daidai-celo.vercel.app`) was built from commit `1d9ca60`, which is not in the public repository. It carries backend variables, including `DAIDAI_FINANCIAL_DISPATCH` and `DAIDAI_HOSTED_PRODUCT`, that no code in the repository reads | A judge cannot reproduce what they see from the repository. Unknown code is publicly served with live service credentials and a dispatch flag of unknown value | Owner confirms what is served and where `1d9ca60` came from. Then either redeploy production from `main` with the public-release profile (no service key, dispatch absent) or protect the project until it matches the repository | Yes: which source is the real product, and whether to take the current production offline |
| C-02 | The headline capability (exact USDt→cNGN conversion plus payout) has never run outside simulation | Judges score technical authenticity; every settlement path is a fixture or a simulated dispatcher | Either (a) perform the separately authorised first settlement with finalized two-provider evidence, or (b) reposition the submission honestly as "verifiable settlement controls, live settlement pending", and demo the controls | Yes: separate financial authorisation |

## High

| # | Issue | Action | Effort |
| --- | --- | --- | --- |
| H-01 | Dead public nav and the hero's main button lead to 404 (D-01) | Gate nav items on `appEnabled()`; point the hero CTA at `/demo` | Small |
| H-02 | Registration headline reads "unresolved" whenever a provider is slow or blocked | Add a dated, labelled verified snapshot (block, timestamp, both receipts) next to the live check; keep the live check | Small |
| H-03 | No demo video, pitch, architecture diagram or live link in the README | Record a 2–3 minute walkthrough of `/demo` plus `/proof`; add a diagram of D1 → Worker → Next.js and the two settlement steps; link the live URL once C-01 is resolved | Medium |
| H-04 | Authenticated product does not use the brief's design (D-03) | Render authoritative data through the `/demo` components | Medium |
| H-05 | `/proof` and `/agent` have no hierarchy (D-04) | Verdict band, labelled hashes, separate registration and settlement panels | Small |
| H-06 | The landing page never shows the product (D-02) | Hero shows the ink slab and focus pane from `/demo` | Small |
| H-07 | Original rules and specifications are not in the repository (R32) | Owner supplies them; re-run the traceability baseline against the official judging criteria | Owner |
| H-08 | Textile integration has no recorded live evidence | One indicative quote (no reservation) from an unrestricted network, sanitized transcript committed | Small |

## Medium

| # | Issue | Action |
| --- | --- | --- |
| M-01 | Landmark structure (D-09) | One banner per page; no nested complementary |
| M-02 | No branded 404 and error pages (D-10) | `not-found.tsx` and `error.tsx` |
| M-03 | No share image, robots or sitemap (D-11) | Open Graph image from the approved logo |
| M-04 | Authenticated chrome inconsistencies and doubled titles (D-12) | Account menu, one read-only statement, fix metadata |
| M-05 | Double chrome on `/demo` (D-13) | Hide site nav inside the workspace |
| M-06 | Invoice creation form usability (D-14) | Examples, input modes, human expiry picker, primary button |
| M-07 | Apply the approved new logo (D-15) | Nav, favicon, app icon, share image |
| M-08 | No lint configured | Add the framework lint config and run it in CI |
| M-09 | Generated-page defaults on the landing page (D-05, D-06) | Remove eyebrow; replace feature trio with the plumb-line flow |

## Low

| # | Issue | Action |
| --- | --- | --- |
| L-01 | Side-tab stripe and small UI text on `/demo` (D-07, D-08) | Background tone for selection; minimum 12 px |
| L-02 | Motion standard deviations (M-02 to M-04 in `DESIGN_AUDIT.md`) | `ease-out` exits, custom curve on entrances, drop the per-navigation fade |
| L-03 | Calldata attribution and Loops enrollment are operator-confirmed only | Decode once and keep a dated record |

## Suggested sequence before 7 December

1. Resolve C-01 first: it is a public exposure question, not a design one.
2. Make the C-02 decision: settle for real, or reposition honestly.
3. H-01, H-02, H-05, H-06 together. They are small and transform the first minute a judge spends.
4. H-03: record the video once the pages above are fixed.
5. H-04 and the Medium items as time allows.
