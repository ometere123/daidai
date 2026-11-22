# Daidai | Wallet architecture decision

**Architecture A approved. Wallet enrollment NO-GO.**

Daidai pins a dedicated MetaMask externally owned account on Celo mainnet (42220). That EOA is the intended provider sender, keyless Textile taker, ERC-8004 registrant and recipient payout sender. It is the address to enter in Loops once verified and separately approved. Loops ties scoring to the sending wallet. The organizer skill exposes an update field, but post-enrollment change eligibility and preservation of score are unknown. Treat the choice as effectively permanent. [Official event](https://www.loops.house/agents-open-for-business) · [Official event skill](https://www.loops.house/api/v1/events/agents-open-for-business/skill)

| | A · Human-approved EOA | B · Policy-controlled autonomous EOA |
|---|---|---|
| Sender and Textile taker | The selected EOA confirms the keyless proof if required and sends the direct swap | A dedicated remote signer EOA signs proof and sends the swap through an independent policy service |
| Key custody | Key stays in MetaMask. Daidai accepts only a pinned provider, chain and account. Wallet prompts remain the human authorization boundary | Non-exportable key, restricted signer API, policy-enforced spend, recipients and expiry, and emergency revocation |
| Attribution and identity | Append the issued code once at the direct-wallet boundary. The EOA registers the identity | Same requirements applied to exact bytes before remote signing. The remote EOA registers |
| Schedule | Fewer dependencies and simpler identity checks. Human confirmation can miss the quote window | More signing and recovery integration work. Lower operator latency after validation |

A retains agent behavior where Daidai controls invoice commitment, exact amount, quote validation and reconciliation, with the operator authorizing execution. End-to-end mainnet use and real recipient evidence will still be needed for the Textile track. Account abstraction is outside the adapter scope. With ERC-4337 the bundler would appear as the outer sender and the smart account must instead be identified inside the operation.

## Implemented boundary

- EIP-1193 account and chain checks run before and after preflight. Account, network or disconnect events invalidate the adapter. The call path uses eth_sendTransaction and one immutable request. It exposes no binding to a real provider, batch or relayer path, key export, or proof-signing method.
- Textile preparation uses the official exact-output request and immediate RFQ response shapes. The adapter checks allowance calldata, decoded reactor orders, taker binding, asset totals, deadline, and spend cap. The Node Celo reader requires an exact tagged-call simulation with matching transfer totals, plus gas, fee and balance checks. The RPC endpoint's actual simulation support and the Textile proof-of-control prompt remain unverified.
- The SDK appends and verifies one attribution suffix on the final approval, ERC-8004 registration, swap and payout data. The actual public code was provided to the local test process. Production must be configured with the organizer-issued code from the entry.
- Before a wallet call, SQLite atomically claims the wallet intent and the invoice state for swap/payout. A returned hash is a handoff outcome. Ambiguous, rejected or delayed outcomes cannot trigger automatic replacement. The Node Celo reader independently verifies the recorded hash, nonce, exact calldata, fee limits, finalized canonical block and exact token movement. A missing hash leaves the invoice blocked. The mock state machine remains covered by the original 19 tests.

[Textile RFQ](https://docs.textilecredit.com/api/v2/rfq.html) · [Textile OpenAPI](https://api.textilecredit.com/v2/openapi.json) · [Celo Identity Registry](https://docs.celo.org/build/agents/8004) · [Attribution SDK](https://github.com/celo-org/attribution-tags/blob/main/sdk/README.md) · [MetaMask send API](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/)

## Browser and Node boundary

Node owns SQLite, invoice policy, signing-evidence verification and Celo reads. A loopback-only request handler exchanges allowlisted wallet RPC jobs with the browser using a random bearer, an exact Origin match, expiry and one-time job IDs. The browser module owns EIP-1193 and requires explicit review before a send. It rechecks the pinned active account and chain just before that handoff. There is no HTTP listener, browser UI, or credential bootstrap in this repository. A future local host must bind loopback, keep the random bearer in browser memory, serve a trusted origin and close the session when finished. The browser sends back an outcome or a hash. It cannot provide chain receipts to Node.

Approval and recipient consent use separate EIP-712 purposes signed by the committed approver and recipient EOAs. Both bind the chain, immutable invoice digest, audience and expiry. The state machine permits the draft to be authorized only once and consumes verification objects minted by the authorization module. The older synthetic path is restricted to the mock-chain harness. No actual approval or consent signature was collected.
