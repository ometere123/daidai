# P12 controlled launch

Base: P11 normal merge a17d5cdf5157a5a4b5247db3c09192a8fa585312. The seven approved P11 CI jobs passed. P12 is isolated preparation with financial execution disabled.

| Workstream | Acceptance evidence |
| --- | --- |
| Infrastructure | Default-deny launch configuration, isolated D1 control tests, operational runbook |
| Identity | Provider boundary fails closed without a selected IdP, separate operator grant |
| Celo | Reproducible public RPC probe with canonical receipt and finalized head checks, explicit disagreement policy |
| Textile | Non-dispatching indicative and firm fixture review, balance/approval/simulation gates and adversarial cases |
| Product | Existing merchant-to-payer full-stack walkthrough and authorization/quote/reconciliation checks |
| Release | Exact-head CI, audits and review gates, no hosting or production migration |

Next: inspect and extend the existing production gates and read-only contracts. No P12 checks have run yet.

## Infrastructure checkpoint

Base checkpoint 4ce96a8 opened draft PR #9. The Worker now fails closed outside the isolated runtime, with public and preview routes disabled in Wrangler. The signed local integration uses an atomic D1 service quota with a separate invitation budget. Config validation checks both hosted defaults and the local-only flags. This checkpoint does not provision anything. Next: exercise D1 contention and define the hosted identity and operator boundaries.

## Identity checkpoint

Infrastructure head f74b78d. Added a fail-closed IdP contract with issuer/audience/expiry and tenant membership checks. Operator review additionally requires an independent grant and recent MFA. This is a tested adapter boundary, with no production provider or hosted route. Added D1 budget and hosted shutdown regressions. Next: qualify independent Celo providers and retain their public evidence.

## Celo checkpoint

Identity head 3814c3c. Two deterministic provider-policy tests passed. The live historical probe found matching canonical P08 registration evidence on Forno and Ankr (block 0x4f9cc45, hash 0x1558a6120f0d99bab5b85806a854659407c96dd2ff16c51b79a75453fed5a72b, finalized head 0x4faf163). dRPC returned no receipt and the community endpoint timed out. This qualifies those historical observations only. Proposed policy requires independently operated providers, both canonical and finalized, with disagreement or unavailability blocking promotion. It is not enabled in production. Next: complete the non-dispatching Textile path and rerun the integrated walkthrough.

## Textile checkpoint

Celo head ea19f31. The official RFQ documentation distinguishes non-reserving preview from inventory-reserving firm RFQ. P12 has an injectable firm source only and never calls the reservation endpoint. The review reuses the existing signed-envelope parser, commitment/consent checks and Celo reader. It checks exact output, all-in debit and protocol fee, confirmed scoped allowance, balances, both gas budgets, exact tagged simulation and freshness after simulation. The separate payout review requires finalized conversion for the same commitment and separate exact payout verification. Two synthetic preparation tests passed. Next: integrate safety checks and rehearse both demonstrations.

## Demo checkpoint

Textile head 1d11279. Added one local command with separate product and public-chain modes. Product mode builds Next, reseeds disposable D1, reapplies the isolated migration and starts authenticated Chromium. Chain mode performs read-only historical registration observation. The full-stack run is in progress. Next: harden the evidence and provider failure paths, then run exact-head CI.
