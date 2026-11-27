# Daidai — authoritative agent instructions
Read in order: PROGRESS.md → docs/PROJECT.md → docs/PRD.md → docs/ARCHITECTURE.md → docs/IMPLEMENTATION.md → docs/TESTING.md → docs/DESIGN.md → docs/DEMO.md. README is entrypoint; old P08–P13 documents are historical evidence. If conflict, PDR-001 and R01–R12 govern unless owner approves a new decision. Existing safety restrictions are not waived by documentation.

## Rules
1. Investigate before changing code. Read exact files, callers, schemas, tests and official docs; inspect lockfiles. Do not invent methods or assume unopened code. Record verified facts separately from hypotheses and blockers.
2. Implement only authorised milestone scope; prefer the smallest working change, preserve existing controls and tests. No wallet migration, new track, model, dependency or architectural rewrite without a compelling verified reason and decision update.
3. Use strict TypeScript, discriminated results, validated untrusted inputs, integer atomic amounts, immutable reviewed envelopes, durable journal. One authoritative financial writer; no direct browser trust or blind retries. Keep fixture/live paths isolated.
4. Financial actions require separate explicit operator authorisation; no secrets, private keys, unapproved deployment, firm reservation, approval/signing or transaction. Default-deny, protect session/HMAC/CSRF, avoid private data in logs. Do not weaken exact simulation/finality to pass tests.
5. Test changes, add adversarial regressions, run affected suites and exact-head CI. Never claim success for unrun tests or synthetic work. Verify screens with keyboard, screenshots and accessible states. Reuse Ink and Brass; no generic dashboard or gratuitous motion.
6. Work autonomously on reversible technical choices, parallelize independent work where safe; challenge requirements, report failures and disclose decisions. Keep PROGRESS current with exact commit, commands/results, blockers, next action. Prioritize P0 and evidence over cosmetics. No background-work promises or fabricated status.

## Original six operating instruction excerpts
The exact original six excerpts are **not available in the accessible conversation context or inspected repository**. The six rules above are derived operational guidance, not quotations. Do not invent or label them verbatim. Insert the actual original text here when available; record provenance and reconcile conflicts without silently altering it. This outstanding archival requirement does not waive any existing safety or scope constraint.
