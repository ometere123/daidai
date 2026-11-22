# Daidai | P08B.13 registration approval worksheet

**Read-only preparation PASS. Execution NO-GO pending separate approval and refreshed checks.** This is an unsigned decoded intent. No wallet prompt, signature or broadcast was made.

| Field | Verified specimen at 12:42 WAT on 22 November 2026 |
|---|---|
| Sender | 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e |
| Chain | Celo Mainnet 42220 |
| Registry | 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 |
| Decoded call | register(string) to mint one ERC-8004 identity to the calling EOA |
| Metadata URI | ipfs://bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui |
| Native value | 0 CELO |
| Nonce | 0 at both latest and pending |
| Attribution | Exactly one schema-0 ERC-8021 suffix carrying celo_597f1146c487 |
| Registry and account precheck | balanceOf zero at latest and finalized, account has no deployed code |
| Exact tagged simulation and gas estimate | PASS, 203,970 gas |
| Gas limit | 244,764 gas, 20% above the estimate |
| Max fee per gas | 240.001 gwei |
| Max priority fee per gas | 0.001 gwei |
| Rollup reserve | 0.000100000000000000 CELO. The oracle and operator fee estimate were zero at the check |
| Total proposed budget | 0.058843604764 CELO, comprising 0.058743604764 CELO execution cap plus 0.0001 CELO reserve |
| Finalized balance | 32.720588235294117647 CELO at finalized head 83445739, sufficient for the proposed cap |

The explicit gas and max-fee fields cap execution gas. Rollup fee reserves and estimates are planning controls and do not guarantee future L1 charges. Recheck all fees, balance, identity holdings and pending nonce immediately before any future approval. If any reviewed field or cap changes, provide a new worksheet. Confirm the MetaMask connectivity warning is resolved and the actual send path preserves the sender and calldata before requesting the owner's approval. No execution is permitted by this worksheet.

## Exact unsigned calldata

~~~text
0xf2c298be00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b72656961767070337336366a73696d793264767477336334346e677663693261716462637470677770706e63666564376a32753479756900000000000000000000000000000000000000000000000000000000000063656c6f5f353937663131343663343837110080218021802180218021802180218021
~~~

The registration tag was verified by decoding the final input. The published metadata was retrieved through an independent gateway and matched the approved SHA-256. Neither a simulated return value nor this worksheet is a minted agent ID. If separately authorized later, record the actual ID from the finalized Registered event and verify owner, agent wallet and transaction input independently. Loops attribution and identity checks remain pending.

[Publication evidence](P08B13-METADATA-PUBLICATION.md) · [Celo registry guide](https://docs.celo.org/build/agents/8004)
