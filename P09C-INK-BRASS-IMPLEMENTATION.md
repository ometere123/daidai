# P09C: Ink and Brass implementation report

Branch `p09c-ink-brass`, based on `p09b-plumb-ui` at `f8a9005`. This is a frontend-only demo. It makes no wallet calls, signature requests, approvals, RFQs, swaps, payouts, registrations or Loops changes. Nothing outside `apps/web`, apart from this report and `docs/p09c-screenshots/`, was changed. `src/`, `test/` and `scripts/` are untouched.

## Preview

```sh
npm ci && npm --prefix apps/web ci
NEXT_PUBLIC_DAIDAI_DEMO_TOOLS=1 npm --prefix apps/web run build   # the flag enables the ?demo= and ?data= fixtures
npm --prefix apps/web run start -- --hostname 127.0.0.1 --port 3219
```

| URL | Screen |
| --- | --- |
| `/` | Dashboard: list and focus pane. Also `?filter=needs-you\|needs-reconciliation\|in-progress\|waiting\|settled` and `?selected=INV-0041` |
| `/?invoice=INV-0042` | Invoice review |
| `/?invoice=INV-0032&view=progress` | Settled receipt |
| `/?data=empty`, `/?data=loading` | Empty and loading states (only with the flag) |
| `/?demo=<state>` | Section 12 states (only with the flag): `signatures-missing`, `signature-expired`, `allowance-needed`, `no-quote`, `quote-held`, `expiring`, `expired`, `over-limit`, `invalid-quote`, `conversion-submitted`, `conversion-confirmed`, `converted`, `declined`, `payout-submitted`, `reverted`, `unknown`, `mismatch`, `checked`, `settled` |

Without the flag, the fixture switches are ignored and nothing in the navigation points to them.

## What was built (by P09C section)

- **Brand (§6).** `Wordmark` shows "Daidai" with brass diamonds replacing both i-dots. Screen readers get the plain word "Daidai". `PlumbBob` is a hairline into a brass diamond that lands on a baseline. `icon.svg` drops the hairline so it reads at 16 and 32 px. There is also a 180 px apple icon, 192 and 512 px PNGs, and a manifest. Page titles read `INV-0042 — Daidai (demo)`. The word "Plumb" never appears in the UI.
- **Tokens and type (§4–5).** The §4 palette and the radii are defined in a Tailwind 4 `@theme` block in `app/daidai.css`, and components use only these tokens. Green is used only for Settled, and the primary action is ink. One formatter, `formatTokenAmount`, and one `<TokenAmount>` component format every amount. The unit is set at 0.62× and figures are never letter-spaced.
- **IA and navigation (§7).** The fixed bottom nav and "Empty preview" are gone.
  - **Mobile:** a 56 px top bar with the wordmark or "← Invoices", a Demo flag, "+ New" and a workspace sheet.
  - **Desktop:** a full-height rail with group filters and counts.
  - **All widths:** the demo strip. The groups are renamed, including **Waiting for signatures**.
- **Dashboard (§8.1).** 72 px rows show the approver, "INV-0042 for Amaka Nwosu", the amount, a drawn status mark and the next action in words. Rows have no arrows or glyph boxes.
  - **Desktop:** a focus pane with a mini ink slab, the next step, quote versus limit, roles and "Open invoice". Arrow, Home and End keys move the selection (roving tabindex) and update `?selected=`. Enter opens the invoice.
  - **Mobile:** filter chips with `aria-pressed`.
  - Empty and loading states are included.
- **Invoice review (§8.2).** The ink target slab is the single `<h1>`, rendered once. It includes a signatures link that opens a sheet with both EIP-712 halves (signer, digest, purpose, audience, `expiresAtMs`), and the slab names any signature that is missing or expired.
  - A five-step stage strip (`<ol>`, `aria-current="step"`). The current stage is open; completed stages collapse to one line, and the limit has inline Edit.
  - The Plumb Line gauge, the cost breakdown, and people and roles.
  - A sticky action bar with exactly one primary action. Every action opens a review dialog (a bottom sheet on mobile) whose last button reads "Simulate approval (demo)".
- **Plumb Line (§9).** USDt only. A warning-coloured hard stop with a 45° hatch beyond it, a brass-headed needle, a "USDt, from 95" axis note and a headroom figure. The states are none, requesting (crawl), held, under 15 s, over limit (error needle in the hatch), expired (hollow needle) and invalid. The SVG is `aria-hidden`, and a `<dl>` carries the same values for screen readers.
- **Settlement and receipt (§8.3, §12).** The order is: verdict band first, coloured by state, with "(demo record: not onchain)"; then the Ledger reconciliation table ("Found (demo)", "matches (demo)", a double rule above Difference); then cost in words; then the four-phase timeline with the bridge sentence. The timeline is open while in progress and collapsed once Settled. The receipt has no gauge. Every §12 state has a fixture with its own headline, consequence line and single safe action.
  - **Unknown outcome and mismatch:** retry is blocked, and the only action is View evidence.
  - **Conversion:** a submitted conversion advances to confirmed and then final in the demo.
  - **Payout:** a submitted payout never settles itself.
