# Daidai P11 demo and operations

## Rehearse the product

Use the P11 worktree, Node 22, and a Chromium executable installed for Playwright. Run this from the repository root. The build is local and the test seeds disposable Worker D1. Re-seed before each run because invitations are single-use.

```sh
npm ci
npm --prefix workers/api ci
npm --prefix apps/web ci
npx playwright@1.65.1 install chromium
npm --prefix apps/web run build
npm --prefix workers/api run seed
node workers/api/scripts/e2e-auth-flow.mjs --product
```

Set `DAIDAI_CHROMIUM_PATH` to the executable if using system Chrome. Add `--headed` to watch the walkthrough. Use a local graphical session for that mode. The browser test uses synthetic viewer sessions and wallets. Keep the ignored `.wrangler/demo-identities.json` and `.dev.vars` private. Run the seed only in this isolated worktree with local servers stopped. For a repeatable schema-only migration that preserves existing local records, run `npm --prefix workers/api run migrate:local` after seeding and before starting the local Worker.

### Three-minute narration

1. **Merchant.** Sign in, create a 1,500 cNGN invoice, edit the maximum USDt debit to 1.10, then commit. Point out the immutable digest and revision history.
2. **Payer.** Open the generated payment link after signing in separately. Show the payable cNGN amount, recipient, maximum debit and the explicitly simulated quote. It shows 1 USDt plus a 0.001 USDt protocol fee within the 1.10 cap. The local preview window is not a maker order deadline.
3. **Reconciliation.** Show that conversion credits the taker and payout is a separate exact recipient transfer. Open the simulated unknown outcome. Real approval and consent are absent. The product offers no retry and displays no settled claim. Revoke the link and show that the payer immediately loses access. Cancel and show the previous commitment remains in history.
4. **Identity.** Daidai’s existing Celo ERC-8004 agent ID is 10103. Cite the P08 registration and Loops outcome separately from these simulated invoices.

Evidence checklist: final CI link, browser check counts, immutable digest and history, scoped payer view, hidden fixture provenance, unknown-outcome screen, and public registration hash `0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b`. Keep invitations, HMAC keys, invoice query bodies, and share codes out of recordings. The browser uses temporary profiles, no extension, and a wallet-call counter.

## Trust and operations

- The Next server uses the existing HMAC service contract. Worker replay storage, session expiry, merchant authorization, idempotent creation and conditional append are resolved before returning any private invoice data. A payer must already have an authenticated viewer session. The capability allows one committed revision until revoked or expired. It is hashed in D1, derived server-side, and kept out of URL paths and query strings. No spending authority is attached.
- Demo invoice records are local D1 records. With `DAIDAI_LOCAL_TEXTILE_PREVIEW=1`, the isolated Next server can request an indicative Textile preview using only the chain, token pair and exact output amount. The automated demo keeps this off. Approval, recipient consent and settlement evidence are not attached to newly created P11 invoices. Their quote and unknown-payout drill are simulated. The existing verified read-only projection remains a separate data path. No price, wallet readiness or P11 payment evidence can be promoted into it.
- The guarded product API only operates against the isolated Miniflare runtime. The Vercel product gate stays disabled and the Worker config has no public routes. Preserve the reviewed private environment gates. Treat invitation login as a tested local flow and require an approved production identity plan before opening private invoice access.
- For a future authorized deployment, configure Next.js with root `apps/web`, Node 22, routine build and default-off preview/production flags. Keep the server-only API URL and service key in the platform secret store. Cloudflare uses the existing Worker config and a reviewed D1 binding. Confirm the actual account's limits against official guidance. Workers Free documents 100,000 requests/day, 10 ms CPU per request and 50 subrequests; D1 Free documents a 500 MB maximum per database and a seven-day Time Travel window. Vercel Hobby is limited to personal, non-commercial use. This demo incurs no hosted usage. Verify the intended live use complies before enabling it. [Vercel Hobby](https://vercel.com/docs/plans/hobby) · [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- Rotate service keys by adding the new ID and independent secret to the verifier, switching the signer, observing both deployment versions, then removing the retired key after the overlap. Plan cookie/share invalidation and revoke affected sessions. P10.5 documents the local revocation command. Keep the commercial operator role and limits separate from merchant/viewer access.
- Before any remote schema change, export and encrypt the approved database backup, verify restoration in isolated D1, inspect the additive migration plan and record row counts. On a failure, disable private routes, stop writes, restore or roll forward under review, and verify every attempt against the canonical chain before considering new execution. Never restore/replay over the P08 ledger or reset nonce reservations.
- Monitor denied requests, replay, service throttles, D1 errors, invitation abuse, stale observations, reorg mismatches and unknown outcomes. Log route codes and correlation IDs. Keep credentials, signatures, private invoice bodies, capability codes and financial session data out of logs. Before public use, set a distributed rate limit, retention/deletion policy, alerts and incident owners.

## First owner-approved settlement checklist

1. Owner approves production identity, operator separation, tenant permissions, data handling, Cloudflare D1 migration, limits, and deployment target. Qualify an independent Celo endpoint and finality policy. Test both token identities, receipt transfer logs, cap accounting and canonical finality against Celo and retain evidence.
2. Choose a consenting recipient and the smallest acceptable cNGN target. Fix the payer cap, designated taker, recipient, chain and exact amounts in the approved commitment. Obtain independently verified, invoice-bound EIP-712 approver authorization and recipient consent. Confirm native gas reserve and available USDt.
3. Separately approve any required bounded USDt allowance to the verified spender. Obtain a firm Textile RFQ only under specific authorization. Review `takerPays` including fee, exact output, taker, corridor, maker deadline, transaction bytes and attribution. Simulate the exact reviewed call, verify it again after any delay, and fail closed on discrepancies.
4. Review and persist the operation claim and nonce before handing off the exact reviewed conversion for explicit human authorization. Reconcile the finalized transaction and transfers, including all-in debit and exact cNGN received by the taker. If a hash is missing or evidence disagrees, retain the claim and stop.
5. Separately authorize one exact cNGN payout to the committed recipient after verified conversion. Finalize and independently verify amount, token, recipient, sender, envelope and attribution. Mark settled only when both operations meet their finalized verification rules. Unknown or ambiguous outcomes require independent reconciliation and explicit approval before any future attempt.
