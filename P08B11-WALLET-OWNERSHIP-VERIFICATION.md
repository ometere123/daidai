# Daidai | P08B.11 wallet ownership verification

**PASS on 22 November 2026 at 11:27 WAT.** The localhost verifier recovered 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e, exactly matching the P08B.10 address. The browser independently displayed the same result. The wallet context selected Celo Mainnet (42220).

The operator approved one offchain EIP-712 WalletOwnership challenge in MetaMask. Its domain was Daidai Wallet Ownership Verification, version 1, with chain ID 42220. The message bound the public wallet, chain, localhost origin http://127.0.0.1:51529, a random 32-byte nonce, issuance and a five-minute expiry. The signing page showed the exact payload and ownership-only purpose before opening MetaMask. The verifier consumed the challenge before recovering the signer. The ownership signature, nonce and browser screenshot were excluded from this report.

The localhost listener was closed after verification. MetaMask displayed a network-connectivity warning in the screenshot. The local proof succeeded. Operational RPC connectivity remains unverified by this test.

**Next gate:** separate explicit approval to save the verified public address in Loops. No transaction, Textile proof, firm RFQ, ERC-8004 registration or Loops change was performed. Mainnet execution remains NO-GO.
