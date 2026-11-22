# Daidai P09B Plumb UI implementation

The Plumb prototype lives in `apps/web` with its own dependency lockfile, Next.js App Router, TypeScript, Tailwind and a Radix dialog styled using the shadcn dialog pattern. The transaction harness, wallet host, registration flow, root dependencies and environment configuration remain independent. The prototype has no wallet provider integration, Textile client, RPC configuration or dispatch endpoints.

## Preview

From the repo root, run `npm ci`, then `npm --prefix apps/web ci`. Run `npm --prefix apps/web run build` and `npm --prefix apps/web run start -- --hostname 127.0.0.1 --port 3219`.

| Screen | Local path |
| --- | --- |
| Invoice dashboard | `/` |
| Empty dashboard | `/?data=empty` |
| Invoice details and quote | `/?invoice=INV-0042` |
| Settlement progress | `/?invoice=INV-0038&view=progress` |
| Settlement receipt | `/?invoice=INV-0032&view=progress` |
| Needs reconciliation | `/?invoice=INV-0039&view=progress` |

The three screens use central Plumb tokens, locally bundled Schibsted Grotesk and JetBrains Mono, fixed recipient targets, USDt-only gauges and accessible operator review dialogs. The dashboard lists five ordered groups. New invoices and simulated transitions use in-memory fixtures and reset on reload. The reviewed artifact is submitted as a private branch, awaiting design review before merge.

The displayed recipient consent represents invoice-bound EIP-712 evidence in a fixture. The operator EOA is the taker/signer role, separate from invoice approval. The allowance is bounded by the invoice maximum. The quote fee is part of takerPays and network fees are separate. Conversion reaches the taker first. The receipt requires matched recipient and amount evidence and an in-cap spend. An unresolved submission offers no retry. All amounts, evidence, hashes, fee estimates and showing a settled receipt are demo-only. The Celoscan affordance opens the explorer home because fixture hashes do not identify public transactions. PDF export uses the browser's print-to-PDF feature.

## Verification

- Production build and strict frontend TypeScript passed. The root regression suite passed 54/54 with strict TypeScript checking.
- `npm --prefix apps/web run test:browser` passed 7/7, including the amount and state checks and six Chromium scenarios against the running local preview. Set `PLUMB_SCREENSHOTS` to a directory to reproduce nine PNGs at 375, 768 and 1440 px.
- The scenarios cover responsive bounds, keyboard modal entry and focus return, reduced-motion viewports, quote expiry, an uncertain payout without Retry, exact formatting and a mocked conversion followed by payout submission that stays unsettled. The latter also checks landscape at 200% root font size. An injected provider spy must receive zero calls.
- Visual inspection found the tablet receipt's gauge split a token unit across lines. The instrument now switches to its horizontal layout only when its own container has at least 600 px.
