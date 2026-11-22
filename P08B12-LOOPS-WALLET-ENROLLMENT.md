# Daidai | P08B.12 Loops wallet enrollment

**Wallet on file confirmed from the signed-in Loops screenshot supplied by the operator.** The operator saved the address manually. This was a documentation-only review.

| Check | Evidence | Status |
|---|---|---|
| Saved wallet | 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e, matching P08B.10 address access and P08B.11 signer recovery after case normalization | PASS |
| Assigned ERC-8021 code | celo_597f1146c487 | Confirmed |
| Onchain attribution | Loops displays “Tag not seen on-chain yet” | Pending |
| ERC-8004 | Loops displays “ERC-8004 Identity not checked” | Pending. The panel does not establish whether an identity exists |
| RPC and transport | MetaMask showed a connectivity warning during P08B.11. P08B.9 established read-only compatibility on QuickNode's public demo | Operational endpoint and MetaMask send path unverified |

The screenshot shows a Change control. Scoring continuity after a wallet change is unverified. Keep the verified address as the intended sender throughout the event. [Official event](https://www.loops.house/agents-open-for-business)

## Execution identity

Source inspection confirms that the address is a runtime pin supplied as WalletAdapter's sender, with the invoice taker set to the same address. There is no audited live adapter session configured for it. The table records the required wiring and its local enforcement.

| Role | Required value and code path |
|---|---|
| Textile taker and proof signer | The enrolled address. The adapter rejects a mismatched invoice taker, builds the exact-output request from that commitment and requests a taker proof for the pinned sender. The response and signed filler are checked against the same address |
| Swap sender | The enrolled address is the direct Celo transaction from. The expected conversion recipient is that same address |
| Payout sender | The enrolled address remains from. The transfer recipient is the independently authorized invoice recipient |
| ERC-8004 registrant | The enrolled address is from on the direct register(string) transaction. The registry mints the identity to that caller |
| Attribution | Configure the issued code on the runtime state adapter. The common builder adds and verifies one suffix. Rehearse the exact bytes with signing and sending disabled |

[Wallet adapter](src/wallet.ts) · [Textile parser](src/textile.ts) · [Celo ERC-8004](https://docs.celo.org/build/agents/8004)

The smallest proposed onchain step is **one tagged ERC-8004 registration at zero native value**, only if public registry checks find no suitable existing identity. That single transaction can supply evidence for both Loops checks if Loops credits its tag. If there is already a suitable identity, skip registration and seek separate approval for a genuine tagged Daidai action only when that action is needed. See the [wallet checklist](WALLET-ENROLLMENT-CHECKLIST.md). No first transaction is approved by this record.
