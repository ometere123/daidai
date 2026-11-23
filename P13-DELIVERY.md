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
