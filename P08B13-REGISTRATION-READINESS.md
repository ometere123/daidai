# Daidai | P08B.13 registration readiness

**NO-GO for signing and broadcasting.** The enrolled wallet has finalized funding, Alchemy passed the dedicated read-only probe, and the approved public IPFS bytes resolved independently. The exact unsigned registration simulated successfully. MetaMask connectivity, refreshed values and explicit transaction approval remain gates. No wallet settings or Loops fields changed.

## Initial public Celo checks and finality refresh

| Check | Observed on 22 November 2026 |
|---|---|
| Chain | Celo Mainnet 42220 |
| Funding | 32.720588235294117647 native CELO from 0xfd69a5d0b8330dc86e266304b3d1abe3f57b9d09 to 0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e |
| Receipt | Successful transaction 0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99 in block 83444273. The containing block hash is 0x9dbcfa7eb50eb27fb14555794cff39f0129a948c5bc96cda2e42e3100980fd9e. Transaction and receipt agreed with the canonical block |
| Finality | Forno finalized head 83443816, below the funding block, at 12:13 WAT |
| Balance | Latest 32.720588235294117647 CELO. Finalized 0 CELO at the observed finalized state |
| Activity | Latest, finalized and pending outbound nonce 0. Blockscout outgoing list empty. No unexpected outbound transaction observed |
| Identity | Registry balanceOf zero at latest and finalized. Empty wallet bytecode at latest. No currently owned identity was found |

The later dedicated Alchemy check passed at 12:42 WAT. Funding was finalized at head 83445739, with 32.720588235294117647 CELO at that finalized block. The exact registration check found zero holdings at latest and finalized state and nonce 0 at latest and pending.

[Funding receipt](https://celo.blockscout.com/tx/0xd8d76e199c531e49c44e9db8bb2f50932d45f04f180f6b4df7b84d65f7317b99) · [Celo ERC-8004 registry](https://docs.celo.org/build/agents/8004)

## RPC and gas oracle

MetaMask reported a connectivity warning during the successful offchain ownership check. Node successfully read public Celo endpoints in this phase, while some public calls timed out. That evidence cannot isolate the extension warning. The separately authorized follow-up should inspect the existing network configuration locally, confirm chain 42220, and verify that MetaMask can load current balance and height. Check the application endpoint separately. A Node RPC result does not verify the extension.

**Dedicated Alchemy Celo Mainnet qualification PASS.** The newly rotated endpoint was loaded into a temporary process environment. The report retains only check outcomes. Chain 42220, latest and finalized freshness, canonical block and receipt lookups, contract reads, gas estimation, Celo fee oracle, and eth_simulateV1 with transfer logs all passed. Removing the expected output log was rejected. No endpoint or key is recorded. [Alchemy Celo simulation documentation](https://www.alchemy.com/docs/chains/celo/celo-api-endpoints/eth-simulate-v-1)

The pinned viem 2.45.0 Celo chain definition omits gasPriceOracle. The previous OP Stack helper therefore failed local address resolution. Read-only Celo mainnet checks established deployed code at GasPriceOracle 0x420000000000000000000000000000000000000F and L1Block 0x4200000000000000000000000000000000000015. The oracle reported version 1.6.0 and zero for getL1Fee on the queried envelope. Both operator fee parameters returned zero. The same oracle returned zero for the prior tagged representative registration.

The fix explicitly queries Celo's verified oracle via estimateL1Fee, plus both L1Block operator fee parameters, and checks the observed fee against its own rollup reserve and the total cap. RPC errors propagate, and nonzero operator parameters fail closed until reviewed. This avoids the prior helper's permissive operator fallback. No zero fee is hardcoded for L1. [OP Stack predeploy specification](https://github.com/ethereum-optimism/specs/blob/main/specs/protocol/predeploys.md) · [Celo L2 specification](https://specs.celo.org/) · [Viem L1 estimator](https://viem.sh/op-stack/actions/estimateL1Fee)

## Metadata and exact transaction

The exact [approved JSON](DAIDAI-ERC8004-METADATA.json) is now pinned publicly through Pinata Free and independently matched byte for byte. It keeps active false. The [publication record](P08B13-METADATA-PUBLICATION.md) includes the URI and updating procedure. The [approval worksheet](P08B13-REGISTRATION-APPROVAL.md) contains the exact unsigned tagged calldata, read-only simulation, current-at-check fee caps and a proposed maximum budget of 0.058843604764 CELO.

## Verification

Strict TypeScript checking passed. The issued-tag run passed all 54 regression tests, with zero failures and no skips. All seven isolated Chromium tests passed. The new tests verify the exact oracle target, successful zero and nonzero L1 fee reads, rollup reserve enforcement, RPC failure propagation and refusal of nonzero operator parameters. The corrected helper also ran against public Forno on an unsigned USDt decimals call. Gas was 30,951, estimated total fee 0.0062675775 CELO and rollup fee 0 CELO at that instant. This is a fee-helper probe, not an estimate for the approval transaction.

P08B.14 queried both hashes directly. The original receipt row gave the containing block hash without labeling it as such. It is not a second funding transaction. See [final review](P08B14-REGISTRATION-FINAL-REVIEW.md).
