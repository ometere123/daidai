# Daidai P08B.19 MetaMask startup diagnostic

## Finding

The P08B.18 screenshot shows that startup failed before transaction dispatch. Its status was rendered by a catch block that hid whether browser provider detection, authenticated bootstrap, or another exception failed. The screenshot includes the extension panel, which does not establish which EIP-1193 provider Chrome injected into the page. The historical root cause remains unverified.

## Changes

- The startup flow selects a unique MetaMask EIP-6963 announcement and rejects ambiguity. It falls back to a single compatible injected MetaMask provider when no announcement is available. It exposes specific, credential-free provider, authorization rejection, expiry and exception codes.
- Bootstrap still uses same-origin loopback checks, a one-use bearer credential and constant-time comparison. Expired credentials and invalid or consumed credentials have distinct responses.
- The separate diagnostic page exercises authenticated localhost bootstrap and reports the result of the old provider gate for comparison. Its browser path uses only `eth_accounts` and `eth_chainId`, using permissions already granted to the same origin. It does not expose the registration bridge or load financial or signing handlers.

## Verification and remaining gate

Strict TypeScript passed. The root regression suite passed 54/54. Isolated Chromium passed 28/28, including 12 new cases for provider absence and ambiguity, missing wallet capabilities, rejected or expired bootstrap, replay and success. A localhost smoke check returned HTTP 200. The permanent registration ledger contained zero rows. No registration workflow was armed and no signing or transaction method was requested or broadcast.

The normal Chrome/MetaMask run is pending the operator's explicit permission. Start `npm run wallet:diagnostic` in this branch, then have the operator open `http://127.0.0.1:51529` and click **Run read-only check**. Capture the user-visible public account/chain result and legacy-provider result without recording bootstrap credentials. Success requires the enrolled public account and chain 42220. If current evidence cannot reproduce the historical failure, retain that qualification. Any future registration session needs separate authorization.
