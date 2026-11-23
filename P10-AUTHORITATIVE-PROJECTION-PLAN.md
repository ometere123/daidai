# P10.1 authoritative invoice read model

## Boundary

Add a server-owned query keyed by invoice ID for an authenticated, authorized viewer. Load the committed invoice and revision from the server repository. Return a sanitized projection, without signing, quote reservation, transaction dispatch, or state mutation. Keep the existing fixture path independent.

Use versioned schemas with execution disabled and separate types and read paths for FixtureWorkspace and AuthoritativeInvoiceProjection. The authoritative renderer accepts only the server projection. It never adapts fixture signatures, statuses, or receipts into that type. Use tagged states and exhaustive rendering. A missing, stale, inconsistent, or unavailable source has an explicit unverified status. No raw signatures, credentials, wallet instructions, or session details cross the boundary.

## Fields and ownership

| Field | Authority and provenance |
| --- | --- |
| Invoice ID, commitment digest and revision | Durable invoice repository. Bind the response to the exact revision read. |
| Exact cNGN target and maximum all-in USDt debit | Committed invoice. Use canonical decimal strings for atomic amounts across JSON and BigInt internally. Include chain, token identifiers and precision. |
| Invoice approval and recipient consent | Separate server verification summaries, each bound to its signer, purpose, commitment digest, chain and audience. Report verified, missing, expired or invalid with observation time and expiry. |
| Conversion and payout | Separate discriminated state unions. Each references its own durable attempt and independent evidence. |
| Finalized transaction evidence | Verifier output with chain, hash, canonical block reference, finalized head, observed time and exact verified amounts. Payout evidence binds both recipient and exact cNGN amount. |
| Unknown or reconciliation required | Retain the attempt reference and report the reason, last authoritative observation and verification gap. No retry permission follows from this projection. |

Use server timestamps and block references from the trusted readers. Preserve per-source provenance and freshness. Accept no timestamp, signature verdict, transaction status, or receipt supplied by the browser. If observed evidence no longer matches the invoice revision or attempt, return reconciliation required. A finalized conversion alone cannot produce a settled invoice. A closed invoice requires independent exact payout verification to the committed recipient and a verified conversion debit within the all-in USDt cap.

## Implementation order

1. Define the wire schema and server adapter ports. Start with an in-process projector and injectable read-only sources. Do not instantiate the write-capable SQLite service in the frontend. Enforce authorization before retrieving invoice data. Keep Node-only persistence and RPC modules outside the client bundle.
2. Build a pure projector over a consistent invoice revision, verified authorization summaries and independent transaction evidence. Validate completeness and cross-source binding before exposing a result.
3. Integrate trusted read-only adapters and a separate authoritative UI route. Keep fixture evidence explicitly labeled. Strip response data that the viewer does not need and avoid caching private invoice data across viewers.
4. Test unauthorized and cross-invoice access, stale observations, wrong chain or token, reorgs, mixed revisions, wrong signer or purpose, mismatched recipient or amount, non-final receipts, unknown hashes, over-cap debit and fixture injection. Assert zero provider calls in both read paths.

Stop for review before adding any command, signing, or dispatch API. Live settlement still requires separate human authorization.
