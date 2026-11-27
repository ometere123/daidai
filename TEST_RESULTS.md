# Test results

All results below were produced in this audit on 2026-11-27 against `main` at `e999622`, from a fresh clean clone with `npm ci`. Raw outputs are in `docs/audit/evidence/`. No real funds, signatures, approvals or broadcasts were involved; no production data was touched.

## Automated suites

| Suite | Command | Result |
| --- | --- | --- |
| Configuration gate | `node scripts/p12-config.mjs` | Pass |
| Root strict TypeScript | `npm run typecheck` | Pass |
| Root unit and integration | `npm test` | **279 / 279** pass, 0 skipped |
| Worker strict TypeScript | `workers/api: npm run typecheck` | Pass |
| Worker and D1 | `workers/api: npm test` | **158 / 158** pass, 0 skipped |
| Web strict TypeScript | `apps/web: npm run typecheck` | Pass |
| Web model | `apps/web: npm run test:model` | **4 / 4** pass |
| Production build | `apps/web: npm run build` | Pass; 21 routes plus the request proxy |
| Full-stack journey: seeded local D1 → Worker → Next.js production build → Chromium | `workers/api: npm run seed && node scripts/e2e-auth-flow.mjs --product` | **30 / 30** checks pass |
| Dependency audit | `npm audit` in root, web and worker, dev dependencies included | **0** vulnerabilities in each |
| Secret scan | Pattern scan of the tree and all 98 commits | Clean |
| Continuous integration | GitHub Actions on `main` | Run 46010946874 on `e999622`: success |
| Lint | — | **No lint script exists** in any package |

The CI run linked above passed. The two earlier runs on the new repository were cancelled by newer pushes, not failed.

## Full-stack journey (what the 30 checks cover)

- Unauthenticated private pages redirect to sign-in.
- Sign-in with a single-use invitation.
- Invitation reuse is refused with a uniform message.
- The session cookie is `__Host-`, HttpOnly, Secure, SameSite=Strict, and unreadable from page script.
- Tenant-scoped list, with the cross-tenant invoice refused.
- The invoice detail shows the commitment digest, "Outcome unknown" and "Reconciliation required"; it never shows "Settled" without evidence.
- The merchant-to-payer product flow.
- Logout clears the session.
- Preview without explicit access returns 404 for private pages even with a valid cookie.
- Zero wallet-provider calls across every page.

## Route and header matrix (production build, public release profile)

| Route | Status | Notes |
| --- | --- | --- |
| `/` | 200 | |
| `/agent` | 200 | |
| `/proof` | 200 | |
| `/demo` | 200 | Synthetic, labelled |
| `/pay` | 200 | Availability notice only |
| `/login`, `/invoices`, `/invoices/new`, `/activity` | 404 | `private, no-store` |
| Unknown path | 404 | Framework default page |

## Link crawl of the public profile (5 pages)

| Link | Target status | Appears on |
| --- | --- | --- |
| Invoices (nav) | **404** | 5 of 5 pages |
| Activity (nav) | **404** | 5 of 5 pages |
| Sign in (nav) | **404** | 5 of 5 pages |
| Create an invoice (hero primary button) | **404** | `/` |
| Pay, Agent, Proof, Demo, the logo, the demo filters and invoices | 200 | — |
| Celoscan registration transaction | external | `/proof` |

## Browser inspection (15 public renders + 15 authenticated renders)

| Measure | Public | Authenticated |
| --- | --- | --- |
| Viewports | 1440×900, 820×1180, 390×844 | same |
| Console errors or warnings | 0 | 0 |
| Failed network requests | 0 | 0 |
| Third-party hosts contacted by the browser | none | none |
| Horizontal overflow | none | none |
| `h1` per page | exactly 1 | — |
| axe-core 4.10.2 serious or critical | 0 | not run |
| axe-core moderate | landmark issues on `/`, `/demo`, `/pay` | not run |
| Targets under 24 px | 6 per page (nav-level) | — |
| Load to network idle (local) | 580–730 ms | — |
| Reduced motion: running animations on `/` | 0 | — |
| Keyboard focus visible on every stop | yes (2 px brass outline) | — |

Largest client JavaScript chunk: 229 KB uncompressed; all client chunks 736 KB uncompressed on disk.

Authenticated page titles: `Invoices · Daidai — Daidai` and `Authoritative invoice · Daidai — Daidai` (doubled), and `/invoices/new` and `/activity` fall back to the site default.

## Sponsor and chain integrations

| Integration | Exercised here? | Result |
| --- | --- | --- |
| Celo registration observation (Forno and Ankr) | Yes | Both unreachable from the audit sandbox. The pages correctly show "provider unavailable" and "unresolved" instead of guessing. Not a product bug, but it is what a judge sees if a provider is slow or blocked |
| Textile indicative quote | No | Disabled in CI; no outbound access here. There is no recorded live quote in the repository |
| Textile firm RFQ, conversion, payout | No | Never performed anywhere, by design |
| ERC-8004 registration | Indirectly | Transaction hash and agent ID are in the repo and pages; not re-read onchain here |

## Live deployment (read-only inspection of the Vercel account)

| Project | Exists | Production deployments | Notes |
| --- | --- | --- | --- |
| `daidai-demo-ometere` | yes (created 2026-11-23 19:00 UTC) | — | Synthetic demo |
| `daidai-product-ometere` | **yes** (created 2026-11-23 22:00 UTC) | **2, both READY**, the latest 2026-11-23 23:46 UTC | Aliases include `daidai-celo.vercel.app`. Vercel Authentication protects previews only, so production is public. Built from commit `1d9ca60`, which is **not in this repository**. Production variables include `DAIDAI_API_BASE_URL`, the service key pair, `DAIDAI_APP_ENABLED`, `DAIDAI_HOSTED_PRODUCT` and `DAIDAI_FINANCIAL_DISPATCH`; the last two are not referenced anywhere in this code |

Values were not decrypted, and the live page was not fetched. Fetching through the account would have created a share link, and the sandbox cannot reach `vercel.app` directly. What the live site serves is therefore unverified.

## Not tested, and why

- **Live Textile and live Celo calls:** no outbound access to those hosts here.
- **Authenticated pages under axe:** not run in this pass.
- **The review dialog and sticky action bar on `/demo` at 375 px:** not driven.
- **Lighthouse:** not run.
- **Lint:** none configured.
