# P13 multipage delivery
P12 was already merged normally at f4f4b6db66b7ef8f89a2d285c586b9807f0a8272. Approved head and seven passing jobs reconfirmed.

| Area | Acceptance |
| --- | --- |
| Public | Separate landing, agent, proof and synthetic demo |
| Private | Authenticated invoice creation, history, activity and scoped payer review |
| Evidence | Independent canonical Celo observation and validated indicative Textile pricing |
| Release | Reproducible build and CI, explicit owner approval before publication |

Checkpoint 0. Next: public route shell and authenticated navigation. No P13 tests run yet.

Checkpoint 1. Added focused landing and shared navigation. Moved the existing fixture workspace to /demo and updated browser targets. Verification pending. Next: wire dedicated invoice and activity routes.

Checkpoint 2. Dedicated creation, invoice detail and activity routes reuse authenticated D1 and authoritative evidence. New canonical invoice paths preserve the older merchant routes. Wallet readiness uses only a user-initiated chain ID read. Tests pending. Next: replace payer simulations and connect live observation.

Checkpoint 3. Payer now requests only validated live Textile indicative pricing and shows Quote unavailable on failure. Synthetic payout activation was removed from the authenticated route. Public registration verification checks chain, receipt, two canonical reads, ERC-721 mint and finality on Forno and Ankr. Next: assemble public proof and rule audit.

Checkpoint 4. Added /agent and /proof with current provider observations and explicit rule outcomes. /activity and /pay expose only session-scoped, request-time rule records. No fabricated durable decision history. Live sample: Ankr passed the registration mint and finality checks, while Forno omitted the receipt. Result unresolved. Next: lock the Vercel release profile and verify routes.

Checkpoint 5. Proposed Vercel project daidai-product-ometere under the existing personal Hobby scope delealufejoel-4184s-projects, production environment, expected URL https://daidai-product-ometere.vercel.app, apps/web on Node 22 with shared source enabled. Public routes: /, /pay (availability only), /agent, /proof and /demo. The build retains authenticated development code but the public profile overrides all private flags and blocks login, invoices, activity, merchant and session/product mutations. Cloudflare/D1 disconnected; no execution; no paid resources. Existing earlier static demo remains separate. Do not create or deploy this project until explicit owner approval. Next: tests and adversarial review.

Checkpoint 6. Added mobile and desktop public-route smoke, private gate and cache checks, proof failure tests, decision regressions and authenticated activity coverage. Next: run all CI and publish the owner approval packet.

## Recovery of the interrupted work

**Recovered:** remote `p13-real-product-vercel` @ `43c4091` (checkpoints 0–6), in a clean worktree. The earlier local machine was not attached to this environment, so any uncommitted local changes could not be inspected or recovered. Everything previously pushed is preserved; no history was rewritten.

**Actual state of the recovered head:** the full suite had never been run. Running it found these failures:
- **Smoke:** private routes returned **200**, not 404, in the public profile.
- **P10.5 auth suite:** 2/5 (redirects to /login broken).
- **Full-stack product journey:** stopped at several steps.
- **Fixture browser suite:** 13/14.
- **Worker adversarial suite:** intermittent.

| Checkpoint | Commit | Fix |
| --- | --- | --- |
| 7 | `e50f0bf` | `apps/web/proxy.ts`: private routes get a real 404 (no-store, noindex) whenever the gate is closed, before any page, layout or loading boundary runs. The 375 px focus test now checks real occlusion; it had flagged the new, fully visible site navigation |
| 8 | `e339e95` | Removed the `(app)` group loading boundary. It streamed a 200 before `requirePrivate()` could return 404 or redirect to /login. Worker per-key rate budget raised from 60 burst / 1 per s to 600 / 10 per s: it is keyed by the single Vercel service identity shared by every user, and the journey hit 429 on its 60th call |
| 9 | `0300320` | ADV-2 read-path test: allowlisted the probabilistic replay-nonce prune, which caused the intermittent failure, and added a positive "no financial-table writes" assertion |
| 10 | `07db265` | Distinct page titles; `/demo` labelled "Demo (synthetic data)" |

## Final verification (local, at `07db265` and later)

