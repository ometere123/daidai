# Daidai | P08B.13 registration readiness

**NO-GO for signing and broadcasting.** The funding transaction is canonical and successful. Funding finality, the dedicated runtime RPC, a publicly resolvable approved metadata URI, and explicit authorization for the exact resulting transaction are still gates. No wallet settings or Loops fields changed.

## Public Celo checks

| Check | Observed on 22 November 2026 |
|---|---|
| Chain | Celo Mainnet 42220 |
| Funding | 32.720588235294117647 native CELO from 0xfd69a5d0b8330dc86e266304b3d1abe3f57b9d09 to 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e |
| Receipt | Successful at block 83444273, hash 0x9dbcfa7eb50eb27fb14555794cff39f0129a948c5bc96cda2e42e3100980fd9e. Transaction and receipt agreed with the canonical block |
| Finality | Forno finalized head 83443816, below the funding block, at 12:13 WAT |
| Balance | Latest 32.720588235294117647 CELO. Finalized 0 CELO at the observed finalized state |
| Activity | Latest, finalized and pending outbound nonce 0. Blockscout outgoing list empty. No unexpected outbound transaction observed |
| Identity | Registry balanceOf zero at latest and finalized. Empty wallet bytecode at latest. No currently owned identity was found |

[Funding receipt](https://celo.blockscout.com/tx/0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99) · [Celo ERC-8004 registry](https://docs.celo.org/build/agents/8004)

## RPC and gas oracle

MetaMask reported a connectivity warning during the successful offchain ownership check. Node successfully read public Celo endpoints in this phase, while some public calls timed out. That evidence cannot isolate the extension warning. The separately authorized follow-up should inspect the existing network configuration locally, confirm chain 42220, and verify that MetaMask can load current balance and height. Check the application endpoint separately. A Node RPC result does not verify the extension.

No DAIDAI_CELO_RPC_URL was present in the process. **Dedicated RPC qualification is BLOCKED.** The QuickNode public docs demo passed the extended check at 12:12 WAT, including a USDt decimals read and gas estimate, finalized/canonical block agreement, receipt lookup and validation-mode eth_simulateV1 with exact transfer-log accounting. This is compatibility evidence only. Configure the dedicated QuickNode Celo Mainnet URL privately through local environment configuration, then run npm run probe:celo and review only the redacted result. The probe checks fresh finalized and canonical blocks, receipt and transaction lookup, contract read, gas estimation and validation-mode eth_simulateV1 transfer-log accounting. Keep the URL and provider error text out of logs, chat and Git. [QuickNode Celo simulation](https://www.quicknode.com/docs/celo/eth_simulateV1) · [Celo Forno](https://docs.celo.org/build/tools/nodes/forno)

The pinned viem 2.45.0 Celo chain definition omits gasPriceOracle. The previous OP Stack helper therefore failed local address resolution. Read-only Celo mainnet checks established deployed code at GasPriceOracle 0x420000000000000000000000000000000000000F and L1Block 0x4200000000000000000000000000000000000015. The oracle reported version 1.6.0 and zero for getL1Fee on the queried envelope. Both operator fee parameters returned zero. The same oracle returned zero for the prior tagged representative registration.

The fix explicitly queries Celo's verified oracle via estimateL1Fee, plus both L1Block operator fee parameters, and checks the observed fee against its own rollup reserve and the total cap. RPC errors propagate, and nonzero operator parameters fail closed until reviewed. This avoids the prior helper's permissive operator fallback. No zero fee is hardcoded for L1. [OP Stack predeploy specification](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/predeploys.md) · [Celo L2 specification](https://specs.celo.org/) · [Viem L1 estimator](https://viem.sh/op-stack/actions/estimateL1Fee)

## Metadata and exact transaction

[DAIDAI-ERC8004-METADATA.json](DAIDAI-ERC8004-METADATA.json) is the proposed public content draft in the private repository. It uses registration-v1, declares the prototype inactive and has no services or x402 support. It advertises no production endpoint. The recommended image and post-mint registration cross-reference are absent pending real assets and the emitted identity ID.

**Recommended hosting:** public, content-addressed IPFS with persistent pinning and an independent retrieval check. Use the resulting ipfs://CID if the chosen indexer supports it. Otherwise, use separately approved stable public HTTPS that serves the same reviewed bytes. The private GitHub raw URL is not public hosting. Before requesting signature approval, retrieve the published bytes unauthenticated, compare them to the approved file and confirm resolver compatibility. No metadata has been published. [ERC-8004 registration file specification](https://eips.ethereum.org/EIPS/eip-8004#agent-uri-and-agent-registration-file)

The [approval worksheet](P08B13-REGISTRATION-APPROVAL.md) records known fields, pending fields, and the exact verification sequence. A prior placeholder simulation estimated 135,519 gas, roughly 0.02744 CELO at the sampled gas price. The sample buffered L2 cap was 0.0394360775 CELO. The latest balance covers that sample by a wide margin, while the finalized balance did not at the recorded head. Those figures are planning evidence only. They cannot authorize or price the future exact transaction.

## Verification

Strict TypeScript checking passed. The issued-tag run passed all 54 regression tests, with zero failures and no skips. All seven isolated Chromium tests passed. The new tests verify the exact oracle target, successful zero and nonzero L1 fee reads, rollup reserve enforcement, RPC failure propagation and refusal of nonzero operator parameters. The corrected helper also ran against public Forno on an unsigned USDt decimals call. Gas was 30,951, estimated total fee 0.0062675775 CELO and rollup fee 0 CELO at that instant. This is a fee-helper probe, not an estimate for the approval transaction.
