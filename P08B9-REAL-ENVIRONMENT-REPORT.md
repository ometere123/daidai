# Daidai | P08B.9 real-environment preflight

Reviewed base commit 3885acd1e5f1a79facf65d1fa4fcdd6c7493ca17. The execution workflow remains disconnected throughout this phase. No account permission, signature, firm RFQ, transaction, token movement or Loops change was requested.

## RPC qualification

The probes used read-only Celo mainnet JSON-RPC with no wallet or credentials. The decimals call used Daidai's normal blockStateCalls/calls, validation=true and latest parameters. A separate shape probe used simulation-only code overrides at the synthetic router and token emitters. The bytecode emits standard ERC-20 Transfer logs and writes no storage. None of the synthetic addresses or balance overrides were sent to a transaction endpoint.

| Provider | Result |
|---|---|
| QuickNode public documentation demo | QUALIFIED for read-only API compatibility. Confirmed chain 42220, successful validation-mode simulation, finalized and numbered block hash agreement, and matching historical type-2 transaction and receipt. Public demo returned some HTTP 429 responses on a parallel attempt. At 06:21 WAT the finalized sample was 1,028 seconds old. A private operational endpoint has yet to be configured and qualified |
| PublicNode public Celo endpoint | BLOCKED as the primary preflight provider. Read and simulation shapes passed, but its sampled finalized block was 1,606,888 seconds old, about 18.6 days, even though its latest block was current |
| Celo Forno | BLOCKED for swap simulation. Finalized, canonical and historical reads returned, but eth_simulateV1 returned HTTP 403 with JSON-RPC -32601 |

QuickNode returned USDt decimals as six and one simulated call with status 0x1. The two returned logs decoded through the same accountTransferLogs function used by src/celo.ts in both simulation and receipt validation. It counted an outgoing 1,100,220 USDt atomic units and an incoming 1,500,000,000 cNGN atomic units. Removing the cNGN log failed the exact-output test. PublicNode returned the same accounting result. No real Textile order or fee path was simulated. Fixtures contain no signing or sending method. The production reader's checks are unchanged. The qualification probe separately rejects a latest block more than five minutes stale or a finalized block more than four hours stale. These are preflight screening thresholds.

QuickNode's observed historical type-2 transaction and receipt matched finalized block 0x4f8ef6c and hash 0x3f9b0efbbbd6862fbb6f74d4d0270ded67d9c468d378e81b982d71920ac992cc. Transaction 0x6c791b858bcf41cef737973cc22dc6473eda60b09db8ff0cacc516413be19b17 reported chain 42220, successful receipt status and four logs. These are pre-existing public chain data. There is no Daidai receipt.

To re-probe a provisioned endpoint, configure DAIDAI_CELO_RPC_URL privately in the local process environment and run npm run probe:celo. The script redacts the configured URL and suppresses provider error text. Do not pass a private URL on the command line, paste it in chat, or commit it. For the public demo and controls run npm run probe:celo -- --curl, or add --forno or --publicnode. The Curl mode refuses private configuration.

[QuickNode Celo simulation](https://www.quicknode.com/docs/celo/eth_simulateV1) · [QuickNode Celo setup](https://www.quicknode.com/docs/celo/quickstart) · [Forno](https://docs.celo.org/build/tools/nodes/forno)

## First MetaMask verification

1. Obtain separate approval for the address-only prompt and the candidate public address. The operator manually selects that dedicated MetaMask account and Celo mainnet 42220.
2. Start the isolated loopback host with npm run address:preflight -- followed by the expected public address. Open the reported localhost URL in the intended browser only after approval. The page displays the pinned address and chain. It never requests account permission on page load.
3. The operator clicks **Request public account access**. The page reads eth_chainId first and refuses to prompt on the wrong chain. It then uses eth_requestAccounts with no parameters to request MetaMask's eth_accounts permission for that local origin. MetaMask may return all public addresses authorized for this origin. The page requires the first active address to equal the expected address and re-reads eth_accounts and eth_chainId. A change or disconnect invalidates the result.
4. Inspect the MetaMask prompt and accept only the public-account access permission for the displayed 127.0.0.1 origin. Stop if any signature, transaction, network switch, advanced permission or secret is requested. Close the local host after the test. If desired, remove the site's permission in MetaMask.

The address-only host has no wallet job routes, bootstrap, proof-signing methods, transaction methods, account export or network switch functionality. It uses a dedicated browser module that can only call eth_chainId, eth_requestAccounts, and eth_accounts. Provider identification uses an unambiguous MetaMask announcement or a single marked legacy provider. Browser-provided labels are hints. Confirm the extension identity yourself. A passing check establishes the account exposed by the extension on Celo. Separate evidence is still required to prove cryptographic control or the actual onchain sender.

[MetaMask eth_requestAccounts](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_requestAccounts/) · [MetaMask eth_accounts](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_accounts/)

## Tests and decisions

Strict TypeScript checking passed. All 53 regression tests and all seven isolated Chromium tests passed with zero failures or skips. Use Node 22.23.3. Run npm ci --ignore-scripts --no-audit --no-fund, npm run typecheck, npm test, and npm run test:browser. An installed Chromium binary is required for the browser suite. The runner detects common Windows and Linux locations or accepts DAIDAI_CHROMIUM_PATH. It starts a fresh headless profile with extensions disabled, then injects a test provider. Cases cover no automatic request, correct account, incorrect chain and account, account change after verification, change during the prompt, refusal, no injected wallet, and absence of financial routes. The installed MetaMask extension has not been tested.

| Gate | Decision |
|---|---|
| Address-only wallet verification | GO for the isolated test once the operator separately approves the real permission prompt and supplies the public address. Until then, do not open the real flow |
| Loops agent wallet enrollment | NO-GO. Require the actual address-only check, separately authorized proof of control, exact execution identity, the issued tag and separate approval to record that address. Treat changes after enrollment as uncertain |
| Firm quote and mainnet payment | NO-GO. Require an independently reprobed operational RPC with full simulation and read support, live wallet path and approval timing verified, genuine invoice and independent recipient consent, authorized budgets and public balances/allowance reviewed. Resolve the ERC-8004 and Loops checklist in a separately authorized phase. Keep explicit individual approvals for proof, firm RFQ, allowance, registration, swap and payout |

The address check is independent of both the Loops submission and the financial workflow. The proof workflow still has no firm-request HTTP client. [Official event](https://www.loops.house/agents-open-for-business) · [Textile RFQ](https://docs.textilecredit.com/api/v2/rfq.html) · [Starter framework](https://github.com/udaysharmadev/Hackathon-Starter-Pack-Complete-Guide-Roadmap)
