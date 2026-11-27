# Design audit

Method: the production build was rendered in Chromium at 1440×900, 820×1180 and 390×844. That covered 5 public routes and 5 authenticated routes, 33 full-page screenshots in all, in `docs/audit/screenshots/`. Each was inspected by eye and compared with the approved P09C creative brief ("Ink and Brass") and the nine resources in `RESOURCE_UTILISATION_AUDIT.md`. Judgements of taste are labelled as judgements; measured facts are labelled with their tool.

## Verdict in one paragraph

Daidai has a real, specific visual identity, but only in one place. The `/demo` workspace is a faithful, well-crafted build of the approved brief: ink slab, brass marks, a status glyph system that never relies on colour alone, a rail plus list plus focus pane, and a spec-mandated violet for demo content only. Everything a judge reaches outside `/demo` is weaker. The landing page is a competent but familiar fintech hero. `/agent` and `/proof` are bordered text dumps. The authenticated product, which is the real product, is a generic stack of identical rounded cards that ignores the brief entirely. The product looks finished in its demo and unfinished where it is real.

## Findings

Priority: Critical, High, Medium, Low. Impact is the expected effect on a judge's impression.

| ID | Page and component | Evidence | Why it is weak | Principle or resource | Specific improvement | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| D-01 | Site nav, all public pages | `screenshots/home-desktop.png`; link crawl in `TEST_RESULTS.md` | "Invoices", "Activity" and "Sign in" lead to 404, and so does the hero's primary button "Create an invoice". A judge's first two clicks fail | webapp-testing; Vercel guidelines (navigation) | When the release gate is closed, render only Agent, Proof and Demo. Point "Create an invoice" at `/demo` with the label "Try the demo workspace" | High |
| D-02 | Landing hero `/` | `home-desktop.png` | The page never shows the product. The right-hand slab repeats a credential instead. Judges must find a small text link at the bottom to see anything | Taste (real product UI in the hero); frontend-design (open with the most characteristic thing) | Replace the slab with a cropped, live render of the `/demo` focus pane: the ink slab "Amaka Nwosu receives exactly 150,000 cNGN" is the most characteristic thing Daidai has | High |
| D-03 | Authenticated product `/invoices`, `/invoices/new`, `/invoices/[id]`, `/activity` | `screenshots-product/*.png` | Identical rounded bordered cards stacked vertically, one radius, no focal point, raw ids (`inv-a1`), units at 60 % size. None of the brief's components (ink slab, status marks, sticky action bar, focus pane) appear. Two visual languages in one product | Interface Design (signature test, one focal point); frontend-design (SaaS-card kit) | Rebuild these pages on the existing `/demo` components fed with authoritative data. No new design is needed, only reuse | High |
| D-04 | `/proof` and `/agent` | `proof-desktop.png`, `agent-desktop.png` | Every row has equal weight. The single most important fact, the registration status, is a lowercase word ("unresolved") in body text. Hashes and addresses are untruncated and unlabelled in places (the bare tx hash row) | Interface Design (one focal point); squint test | Lead with a status verdict band in the brief's style. Give each hash a label, a copy button and an explorer link. Separate "Registration" and "Settlement" as two clearly titled panels | High |
| D-05 | Landing hero eyebrow and links | `home-desktop.png` | Mono brass eyebrow `Celo Mainnet · USDt → cNGN` above the headline, middle-dot joined meta strings, `↗` appended to links. Each is listed by frontend-design as a default generated-page tell | frontend-design | Drop the eyebrow; let the headline carry the pair. Use the arrow only on true external links (Celoscan) | Medium |
| D-06 | Landing three-column feature row | `home-desktop.png` | Three equal columns with a title and one sentence each is the most common landing-page section there is | frontend-design; Taste | Replace with one sentence of the actual flow drawn as the plumb line: commit, quote within cap, convert, pay, verify | Medium |
| D-07 | `/demo` selected list row | Impeccable `side-tab` at `apps/web/app/daidai.css:226` | A 3 px inset stripe on one edge of the selected row is a flagged slop pattern. The P09C brief does not specify it | Impeccable | Use the brief's `well` background tone for the selected row and keep the stripe off | Low |
| D-08 | `/demo` small UI text | Impeccable `undersized-ui-text` ×3 on the rendered page | Small unit labels and meta text fall below a comfortable size | Impeccable | Raise unit and meta text to at least 12 px with sufficient contrast | Low |
| D-09 | Landmarks on `/`, `/demo`, `/pay` | axe-core: `landmark-complementary-is-top-level`, `landmark-no-duplicate-banner`, `landmark-unique`, `region` (all moderate) | The site header and the workspace header are both banners; the hero slab is an `aside` inside main | Vercel guidelines; UI UX Pro Max accessibility checklist | One banner per page; make the slab a plain section | Medium |
| D-10 | Error and not-found pages | Private routes render the bare framework 404 | Generic, unbranded dead end | Vercel guidelines | Add `not-found.tsx` and `error.tsx` in the Ink and Brass style with a route back to `/demo` | Medium |
| D-11 | Share metadata | No `opengraph-image`, robots or sitemap in `apps/web/app` | A link pasted in a judging channel renders without an image | Vercel guidelines | Add an Open Graph image built from the new wordmark and the ink slab | Medium |
| D-12 | Authenticated chrome | `screenshots-product/invoices-desktop.png` | "Sign in" shows while signed in; "Authoritative · read-only" appears twice (bar and card) on a page with a "New invoice" button; titles read "Invoices · Daidai — Daidai" and two pages fall back to the default title | Interface Design (communication) | Swap "Sign in" for the account menu; state read-only once; fix titles | Medium |
| D-13 | `/demo` double chrome | `demo-desktop.png`, `demo-mobile.png` | Site nav (with the dead links) stacked above the workspace top bar: two wordmarks on one screen | Interface Design (proportions); brief §7 | Hide the site nav inside the demo workspace and keep the workspace's own "Back to site" link | Medium |
| D-14 | Invoice creation form | `invoice-new-desktop.png` | Empty inputs with no example values, an ISO timestamp in a select, inputs at half width with a bare text-style submit | Vercel guidelines (placeholders, input types); brief §10 buttons | Example values, `inputmode="decimal"`, a human expiry picker, a primary ink button | Medium |
| D-15 | Brand mark | All pages | The diamond mark and the "Daidai" set in the UI face do not carry the brand at small sizes. A new constructed wordmark and "d" mark have been designed and approved and are not yet applied | — | Apply the approved logo set (nav, favicon, app icon, share image) | Medium |

