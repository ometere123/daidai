# Daidai | Wallet enrollment checklist

**Enrollment NO-GO.** The local adapter and its mock proof are ready for independent review. The actual wallet and transport remain unverified.

1. Obtain explicit authorization for the next verification phase. Record the candidate public address and display the expected chain and issued Loops code.
2. On an approved local origin, grant address-only access to the intended MetaMask account. Compare eth_accounts and eth_chainId with the pinned configuration. Independently read account bytecode and reject contract or delegated accounts.
3. With separately authorized user participation, use an expiring, domain-bound offchain challenge recovered to the same address to demonstrate key control. A read-only account lookup alone cannot prove this. Stop if the account, origin, chain or displayed intent differs.
4. Rehearse all four exact unsigned calldata paths through an intercepting provider. Confirm each uses the same selected EOA and a single issued suffix. Review the complete request and its gas, fee and nonce bounds. Obtain independent source review and verify the allowlisted Celo endpoint supports finalized reads, rollup fee estimates and transfer-log simulation for the intended contracts. Keep signing and sending disabled during rehearsal.
5. Obtain specific approval to save the exact public address in the Loops agent-wallet field. Confirm the saved value agrees with the pinned execution address. Prefer the same address throughout the event. A later wallet change and scoring continuity remain undocumented.
6. Obtain separate authorization for each subsequent applicable action, including ERC-8004 registration, allowance, proof-of-control signature, firm RFQ reservation, swap, Textile hash reporting and payout. Independently verify the recovered sender, full calldata, finalized receipts, token transfers and Loops attribution. A real recipient and genuine invoice are required before settlement.

Stop on any discrepancy or unresolved prior attempt. Never infer settlement from the wallet returning a hash or Textile reporting filled alone.
