# Daidai P08B.21 startup and RPC readiness

## Localhost bootstrap

**PASS in isolated tests and the DAIDAI Chrome profile.** The historical `BOOTSTRAP_REJECTED` cannot be assigned a single cause. The old HTTP response grouped credential and origin failures. On the old path a bare localhost URL or reload after JavaScript stripped the fragment loses the credential. A second tab with the same full link can also encounter an already consumed credential. Isolated Chromium reproduced the bare-address and reload cases. The available screenshot cannot establish which branch fired in the original session.

The registration and no-spend hosts now share the one-use fragment read, browser POST and server verification. Missing, malformed, incorrect, consumed, expired and Host/Origin mismatch have distinct codes. Correctly formatted credentials are compared in constant time before consumption and only a valid unexpired credential from the pinned origin can start a session. Neither host prints a full URL. The Windows operator commands pass it to the local clipboard through stdin. The diagnostic host cannot construct or dispatch a registration.

## MetaMask Celo RPC

**PASS in the DAIDAI Chrome profile.** The separate no-spend test checks the pinned account and chain 42220, reads a recent header and the balance at that block, and rechecks the wallet context. The page cannot identify or expose the wallet's private endpoint URL. The operator can verify the selected network and endpoint label inside MetaMask without sharing credentials.

The private Alchemy reader and public Celo Forno both returned chain 42220 and a native balance of 32.720588235294117647 CELO. The latest blocks were 83,474,153 on Alchemy and 83,474,151 on Forno, respectively. Their timestamps were 7 and 5 seconds ahead of the local clock, within the diagnostic's 10-second forward tolerance. If the wallet endpoint fails, the operator may manually choose `https://forno.celo.org` and repeat the Chrome check. Endpoint changes require operator interaction. [Celo Forno documentation](https://docs.celo.org/build/tools/nodes/forno) · [MetaMask connection troubleshooting](https://support.metamask.io/configure/troubleshooting/metamask-is-unable-to-connect-to-the-blockchain-host)

## Verification and gate

Strict TypeScript, 54/54 backend regressions and 32/32 isolated Chromium tests passed. CLI JavaScript syntax checks passed. The permanent ledger has zero attempts. No signing or transaction method ran against a real wallet, and no registration session was armed. The no-spend bootstrap and RPC prerequisites passed. Registration requires separate authorization.

## DAIDAI Chrome verification

The authorized diagnostic authenticated using the shared one-use fragment bootstrap. MetaMask returned the enrolled account and chain 42220, and the legacy provider check passed. A prior tab showed BOOTSTRAP_MISSING. This confirms a missing-fragment failure on that tab, while the exact cause of the historical generic rejection remains unresolved.

MetaMask reported block 83,477,127, age −7 seconds within tolerance, hash `0x631e11fd59066b0328116db3d42544692382e3662d919e62456e99297a142b3b`, and 32.720588235294117647 CELO. The independent Alchemy reader returned the same block hash and account balance at that exact height. No endpoint setting changed. The diagnostic server was closed and the registration ledger still contained zero attempts. No signing or transaction method was invoked.
