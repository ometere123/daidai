# Daidai P08B.19 MetaMask startup diagnostic

## Finding

The P08B.18 screenshot shows that startup failed before transaction dispatch. Its status was rendered by a catch block that hid whether browser provider detection, authenticated bootstrap, or another exception failed. The screenshot includes the extension panel, which does not establish which EIP-1193 provider Chrome injected into the page. The historical root cause remains unverified.

## Changes

- The startup flow selects a unique MetaMask EIP-6963 announcement and rejects ambiguity. It falls back to a single compatible injected MetaMask provider when no announcement is available. It exposes specific, credential-free provider, authorization rejection, expiry and exception codes.
- Bootstrap still uses same-origin loopback checks, a one-use bearer credential and constant-time comparison. Expired credentials and invalid or consumed credentials have distinct responses.
- The separate diagnostic page exercises authenticated localhost bootstrap and reports the result of the old provider gate for comparison. Its browser path uses only `eth_accounts` and `eth_chainId`, using permissions already granted to the same origin. It does not expose the registration bridge or load financial or signing handlers.

## Verification and remaining gate

Strict TypeScript passed. The root regression suite passed 54/54. Isolated Chromium passed 28/28, including 12 new cases for provider absence and ambiguity, missing wallet capabilities, rejected or expired bootstrap, replay and success. A localhost smoke check returned HTTP 200. The permanent registration ledger contained zero rows. No registration workflow was armed and no signing or transaction method was requested or broadcast.

The operator authorized and ran the separate diagnostic in their normal Chrome profile on 22 November 2026. The supplied screenshot showed PASS for MetaMask detection, authenticated localhost bootstrap, and the pinned public account `0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e` on Celo Mainnet (42220). The legacy P08B.18 provider gate also reported PASS in this session. The original P08B.18 startup failure was not reproduced, so its cause remains unverified. The diagnostic bootstrap used a separate credential from the historical registration session.

The diagnostic listener was closed and the permanent registration ledger still had zero rows. No transaction or signature was requested or broadcast. A future registration session requires separate authorization.
