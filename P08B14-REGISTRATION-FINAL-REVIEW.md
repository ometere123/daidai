# Daidai | P08B.14 final ERC-8004 registration review

**Unsigned review only. No MetaMask transaction confirmation was opened.** This packet does not authorize a signature or broadcast.

## Funding and identity evidence

Alchemy returned the successful canonical receipt for transaction 0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99. Sender 0xfd69a5d0b8330dc86e266304b3d1abe3f57b9d09 sent 32.720588235294117647 CELO to 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e. The receipt was included in block 83444273. Hash 0x9dbcfa7eb50eb27fb14555794cff39f0129a948c5bc96cda2e42e3100980fd9e resolves as that block and contains the transfer. Transaction and receipt lookups using the block hash both returned null. The previous report now labels both hashes.

At finalized head 83448688 the wallet held 32.720588235294117647 CELO. The latest balance matched. The Identity Registry returned zero currently owned identities at latest and finalized state. The sender had empty bytecode. Latest and pending nonces were both zero, so the queried RPC showed no outstanding outbound nonce. A pending nonce read does not establish absence from every mempool. [Funding receipt](https://celo.blockscout.com/tx/0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99)

## MetaMask readiness

**Read-only connectivity PASS with the operator's Alchemy RPC configured in MetaMask.** The actual extension returned the enrolled address, Celo 42220, and 32.720588235294117647 CELO at block 83450115, which the page measured as one second old. Its hash was 0xbfd9f73f789959d6f5824116f2a27947c1a1140dd35ce69d11e7f80dcfe506fd. A separate direct Alchemy request matched the exact block hash, timestamp and balance. This comparison checks the extension path against a direct query to the same provider. It is not a second-provider test. The prior connectivity warning was not visible in the supplied screenshot, and its original cause was not established. The local page was closed after verification.

The address check uses previously granted account access and calls only eth_accounts, eth_chainId, eth_getBlockByNumber and eth_getBalance. It does not change settings or ask for any new permission. The supported MetaMask send method would open a confirmation when invoked later. Actual transaction handoff, gas settings shown by the extension, and onchain tag preservation remain untested. [MetaMask send reference](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/eth_sendTransaction/)

## Exact registration intent

Alchemy refreshed the following specimen at **13:34 WAT on 22 November 2026**. The exact published 516-byte file was retrieved independently from Filebase and verified against SHA-256 157bf72f79324331a1d676d8b9c69aa2468101845379acf7b44520fe9d5398a2. Its active flag remains false.

| Field | Value |
|---|---|
| Sender | 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e |
| Chain | Celo Mainnet, 42220 |
| Destination | Identity Registry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 |
| Method | register(string), selector 0xf2c298be. Mint one identity to the calling EOA |
| Metadata URI | ipfs://bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui |
| Attribution | Exactly one schema-0 ERC-8021 suffix with celo_597f1146c487 |
| Nonce | 0 |
| Native value | 0 CELO |
| Exact calldata simulation and estimated gas | PASS, 203,970 gas |
| Gas limit | 244,764 gas |
| Max fee per gas | 240.0303403 gwei |
| Max priority fee per gas | 0.001 gwei |
| Maximum execution fee | 0.0587507862131892 CELO |
| Rollup reserve | 0.0001000000000000 CELO. Observed L1 and operator components were zero |
| Proposed maximum total budget | 0.0588507862131892 CELO |

The gas limit times max fee caps execution fees. The extra rollup reserve is a budget bound. It does not provide a protocol-level cap on future rollup fees. If nonce, fees, reserve or calldata differ when rechecked, stop and present revised values before seeking approval.

~~~text
0xf2c298be00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000042697066733a2f2f6261666b72656961767070337336366a73696d793264767477336334346e677663693261716462637470677770706e63666564376a32753479756900000000000000000000000000000000000000000000000000000000000063656c6f5f353937663131343663343837110080218021802180218021802180218021
~~~

## Expected MetaMask confirmation after separate approval

MetaMask should show the selected Daidai account, Celo Mainnet, the registry contract, zero CELO sent, and an estimated network fee paid in native CELO. It may label the action a contract interaction and display raw data instead of the method, IPFS URI or Loops tag. Compare the exact input and the advanced fee fields against the reviewed packet in the builder and any wallet details available. Reject a different sender, chain, target, value, calldata, nonce or fee cap. Reject any token spending approval, typed-data request, or network change. The only planned operation is the one registry call above.

The next step requires explicit authorization for the refreshed exact transaction. The operator personally reviews any later wallet prompt. After any separate authorized broadcast, verify the finalized receipt, full input and tag, and extract the real agent ID from Registered. No identity or attribution credit is established by this simulation.

Strict TypeScript checking, 54 regression tests with the issued Loops tag and seven isolated Chromium tests passed. No new code or credentials are included in this documentation commit.

[Celo registry](https://docs.celo.org/build/agents/8004) · [Metadata evidence](P08B13-METADATA-PUBLICATION.md)
