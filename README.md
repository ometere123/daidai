# Daidai

**Two currencies. One agreement. Verified settlement.**

Daidai is a human-authorised financial commitment agent for the Celo Agents Open for Business hackathon (Stablecoin Corridors / Textile FX). A supplier requests an exact cNGN amount, a payer approves a USDt conversion ceiling, and Daidai prepares and reconciles the two financial operations. The intended breakthrough is recovering the obligation after an interruption without repeating a completed conversion or payout.

**Current status (2026-11-27):** tested offline control plane; live settlement disabled; no verified live Textile conversion or external payout. This blueprint describes the target, not a completed product. The public deployment provenance is unresolved. Never confuse the synthetic demo with live settlement.

## Identity (preserve existing enrollment)

- Celo mainnet, chain 42220; recorded ERC-8004 agent #10103.
- Enrolled wallet / recorded registrant: 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e.
- Registration transaction: [explorer](https://celoscan.io/tx/0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b).
- Assigned attribution: celo_597f1146c487. See [enrollment](P08B12-LOOPS-WALLET-ENROLLMENT.md) and [registration outcome](P08B23-REGISTRATION-OUTCOME.md). Historical records, not a fresh Loops or chain verification. Do not re-register or change wallet to implement this blueprint.
- [Metadata](DAIDAI-ERC8004-METADATA.json) · [official event](https://www.loops.house/agents-open-for-business).

## Start here

Node 22 (22.23.3 previously tested), npm and Chromium. From repository root:

    npm ci --ignore-scripts --no-audit --no-fund
    npm run typecheck
    npm test
    npm --prefix apps/web ci
    npm --prefix workers/api ci
    npm --prefix apps/web run dev

Public routes: /, /agent, /proof, /demo, /pay (availability notice when closed). No real transaction from the current public product. For the existing isolated full-stack fixture journey:

    npx --yes playwright@1.65.1 install chromium
    npm run demo:p12 -- product
    npm run demo:p12 -- chain

The first command installs the pinned browser tooling; product mode recreates disposable local fixture data. Chain mode is read-only and may fail if providers are unavailable. Do not run fixture seeding against real pilot storage. See [runbook](ops/P12-RUNBOOK.md). Additional checks:

    npm run test:browser
    npm --prefix workers/api run typecheck
    npm --prefix workers/api test
    npm --prefix apps/web run typecheck
    npm --prefix apps/web run build

Use [.github/workflows/ci.yml](.github/workflows/ci.yml) for the complete browser/build matrix, including DAIDAI_CHROMIUM_PATH if required. Baseline recorded: 279 root, 158 Worker, 33 root browser, 30 full-journey checks; [successful baseline CI](https://github.com/ometere123/daidai/actions/runs/46015898395). Not a live settlement test.

## Configuration and release

Public profile: DAIDAI_PUBLIC_RELEASE=1, DAIDAI_APP_ENABLED=0, DAIDAI_PREVIEW_ACCESS=0, DAIDAI_LOCAL_PRODUCT=0. No private API credentials or signer. Local product requires DAIDAI_LOCAL_PRODUCT=1, app gate, loopback DAIDAI_API_BASE_URL and existing service credentials (DAIDAI_SERVICE_KEY_ID, DAIDAI_SERVICE_KEY; Worker DAIDAI_SERVICE_KEYS in ignored .dev.vars). DAIDAI_LOCAL_TEXTILE_PREVIEW=0 disables real preview requests. Do not publish secrets or change remote settings from these instructions. The local financial pilot runner is **not implemented**; see architecture and milestones before enabling any dispatch.

Stack: TypeScript, Node 22, viem, existing MetaMask EIP-1193 bridge, SQLite, Next.js 16 / React 19, Worker/D1 local fixture and authenticated read-only workflow, Textile RFQ v2, ERC-8004/8021. No new framework or model required.

## Governing documents

[Project decision](docs/PROJECT.md) · [PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [Design](docs/DESIGN.md) · [Implementation](docs/IMPLEMENTATION.md) · [Testing](docs/TESTING.md) · [Demo](docs/DEMO.md) · [Agent instructions](AGENTS.md) · [Handover](PROGRESS.md). These govern the next build; historical P08–P13 reports remain evidence, not competing requirements.

Apache 2.0. See LICENSE and NOTICE.
