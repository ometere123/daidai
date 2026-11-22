# P08B.23 ERC-8004 registration

The user authorized one session on reviewed commit 1f1a0f298f4c0ab25d083bda4e553c84df91c7b7 and personally confirmed in MetaMask. The session returned one hash and closed. No retry or ledger reset was performed.

## Onchain evidence

| Field | Value |
| --- | --- |
| Transaction | 0xdefee0ab7ede1b8d787b195218cc922681364af1f42264f4332fd3309672161b |
| Chain | Celo Mainnet (42220) |
| Receipt block | 83479621 |
| Canonical block hash | 0x1558a6120f0d99bab5b85806a854659407c96dd2ff16c51b79a75453fed5a72b |
| Registry | 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432 |
| Agent ID | 10103 |
| Sender, owner and agent wallet | 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e |
| Metadata URI | ipfs://bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui |
| Native value and nonce | 0 CELO, nonce 0 |
| Attribution | One celo_597f1146c487 suffix in the exact approved calldata |
| Actual fees | 201206 gas at 200001000000 wei per gas and 0 CELO L1 fee, totaling 0.040241401206 CELO |
| Reviewed budget | 0.0588678364 CELO |
| Review fingerprint | 3737d50afbbe26c480c440ad3ecdc81ff05b42c0b720d3e879b43b59309214e5 |

The receipt was successful and emitted the registry Registered event and matching ERC-721 mint. The onchain transaction matched the reviewed sender, registry, nonce, input, value, gas limit and fee settings. The Loops project was untouched. The tag was verified in Celo calldata. Loops indexing was not checked.

The independent Alchemy check reached finalized head 83479917, beyond the receipt block. It matched the canonical block hash and verified ownerOf, tokenURI and getAgentWallet at that finalized head.
