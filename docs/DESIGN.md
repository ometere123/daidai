# Design — Ink and Brass, one product
Preserve the approved P09C design language, not a new logo or theme. Existing /demo is the reference; DESIGN_AUDIT.md documents divergence. Reuse apps/web/app/daidai.css, ui.tsx, prototype.tsx and settlement components after inspecting their interfaces. Adapt them to typed authoritative projections; never import synthetic values into live screens.

## Identity and tokens
Daidai: Two currencies. One agreement. Lead with recipient amount and payer limit; evidence progressively disclosed. Paper #F6F6F2, surface #FFFFFF, well #ECEDE7, rule #D9DBD3, ink #0F1B26, muted #56616B, brass #C9A24E (decorative/marks), brass-text #7F5C14, settled #1E7047, error #B4321F, warning #A8460A, reconciliation #2E4A66, demo violet #5E3FBE / #F1EDFB exclusively synthetic. Test contrast; do not use pale brass as text on paper. Existing Schibsted Grotesk variable and JetBrains Mono (hashes/technical data only), local fonts. 16px body, 14px controls, minimum 12px metadata, 26–32px heading, 34–56px amount responsive, proportional lining numerals (existing punctuation issue). 4/8/12/16/24/32/48px rhythm; 8px controls, 12px panels, 16px sheets. Fine rules, restrained shadows for sheets only. No decorative gradients/glass/glows, generic bento cards or redundant charts.

## Signature layout
Ink slab = one dominant amount with recipient, cap and status. Brass plumb line = chronological obligation stages, not decorative side stripes. Rail + dense invoice list + focus pane on wide screens (>=1024px), single-column focus with back link on narrow screens; sticky action bar only if it doesn't cover focus/content. One primary action determined by current state. Keep currency text readable and amount unit adjacent. Use actual approved wordmark/icon. Motion for state transitions only (120–200ms), reduced-motion zero optional transitions; never animate payment completion before evidence.

## Essential surfaces
| Screen | Required content and action |
|---|---|
| / | Headline, one live-rendered synthetic slab explicitly labelled, short agreement → convert → pay → verify line, public proof and demo CTA; invite-only message if gate closed. No links to 404. |
| /demo | Existing fixture workspace with violet banner throughout; progress and interruption/resume scenario, reset fixtures, separate from real state. |
| /agent | Agent #10103, chain and enrolled address, labelled tx, current observation status and date, accessible copy/explorer links. |
| /proof | First distinguish registration and settlement. Dated proof snapshot, actual conversion/payout refs and status when available, live check unresolved separately. Empty: no verified settlement. |
| /pay | Public availability notice or authenticated committed terms; recipient amount, approved source cap, protocol fee, separate network fees, signature status, safe next action. |
| /invoices/new, /invoices, /invoices/[id] | Local authenticated request, immutable terms/version, history and status; read-only authoritative view, share/revoke when allowed. No implied remote pilot execution. |
| /activity | Obligation timeline with verified/pending/unknown evidence; no fabricated durable events. |
| Local wallet review | Exact target, chain, sender, token, recipient, amount, gas ceiling, quote expiry, single approve action; pending and unknown show do-not-resend instruction. |
| Receipt | Amount and currency first, cap vs actual debit, fee breakdown, two finalized references, consented customer evidence; no settled glyph unless verified. |

Loading: skeleton only for layout; named bounded provider check, timeout and actionable recovery. Empty: concise plain-language reason and next action. Error: invalid terms, unavailable quote, cap exceeded, expired, wallet mismatch, insufficient funds, converted-unpaid, pending/unknown and provider disagreement each distinct. A reconciliation state must not expose a retry/pay button. Never use success toast as receipt.

## Accessibility and QA
One main/banner, skip link, semantic headings/forms, visible keyboard focus, proper dialog focus restore, label status icons, aria-live for status not noisy countdown; logical tab order, 44px targets, no color-only states, forced-colors/reduced motion. Test 320/375/390/820/1024/1440px, 200% text, long amounts/hash, keyboard, mobile sticky bar, axe WCAG AA target. No horizontal overflow or hidden controls. Compare screenshots against existing /demo rather than generic redesign. Judge-first path works without sign-in. See TESTING.
