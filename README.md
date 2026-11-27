# Daidai

**Agents Open for Business on Celo.** Daidai is an agent that prepares exact-amount stablecoin invoice settlement on Celo: a USDt-to-cNGN conversion and a separate exact cNGN payout, each approved by a dedicated wallet owner.

## Agent identity (ERC-8004)

| | |
| --- | --- |
| Agent ID | **10103** |
| Network | Celo Mainnet (chain 42220) |
| Registered by | `0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e` |
| Registration transaction | `0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b` |
| Metadata | [DAIDAI-ERC8004-METADATA.json](DAIDAI-ERC8004-METADATA.json) |

Details: [registration outcome](P08B23-REGISTRATION-OUTCOME.md). The `/agent` and `/proof` pages re-check this registration against two public Celo RPC providers at request time. If either provider is unreachable or they disagree, they report **unresolved** rather than guessing.

## Honest status

- **No live settlement has happened.** No USDt has been converted and no cNGN paid out. The first real settlement is a separately authorised milestone. `/proof` keeps registration evidence apart from settlement evidence and says so.
- Textile pricing is **indicative only**, with no reservation. If a quote cannot be fetched or validated the UI shows "Quote unavailable".
- The agent does not sign, approve tokens or broadcast transactions. Financial execution is disabled.
- Nothing here is deployed publicly yet. See [P13-DELIVERY.md](P13-DELIVERY.md) for the deployment approval packet.

## What is in the repo

| Path | Contents |
| --- | --- |
| `src/`, `test/` | Settlement adapter, invoice core, attempt lineage and offline tests (synthetic invoices, mock provider, temporary SQLite) |
| `workers/api/` | Cloudflare Worker and D1 backend (HMAC service auth, tenant isolation, capability revocation), tested locally on Miniflare |
| `apps/web/` | Next.js 16 app: landing, `/agent`, `/proof`, `/demo` (synthetic, labelled), `/pay`, and the private `/login`, `/invoices`, `/activity` routes |

Private routes return 404 unless the release gate is explicitly opened. The public profile exposes only `/`, `/agent`, `/proof`, `/demo` and a `/pay` availability notice.

## Review and reproduce

Use Node 22 (22.23.3 or a compatible release).

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test            # backend tests, offline, no secrets
~~~

Further suites (see `.github/workflows/ci.yml` for the exact commands):

~~~sh
npm run test:browser                       # root browser tests (Chromium)
cd workers/api && npm ci && npm test       # Worker and D1 tests
cd apps/web && npm ci && npm run typecheck && npm run build
~~~

All suites run offline with synthetic data and no secrets. CI runs them on every pull request, plus a full local merchant-to-payer journey (D1, Worker, Next.js and Chromium) and a secret scan. The last verified run: backend 279/279, Worker 158/158, root browser 33/33, full journey 30/30.

## Documents

- [Wallet architecture](WALLET-ARCHITECTURE-DECISION.md)
- [Executed tests and remaining gaps](WALLET-ADAPTER-TEST-REPORT.md)
- [Wallet enrollment checklist](WALLET-ENROLLMENT-CHECKLIST.md)
- [P13 delivery and verification record](P13-DELIVERY.md)
- [Controlled launch plan](P12-CONTROLLED-LAUNCH.md)

The starter framework informs project organization: [Starter framework](https://github.com/udaysharmadev/Hackathon-Starter-Pack-Complete-Guide-Roadmap)