## AI-generated design slop checklist

| Pattern | Present? | Where | Justified? |
| --- | --- | --- | --- |
| Purple and blue gradients | No | — | — |
| Glassmorphism, glows | No | — | — |
| Repetitive identical cards | **Yes** | Authenticated product, `/proof`, `/agent` | No (D-03, D-04) |
| Bento grid | No | — | — |
| Over-rounded containers | Mild | Product cards share one radius | Partly |
| Meaningless badges and pills | No | Status pills on `/demo` carry state with a glyph | Yes |
| Generic hero | **Yes** | `/` | Partly: the headline is specific, the composition is not (D-02) |
| Unmodified shadcn components | No | shadcn is not used | — |
| Generic typography | No | Schibsted Grotesk and JetBrains Mono, deliberate | Yes |
| Generic marketing language | No | Copy lint: 0 failures, 0 warnings | Yes |
| Decorative charts | No | — | — |
| Excessive animation | No | See motion section | — |
| Inconsistent visual language across pages | **Yes** | `/demo` versus everything else | No |
| Unfinished secondary screens | **Yes** | `/pay` public notice, `/proof`, authenticated pages | No |
| Template rather than designed | **Yes** outside `/demo` | — | No |

## Motion and interaction

Every keyframe, transition and the reduced-motion block in `apps/web/app/daidai.css` was checked against the ten review standards of the Emil Kowalski skill set. There is no `transition: all`. Curves are custom (`--ease-out-quint`, `--ease-in-out`). UI motion stays at 100–250 ms, with one authored 400 ms "Settled" moment that the brief specifies. A reduced-motion render of `/` reports zero running animations.

| ID | Finding | Standard | Fix | Priority |
| --- | --- | --- | --- | --- |
| M-01 | Overall: purposeful, restrained, consistent with the brief | — | Keep | — |
| M-02 | Overlay and dialog close use `ease-in` (`daidai.css:458–459`) | Standard 3: no `ease-in` on UI | Use `ease-out` at 150 ms for exits | Low |
| M-03 | Overlay, sheet and dialog entrances use the built-in `ease-out`, not the custom curve | Standard 3: built-in easings are too weak | Use `var(--ease-out-quint)` | Low |
| M-04 | `.route` fades in on every navigation (160 ms), including keyboard-driven list moves | Standard 2: frequent actions get no animation | Drop the route fade, or limit it to first load | Low |
| M-05 | Runtime motion of the review dialog and verdict band was not captured on video | — | Record once for the demo video | Low |

Interaction: the keyboard tab order on `/` is logical and every stop shows a visible 2 px brass outline. Hover, press (`scale(.98)`, 100 ms) and focus states exist on buttons.

## Would it hold up against professional products in the category?

Judgement, not measurement: `/demo` would hold up next to well-designed payment tools; it is specific and calm. The public pages and the authenticated product would not. They read as a capable engineering team's first pass. The fastest way to close that gap is not new design. It is applying the design that already exists in `/demo` everywhere else.
