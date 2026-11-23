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
