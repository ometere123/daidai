# Daidai

Exact-amount stablecoin invoice settlement on Celo. Daidai prepares a USDt-to-cNGN conversion and a separate exact cNGN payout. A dedicated wallet owner approves each operation.

This repository contains the Architecture A adapter and its offline test suite. Wallet enrollment is **NO-GO** pending the next authorized verification phase.

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