- **Demo safeguards (§13).** Each invoice has its own recipient, approver and `0xDEMO…A00n` wallet, which is deliberately not valid hex. Hashes read `demo-tx-0032-conv`, the block reads "demo block", and fees are "(simulated)". Every hash, block and fee figure sits inside a violet dashed "Demo evidence" frame. The Celoscan button is disabled, with its reason as visible text. Every state headline carries "(demo)". The printed PDF carries a "DEMO, NOT A RECORD OF PAYMENT" watermark.
- **Motion (§11).**
  - A 160 ms route crossfade, a 100 ms press scale, and a 220 ms needle fade-and-drop.
  - Sheet and dialog transitions of 240 ms in and 180 ms out.
  - A single 400 ms Settled band and diamond drop per invoice, remembered in sessionStorage.
  - Amounts and the slab are never animated, and hover effects are gated to `(hover: hover) and (pointer: fine)`.
  - Under reduced motion, the crawl is static and the band simply appears.

## Deviations from the spec (please review)

1. **No tabular figures anywhere.** In Schibsted Grotesk, the tabular comma and period are full figure-width. Even where §5 allows `tabular-nums`, stacked columns rendered as "150 , 000", which I saw in the first screenshots. Columns are instead right-aligned with proportional lining figures.
2. **Approve stage.** As in the §8 mock, while a quote is held the strip reads "Step 4 of 5: Quote". Approval happens in the review dialog.
3. **Fonts and CSS files.** Fonts still load through the existing `@fontsource` packages, with a size-adjusted Arial fallback, instead of `next/font`. This avoids any dependency change. `plumb.css` and `settlement.css` are replaced by a single `app/daidai.css`, and `app/ui.tsx` holds the shared components.
4. **Amount labels for screen readers.** Amounts are not given an `aria-label`. Their visible text already reads "150,000 cNGN", and `aria-label` on a generic span is unreliable. They are marked `translate="no"`.
5. **Dashboard row title.** The row title is the invoice approver, as in the §8 mock, and the recipient follows inline ("INV-0042 for Amaka Nwosu").

## Results

| Check | Result |
| --- | --- |
| `npm --prefix apps/web run typecheck` | Pass |
| `NEXT_PUBLIC_DAIDAI_DEMO_TOOLS=1 npm --prefix apps/web run build` and a plain build | Pass, static route `/` |
| `npm --prefix apps/web run test:browser` | **12/12 pass** (was 7) |
| Root `npm test` (backend regressions) | **54/54 pass**, unchanged |
| Root `npm run typecheck` | Pass |
| axe-core 4.10.3 (WCAG 2.0, 2.1 and 2.2 A/AA plus best practice) on 9 screens at 375 and 1440 px, and on an open dialog | 0 violations after fixing one moderate `region` finding on the demo strip. axe was injected from a scratch copy, so it is not a dependency |

The browser suite checks:

- **Amounts:** formatting of 0, 0.2, 48,500, 150,000 and 102.48.
- **Settlement rules:** mismatch, wrong recipient and over-cap evidence don't settle.
- **Cast:** the cast is distinct.
- **Layout at 320, 375, 768 and 1440 px, on every screen:**
  - no horizontal overflow;
  - no lowercase "daidai";
  - no 64-hex or 40-hex strings and no zero-padded addresses;
  - no fixed element over the content;
  - exactly one `<h1>`.
- **Every `?demo=` state:**
  - a "(demo)" headline and at most one primary action;
  - no retry on unknown or mismatch;
  - the wallet spy sees zero calls.
- **Keyboard:** dashboard keys work, and the dialog returns focus.
- **Quote expiry:** expiry removes the conversion action.
- **Demo flow:** the full flow never reaches Settled.
- **Large text:** 200% text in landscape doesn't overflow.
- **Sticky bars:** focused controls are never hidden behind either bar.

**Manual checks:**

- **Forced colours:** the hatch survives as a pattern (`forced-colors-*.png`).
- **200% text at 375 px:** fixed. The only wide content left is the intentionally scrollable filter-chip row.
- **Landscape 667 × 375:** checked.
- **Page length:** at the quote stage, the 375 px review page is about 2.3 viewports.

## Screenshots

`docs/p09c-screenshots/`. Mobile files ending `-full` are full-page captures, in which the sticky action bar appears mid-page; that is a capture artifact, and the bar sits at the bottom of the viewport in use.

- **Main screens:** `dashboard-*`, `review-*`, `receipt-*` and `empty-*` at 375, 768 and 1440 px, plus `-320` for dashboard, review and receipt.
- **States:** `state-<name>-375.png` and `state-<name>-1440.png` for all 18 states.
- **Overlays:** `dialog-conversion-*` and `sheet-signatures-375`.
- **Timeline:** `timeline-open-1440`.
- **Accessibility:** `text200-*`, `forced-colors-*` and `landscape-review-667`.

## Open items (unchanged from P09C)

1. How many confirmations count as final on Celo. The demo says "agreed confirmations" and gives no number.
2. Whether the demo violet should ever appear in production.
3. Legal review of "Pegged to ₦150,000".

I am pausing here for design review. Nothing has been merged or connected to live operations.
