# Daidai P08B.15 registration execution readiness

**PASS for read-only preparation and mock handoff. Live registration requires separate approval.** The real MetaMask transaction method was never invoked during this phase. No identity was minted and Loops attribution remains unchecked onchain.

## Read-only mainnet evidence

The independently retrieved registration file matched the approved 516 bytes and SHA-256 `157bf72f79324331a1d676d8b9c69aa2468101845379acf7b44520fe9d5398a2`. Its `active: false` status describes Daidai's pre-release state.

The private Alchemy reader checked Celo Mainnet at 2026-11-22 12:44:11 UTC. Latest head was 83,450,698 and finalized head was 83,449,456. The original funding hash `0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99` matched the canonical payment and successful receipt in block 83,444,273. Latest and finalized balance were both 32.720588235294117647 CELO. The account had empty code at latest. Latest, pending and finalized nonces agreed at 0. The registry balance was 0 at both checked heads. Fresh gas estimation and the Celo rollup fee oracle passed the stated budget checks. The exact tagged call returned an ABI-sized ID in read-only simulation. That value is provisional.

## Exact reviewed request

| Field | Value |
|---|---|
| Chain | Celo Mainnet, 42220 (`0xa4ec`) |
| Enrolled EOA | `0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e` |
| Identity Registry | `0x8004a169fb4a3325136eb29fa0ceb6d2e539a432` |
| Method | `register(string)` |
| Agent URI | `ipfs://bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui` |
| Attribution | Exactly one schema-0 suffix with `celo_597f1146c487` |
| Nonce | 0 |
| Native value | 0 CELO |
| Gas limit | 244,764 |
| Max fee per gas | 240.1 gwei |
| Max priority fee per gas | 0.001 gwei, included in the max fee per gas |
| Maximum execution fee | 0.0587678364 CELO |
| Rollup fee reserve | 0.0001 CELO |
| Reviewed total fee budget | **0.0588678364 CELO** |

The gas limit and per-gas cap constrain the execution component. The rollup reserve is enforced in preflight against the oracle estimate. The EIP-1559 request has no field that hard-caps the actual rollup fee at inclusion. This total is the approval budget, with that limitation. Abort if MetaMask displays a higher total or requires an edit to proceed.

```text
0xf2c298be00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b72656961767070337336366a73696d793264767477336334346e677663693261716462637470677770706e63666564376a32753479756900000000000000000000000000000000000000000000000000000000000063656c6f5f353937663131343663343837110080218021802180218021802180218021
```

Review fingerprint `3737d50afbbe26c480c440ad3ecdc81ff05b42c0b720d3e879b43b59309214e5` covers the exact request fields and displayed intent and budget. The session expiration is generated locally on each run. The fingerprint detects a changed intent and does not confer human approval.

## Operator procedure after separate approval

1. In the permanent Daidai repository, load the private Alchemy endpoint into the current PowerShell process. Run `npm run registration -- --review`. This mode does not start the local host or request any wallet method. Compare nonce, full calldata and fee budget to this packet. A changed fingerprint requires a new review.
2. Once the exact intent has been separately authorized, run `npm run registration -- --arm 3737d50afbbe26c480c440ad3ecdc81ff05b42c0b720d3e879b43b59309214e5`. The command refreshes chain, funding, balance, registry ownership, nonce, gas and simulation. It fails closed if any gate fails. A successful arm opens a short-lived listener on port 51529 with a one-use URL printed to the terminal. Open that URL manually in the browser profile that previously granted account access.
3. Read the displayed intent before clicking **Start reviewed registration**. The page uses existing account permission and does not request a network switch. The application checks account and network, confirms the exact wallet job, then checks account and network again. Cancel locally or close the session with Ctrl+C before dispatch. If MetaMask is already open, reject there. Local cancellation cannot retract a provider request already issued.
4. MetaMask should present one Celo contract interaction with zero native value and a network fee. Check the selected account, full registry destination, nonce, gas settings and raw calldata using the available details. Labels and visible fields can vary by MetaMask version. Reject if the required fields cannot be verified, the transaction differs, or there is any separate signature, approval, batch, network change or smart-account prompt. The mock proves the exact EIP-1193 request and does not establish how the real wallet will display or serialize it.
5. Record the returned hash and wait for canonical finality. Compare the transaction's sender, chain, nonce, recipient, input, value and fee fields against the reviewed envelope. Check receipt success, actual execution and rollup fees, the registry's `Registered` event, the mint event and resulting owner and URI for the minted agent ID. Decode the tag from the onchain input. The external Loops identity and attribution checks remain separate steps.

## Cancellation and ambiguous submission

The SQLite ledger `.daidai-registration.sqlite` is ignored by Git and uses a single durable registration key for the enrolled wallet. It records the exact request before delivery. A second attempt is blocked across process restarts, even for an explicit decline. The browser also refuses a second provider send within the same session. There is no reset or retry command.

If the wallet was opened and the outcome is unclear, preserve the ledger. Review MetaMask activity, look up any known hash independently, and locate candidate transactions for the exact sender and nonce using trusted Celo chain evidence. Inspect the registry owner and events at finalized head. A missing hash or unchanged nonce alone does not rule out a pending or delayed transaction. If matching canonical success is found, finish verification without a new registration. If the evidence remains inconclusive, stop. Any future recovery of the registration path must have a separately reviewed reconciliation and fresh authorization.

## Tests

- `npm run typecheck` passed under strict TypeScript settings.
- `npm test` passed 54 of 54 regression tests.
- `npm run test:browser` passed 16 of 16 tests in isolated Chromium with extensions disabled. Nine tests used the dedicated registration page and an injected mock for exact handoff, rejection, timeout, account and chain invalidation, altered calldata, cancellation, local decline and nonce drift. The tests verified that recorded attempts block replay across new sessions.
- `npm run registration -- --review` passed with private RPC configuration. No armed live session was run.

Sources for the registry and wallet request contract. [Celo ERC-8004](https://docs.celo.org/build/agents/8004) · [MetaMask eth_sendTransaction](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/)
