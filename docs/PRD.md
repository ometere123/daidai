# Product requirements
Normative requirements for PDR-001. See PROJECT for scope, ARCHITECTURE for enforcement, TESTING for gates.

## Actors and journey
Supplier creates a request (description, exact cNGN, recipient address, deadline); payer reviews source debit cap and network fee limits; both independently accept the exact final terms with role-specific signatures. Pilot operator is the enrolled EOA owner, not a custodian. Agent obtains indicative pricing as needed, prepares a firm quote only after readiness, validates and presents the exact action. Owner approves any allowance and the swap in MetaMask. Agent observes finality, recovers its durable state even if stopped, prepares only the outstanding payout, owner approves it, agent verifies it and emits receipt. Supplier confirms actual receipt. Public judge sees labelled demo and dated proof without requiring login or wallet.

## Requirements and acceptance (P0)
| ID | Requirement | Acceptance |
|---|---|---|
| R01 | Immutable obligation | Canonical Invoice v1 (src/invoice-core.ts) is source of financial digest; bind id/version/source/nonce, chain/tokens/decimals, recipient, cap, taker, approver, expiry. Description is context, not authority unless separately bound. Mutations invalidate signatures; one stable invoice ID across versions; prohibit economic edits after claim. |
| R02 | Genuine authorisation | Distinct committed approver and recipient sign role/audience/chain/digest/expiry EIP-712; operator reviews exact terms; stale, wrong-role or changed terms refused. No signature collection by public demo. |
| R03 | Quote and readiness | Exact-output cNGN firm quote validated against taker, token, output, fee, cap, expiry, calldata, balance, allowance and fee policy. No quote/over cap/expiry/unsupported response leaves no dispatch. Indicative estimates explicitly non-executable. |
| R04 | Controlled wallet | Owner reviews separate bounded allowance if necessary, conversion and payout; recheck pinned account and chain, exact tagged envelope, nonce, gas and time immediately before send. No seed phrase or private key collected. |
| R05 | Durable execution | Persist unique operation claim and nonce before provider handoff; journal signed terms, approved envelope, hash/outcome, verification. A claim survives browser close, process crash and database reopen. No parallel duplicate within controlled path. |
| R06 | Verify conversion | Actual successful finalized transaction matches approved sender, envelope, debit and exact cNGN credit; independent providers agree on canonical block and evidence. Otherwise pending/unresolved. |
| R07 | Exact external payout | Only after verified conversion; recheck authority, cNGN availability and gas; separate exact transfer to committed recipient, with independent finalized evidence. |
| R08 | Safe resume | Reopen journal in fresh process; reverify conversion against persisted envelope/evidence and authorization; display only payout action. Expired authority blocks payout until reviewed continuation consent that cannot reopen conversion. If continuation cannot be safely established before deadline, manual escalation only. |
| R09 | Unknown outcomes | Missing hash, timeout, competing nonce or conflicting receipt does not imply failed. Retain claim, suppress resend, surface operator reconciliation. No automatic release or retry of claimed operation. |
| R10 | Receipt and commercial proof | Both tx references, actual USDt debit incl Textile fee, separately bounded network fees, exact cNGN credit/payout, dated verification, status and external recipient acknowledgment. Redact identifiers/financial terms on public pages absent permission. No settlement status before both verified. |
| R11 | Public UX and provenance | Public landing/demo/proof/agent usable; no closed-route CTA, no financial mutation in public profile, same reviewed source revision as demo, clear live/recorded/synthetic labels. |
| R12 | Competition | Current identity/wallet/tag verified or honestly unresolved; complete a genuine attributable conversion and external payout; verify organiser indexing and named-user evidence; consent for public use, no artificial traffic. |

P1: repeat obligations, improved status timeline, safe pre-execution revisions, more user evidence and shared components. P2 and exclusions per PROJECT. No broad payment dashboard or feature expansion.

## Business rules
Amounts are decimal strings converted to atomic integers using verified six decimals for both configured tokens; reject floats, zero, overflow, invalid address and ambiguous units. Store amounts as strings/BigInt, never JS Number arithmetic. UTC epoch ms for commitments; distinguish quote expiry from signed order deadline. Authorisation cap refers to USDt debited in conversion including protocol fee; CELO network fees and potential off-ramp costs are separate, not silently included. Display actual network cost and separate reviewed ceilings including allowance cost if needed. Never claim cNGN is bank naira. Use one stable canonical invoice ID and ensure one final conversion and payout across versions. Do not cancel or amend a partly executed obligation as though funds never moved. Expired unexecuted request can be replaced with new version only after proof no open claim. Expired post-conversion requires same obligation continuation under newly verified scope, or escalation; never reset journal.

## States and UX
DRAFT → COMMITTED/AWAITING_SIGNATURES → AUTHORISED → READY/QUOTE_UNAVAILABLE/OVER_CAP/ALLOWANCE_REQUIRED → CONVERSION_CLAIMED → CONVERSION_PENDING or UNKNOWN → CONVERTED_UNPAID → PAYOUT_CLAIMED → PAYOUT_PENDING or UNKNOWN → SETTLED. Known failure, expiry, mismatched evidence and provider disagreement have explicit BLOCKED/RECONCILIATION branches. Status is derived from authority and chain evidence, not browser memory. See ARCHITECTURE for transitions. Quote expiry before dispatch is recoverable by a fresh quote; after claim, no automatic financial retry.

## Nonfunctional
- Security: fail closed; no public signing path, least privilege, tenant/role separation, CSRF/origin, replay and secret hygiene; explicit real financial authorisation per operation. No public/private state crossover.
- Reliability: restart-safe journal, no duplicate dispatch in tests, provider errors clear and actionable; actual finality not time-guaranteed.
- Accessibility: WCAG 2.2 AA target, keyboard/focus, 44px touch targets where practical, status text+glyph, reduced motion, 320px–1440px responsive.
- Performance targets (measure locally): public routes usable in 2 seconds on normal connection excluding provider waits, no layout overflow or blocking spinner without timeout, bound RPC/HTTP time and response sizes. Measure actual figures; do not claim SLA.
- Privacy: minimal identity data, no invoice/capability/signature secrets in logs, public proof only with consent. No regulatory or security certification claims.
