# Daidai | P08B.13 registration approval worksheet

**DRAFT. No transaction is ready to sign.** This worksheet requests metadata and hosting review only. No signing, wallet prompt or broadcast is authorized here.

| Field | Planned value |
|---|---|
| Sender | 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e |
| Chain | Celo Mainnet 42220 |
| Registry | 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 |
| Method | register(string), selector 0xf2c298be |
| Decoded intent | Mint one ERC-8004 identity to the calling EOA using the approved public Daidai registration-file URI |
| Metadata URI | BLOCKED. Pending approval, publication and unauthenticated retrieval |
| Value | 0 CELO |
| Pending nonce | 0 observed. Refresh before preparing the exact request |
| Attribution | One schema-0 ERC-8021 suffix with celo_597f1146c487 |
| Exact calldata, gas, max fee per gas, priority fee, rollup reserve, total maximum cost | BLOCKED pending the actual resolving URI and qualified endpoint |
| Indicative budget | 0.0394360775 CELO for the prior placeholder specimen. This is not a cap for the final transaction |

## Gates

1. Approve the exact draft JSON and proposed IPFS hosting. Publication or pinning requires separate explicit permission. Verify the public URI returns precisely the reviewed bytes before using it.
2. Independently confirm the funding receipt is finalized and finalized CELO covers the eventual budget. Recheck the identity registry, sender code, pending nonce and unsettled intents. If an owned suitable identity exists, stop and check Loops support before proposing a duplicate.
3. Resolve the MetaMask connectivity warning and qualify the private Celo RPC. Reconfirm the pinned EOA and Celo chain with the exact reviewed send path, with signing disabled.
4. Populate register(string) with the actual public URI. Use the adapter's final tagged calldata builder. Decode the method and URI, strip the known suffix and compare the remaining bytes with fresh ABI encoding. Decode one suffix carrying only the issued code. Confirm fixed sender, chain, registry, pending nonce and zero value.
5. Simulate the full tagged bytes with eth_call and estimate gas using the same envelope. Round up the estimate with a stated margin. Choose an explicit max fee per gas and priority fee, validate live base fee, and calculate the total budget as gas limit times max fee per gas plus a separate rollup reserve. Check the actual Celo oracle and operator parameters. Reject any transport failure, unsupported fee state, insufficient funds, or stale estimate.
6. Present the exact calldata, complete decoded intent, nonce, refreshed fee fields, maximum budget and evidence to the user. Obtain separate approval for that one transaction and, if an eventual submission step is distinct, separate broadcast authorization. Stop on any mismatch. Never fill the metadata field with a placeholder.
7. After any separately authorized broadcast, independently verify the finalized receipt and actual tagged calldata. Extract the real agent ID from Registered and check owner and agent wallet. Organizer-side attribution and identity checks remain independent, and any Loops change requires explicit approval.

[Registry guide](https://docs.celo.org/build/agents/8004) · [ERC-8021 SDK](https://github.com/celo-org/attribution-tags/blob/main/sdk/README.md)