| Suite | Result |
| --- | --- |
| `p12-config` | Pass |
| Root strict TypeScript | Pass |
| Root backend | **279/279** |
| Root browser | **33/33** |
| Worker typecheck | Pass |
| Worker/D1 | **158/158** (ADV-2 0 failures in 25 consecutive runs) |
| Web typecheck | Pass |
| Web model | 4/4 |
| P10.4 | 3/3 |
| P10.5 auth | **5/5** |
| Production builds (plain and demo) | Pass |
| Fixture browser | **14/14** |
| P13 product smoke (default env, and the exact public-release env values) | Pass: public routes at 375 and 1440 px, zero wallet calls, private routes 404 + no-store, no session cookie |
| Full-stack authenticated merchant → payer journey (real local D1 → Worker → Next.js → Chromium) | **30/30** |
| CI secret scan | Clean |
| `npm audit` (root, web, workers, including dev dependencies) | 0 vulnerabilities |

**Security headers** (public-release profile):
- **Everywhere:** `X-Frame-Options: DENY` and `nosniff`.
- **Private routes** (`/invoices`, `/invoices/new`, `/invoices/[id]`, `/activity`, `/login`, `/api/session`, `/api/product`): 404 with `private, no-store`, including case and percent-encoding variants.

## Route inventory (multipage)

| Route | Public release profile | Authenticated local product |
| --- | --- | --- |
| `/` | 200, landing | Same |
| `/agent` | 200, ERC-8004 #10103, request-time Forno/Ankr observation | Same |
| `/proof` | 200, registration evidence kept separate from settlement evidence ("No verified USDt conversion or cNGN payout has been published") | Same |
| `/demo` | 200, isolated synthetic fixture workspace, labelled | Same |
| `/pay` | 200, availability notice only | Scoped payer review: committed terms, validated Textile indicative quote or **"Quote unavailable"**, user-initiated wallet chain-ID read only |
| `/login` | 404 | Invitation sign-in |
| `/invoices`, `/invoices/new`, `/invoices/[id]` | 404 | List, creation, detail (immutable revisions, cancel) |
| `/activity` | 404 | Session-scoped evidence and rule outcomes, "Not settled" |

## Live integration status (honest)

- **Celo (registration only):**
  - `/agent` and `/proof` read Forno and Ankr at request time. Agent #10103 is **"unresolved"** unless both providers agree on a successful, finalized mint and canonical block.
  - The last earlier live sample: Ankr passed, while Forno omitted the receipt, so it was unresolved.
  - From this sandbox both providers are blocked by the egress policy and show "provider unavailable". This was not re-verified live here.
- **Settlement evidence:** none exists. No real conversion or payout has ever been made.
- **Textile:**
  - Indicative pricing only, validated, with no reservation.
  - It shows "Quote unavailable" on any failure.
  - CI runs with `DAIDAI_LOCAL_TEXTILE_PREVIEW=0`; a live quote was not exercised from this sandbox.

## Vercel deployment approval packet (NOT deployed)

| Item | Value |
| --- | --- |
| Account scope | Existing personal Hobby scope `delealufejoel-4184s-projects`. No upgrade, no purchase |
| Project | `daidai-product-ometere`. **Existence not verified**: no Vercel CLI or credentials in this environment, and no owner machine attached. Owner to run `vercel whoami` and `vercel project ls --scope delealufejoel-4184s-projects` |
| Environment and URL | Production at `https://daidai-product-ometere.vercel.app` (expected; Vercel assigns the final alias) |
| Build | Root directory `apps/web`, "include source files outside root directory" ON, Node 22.x; install `npm --prefix ../.. ci && npm ci`; build `npm run build` |
| Environment values | `DAIDAI_PUBLIC_RELEASE=1`, `DAIDAI_APP_ENABLED=0`, `DAIDAI_PREVIEW_ACCESS=0`, `DAIDAI_LOCAL_PRODUCT=0`. No service key, no API base URL, no secrets |
| Public routes | `/`, `/agent`, `/proof`, `/demo`, and `/pay` (availability notice only) |
| Closed routes | `/login`, `/invoices/**`, `/activity`, `/merchant/**`, `/api/session/**`, `/api/product/**`: real 404 via `proxy.ts` and the page gate |
| Data sources | Public Celo JSON-RPC (Forno, Ankr) for registration observation only. Synthetic fixtures on `/demo`. No Cloudflare Worker or D1: the backend is not hosted |
| Financial restrictions | No signing, approvals, transactions, firm RFQs, retries, D1 migrations or registration replay. This deploy is a **frontend-only public profile, not a working payment backend** |
| Separate from | The earlier synthetic demo (PR #10, `https://daidai-demo-ometere.vercel.app`) |

**Owner approval needed:** create or deploy this exact project, environment, scope and route set. Nothing has been deployed.
