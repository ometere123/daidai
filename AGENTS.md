# Daidai — authoritative agent instructions
Read in order: PROGRESS.md → docs/PROJECT.md → docs/PRD.md → docs/ARCHITECTURE.md → docs/IMPLEMENTATION.md → docs/TESTING.md → docs/DESIGN.md → docs/DEMO.md. README is entrypoint; old P08–P13 documents are historical evidence. If conflict, PDR-001, PDR-002 (owner correction of 27 November 2026: the deliverable is a hosted application a real user can complete a real obligation in, with the local pilot as qualification harness) and R01–R18 govern unless owner approves a new decision. Existing safety restrictions are not waived by documentation.

## Rules
1. Investigate before changing code. Read exact files, callers, schemas, tests and official docs; inspect lockfiles. Do not invent methods or assume unopened code. Record verified facts separately from hypotheses and blockers.
2. Implement only authorised milestone scope; prefer the smallest working change, preserve existing controls and tests. No wallet migration, new track, model, dependency or architectural rewrite without a compelling verified reason and decision update.
3. Use strict TypeScript, discriminated results, validated untrusted inputs, integer atomic amounts, immutable reviewed envelopes, durable journal. One authoritative financial writer; no direct browser trust or blind retries. Keep fixture/live paths isolated.
4. Financial actions require separate explicit operator authorisation; no secrets, private keys, unapproved deployment, firm reservation, approval/signing or transaction. Default-deny, protect session/HMAC/CSRF, avoid private data in logs. Do not weaken exact simulation/finality to pass tests.
5. Test changes, add adversarial regressions, run affected suites and exact-head CI. Never claim success for unrun tests or synthetic work. Verify screens with keyboard, screenshots and accessible states. Reuse Ink and Brass; no generic dashboard or gratuitous motion.
6. Work autonomously on reversible technical choices, parallelize independent work where safe; challenge requirements, report failures and disclose decisions. Keep PROGRESS current with exact commit, commands/results, blockers, next action. Prioritize P0 and evidence over cosmetics. No background-work promises or fabricated status.

## Owner-supplied operating instruction excerpts
Verbatim from the Phase Five instruction message (six tagged excerpts and the untagged over-engineering rule). Historical wording before this message was not independently recovered. Financial approval boundaries above remain in force.

~~~text
<investigate_before_answering>
Never speculate about code you have not opened.
</investigate_before_answering>

<default_to_action>
By default, implement changes rather than only suggesting them.
</default_to_action>

<use_parallel_tool_calls>
If you intend to call multiple tools and there are no dependencies between the tool calls, make all of the independent tool calls in parallel.
</use_parallel_tool_calls>

Avoid over-engineering. Only make changes that are directly requested or clearly necessary.

<frontend_aesthetics>
You tend to converge toward generic, “on distribution” outputs.
</frontend_aesthetics>

<avoid_excessive_markdown_and_bullet_points>
When writing reports, documents, technical explanations, analyses, or any long-form content, write in clear, flowing prose using complete paragraphs and sentences.
</avoid_excessive_markdown_and_bullet_points>

<autonomous_execution>

Do not repeatedly ask me what to implement next when the documentation already establishes the priorities.

Do not stop after producing recommendations, code snippets, implementation plans, or explanations when you have the tools and permissions to implement the changes directly.

Investigate problems independently. Consult official documentation, inspect the codebase, reproduce errors, identify root causes, implement fixes, and verify the results.

Make reasonable, reversible engineering decisions autonomously.

Ask for my intervention only when genuinely blocked by missing credentials, unavailable permissions, irreversible decisions, external costs, or essential information you cannot obtain independently.

Never fabricate successful execution, testing, deployment, or completion.

</autonomous_execution>
~~~
