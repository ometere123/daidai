# Daidai

Exact-amount stablecoin invoice settlement on Celo. Daidai prepares a USDt-to-cNGN conversion and a separate exact cNGN payout. A dedicated wallet owner approves each operation.

P08 registration, agent identity, and Loops enrollment are complete. Daidai is ERC-8004 agent **10103** on Celo Mainnet (42220), registered by the dedicated wallet `0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e` in transaction `0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b`. The operator confirmed all three Loops dashboard checks. See the [registration outcome](P08B23-REGISTRATION-OUTCOME.md).

Live USDt-to-cNGN settlement is **not production-authorized**. The repository contains the Architecture A adapter, its offline test suite, and a fixture-only frontend.

## Review and reproduce

Use Node 22.23.3 or a compatible Node 22 release with native TypeScript stripping and SQLite.

~~~sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
~~~

The test suite uses synthetic invoices, an injected mock provider, fabricated receipts, a fixture tag by default, and temporary SQLite files. To repeat attribution checks with an organizer-issued public code, set DAIDAI_ATTRIBUTION_CODE in the test process before running the suite. No external service or browser wallet is used by the tests. npm ci needs registry access or a populated local npm cache.

- [Wallet architecture](WALLET-ARCHITECTURE-DECISION.md)
- [Executed tests and remaining gaps](WALLET-ADAPTER-TEST-REPORT.md)
- [Wallet enrollment checklist](WALLET-ENROLLMENT-CHECKLIST.md)

Source is in src/ and tests are in test/. The original research and locally installed organizer skill are intentionally excluded from the initial GitHub review tree. The starter framework informs project organization. [Starter framework](https://github.com/udaysharmadev/Hackathon-Starter-Pack-Complete-Guide-Roadmap)
