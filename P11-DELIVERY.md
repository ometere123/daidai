# P11 Delivery

P10.5 merged through PR #7. This branch adds an isolated, non-spending merchant and payer workflow around the existing authenticated Worker and Next.js application.

## Checkpoint 0

The base is the P10.5 normal merge commit. Its approved head passed all seven CI jobs. P11 tests have not run yet. Each checkpoint SHA is recorded by Git and the pull request.

## Architecture and acceptance

- Next.js owns the merchant and payer UI and the server-side signed Worker client.
- The Worker authorizes every invoice operation. D1 owns tenant permissions, draft revisions and immutable commitments. Product writes are confined to the local test runtime.
- Share capabilities are scoped, expiring, revocable and convey read-only access.
- Payment preparation shows the exact cNGN target and maximum all-in USDt debit. Simulated quotes and observations have distinct provenance from independently verified chain evidence.
- Browser and Worker tests must exercise the full create, edit, commit, share and payer review flow, including concurrent and unauthorized operations.
- CI must pass on the final head. Production identity, deployment and any financial execution require separate review and authorization.

Next action is to implement the versioned invoice contract and local D1 persistence. Public Celo RPC and official Textile interfaces still need qualification.
