# Daidai | P08B.8 localhost integration and read-only report

**Wallet enrollment and live settlement remain NO-GO.** This slice adds the localhost host, role-specific review artifacts, and mock signing and transaction tests. There is no application UI or remote deployment. The minimal local page only bootstraps and reviews allowlisted wallet jobs. No real wallet, signature, firm RFQ or transaction was used.

## Textile proof and approval workflow

1. Prepare the exact-output request with the pinned taker and committed buyAmount. In a separately authorized future integration, try that HTTP request without takerProof first. Only a Textile 401 with details.reason proof_of_control_required should invoke the proof preparation path. There is no firm-request HTTP client in this change.
2. The Node proof helper generates a fresh 32-byte random nonce, pins Celo 42220, and creates the official Textile Taker Control version 1 EIP-712 payload. The type is TakerControl with taker/address, chainId/uint256, nonce/bytes32 and issuedAt/uint256 in that order. issuedAt is Unix milliseconds. The isolated browser session reconstructs the exact payload before asking for human review. Node recovers the EOA and checks the invoice did not change. JSON-RPC signing uses eth_signTypedData_v4. The generic broker denies all signing methods.
3. The generated takerProof has nonce, issuedAt and signature. Daidai uses a 45-second local window to leave clock/network margin against Textile's 60-second bound. Keep each proof in memory. Do not log, persist, forward to another caller or cache it as a session credential. Textile permits identical proof retry by the original caller while fresh, rejects rebinding or passing it to another caller, and typically grants roughly 12 hours for that same caller, wallet and chain. Daidai does not track the venue grant or auto-replay proof or firm requests after timeout. A local job cannot be redelivered or completed twice.
4. For invoice approval and recipient consent, prepare one review packet per role from the stored draft. The operator separately delivers only the appropriate packet over an authenticated channel already controlled by that party. A trusted reviewed signer must display or recompute the invoice digest against the canonical invoice and show amount, spend cap, recipient, chain, expiry and role before the party chooses to sign. Return only each role's signature through that channel. Node verifies both against the stored draft, distinct committed EOAs, role, audience and expiry before authorizing. Do not share the wallet bridge bootstrap URL or bearer with either external signer. Preview and the USDT allowance are separate from these signatures. There is no remote signer portal. Actual signature collection and any address-permission prompt require user authorization.

[Textile authentication](https://docs.textilecredit.com/api/v2/authentication.html) · [RFQ v2](https://docs.textilecredit.com/api/v2/rfq.html)

## Localhost host and timeline

The Node host binds a random port on IPv4 loopback and checks the exact Host and POST Origin. It serves only the bootstrap shell and allowlisted same-origin scripts with CSP, frame denial, no-store and no-referrer. An operator-held, one-time bootstrap secret travels in the browser URL fragment and is exchanged for a separate random, in-memory session bearer. The handler rejects foreign origins, replay, wrong credentials, oversized job responses and unknown paths. Browser code reviews a copy and hands the exact original request to the injected provider only after checking account, chain and job expiry. Node verifies signatures and already requires independent RPC settlement proof for hash outcomes. Closing the host invalidates outstanding jobs. Treat localhost browser, Node process and same-origin code as trusted. Keep credentials out of shell history, screenshots and logs.

The test suite runs a real localhost HTTP listener and supplies a mock provider to the browser module. It does not run the served page in a real browser or exercise extension compatibility. Tested timing includes a 19-second remaining mock quote that never opens a prompt, an on-time mock wallet request whose reviewed copy is modified without affecting the sent bytes, a 25-second review delay against a 20-second job that never sends, and the existing timeout regression that blocks replay. The adapter demands more than 20 seconds of quote headroom before and after simulation and reserves the last 5 seconds before expiry from browser dispatch. These are local stop thresholds, not inclusion guarantees. Complete authorization, any confirmed bounded allowance, and proof before relying on the firm quote window. An extension prompt already open at the local timeout may still broadcast. Treat it as ambiguous and reconcile.

## Forno capability probe

Probed https://forno.celo.org on 22 November 2026 around 06:02 WAT, using public read-only JSON-RPC. The eth_simulateV1 request contained only a USDt decimals call.

| Probe | Observed result |
|---|---|
| eth_chainId | HTTP 200, Celo 42220 |
| eth_getBlockByNumber finalized and numbered canonical lookup | HTTP 200. Block 0x4f8e96b matched hash 0x2f4af68a1d6bc51b2d0a87d09ad948666ecc6857fedc6f257af45e182e286820 |
| eth_getTransactionByHash and eth_getTransactionReceipt | Both returned the historical system transaction and a normal Celo type-0x7b sample. The latter, 0xf7fca803fcc8e130eaad3ef74720a4fc27811633eff51dc5ab594104820a3375, returned chain 0xa4ec, matching block hashes, successful status and seven logs. The system deposit lacked a transaction chainId. The adapter still requires chainId |
| eth_simulateV1 | HTTP 403, JSON-RPC -32601, method not whitelisted |
| debug_traceCall and eth_getRawTransactionByHash | JSON-RPC -32601, methods not whitelisted |

Forno can supply the observed read data but cannot complete Daidai's required exact-swap simulation. Use a vetted Celo endpoint or a privately operated Celo node that supports eth_simulateV1 with transfer logs, finalized canonical reads and fee estimation. An independently reviewed pinned-block fork or trace-to-transfer adapter could provide equivalent simulation evidence in a separate change. A plain eth_call, gas estimate or preview cannot replace transfer evidence. No alternative provider was qualified in this task and no guard was weakened. [Celo Forno](https://docs.celo.org/build/tools/nodes/forno)

## Manual recovery with no returned hash

1. Stop conversion and payout retries for that invoice. Preserve the SQLite record, original call, sender, chain, nonce, fee bounds and timestamps. A local timer does not cancel an extension prompt. Do not click it again.
2. The wallet owner checks the original prompt and account history on the pinned chain. Use an independent provider or explorer to search the sender and exact persisted nonce. A reported hash is a lead. Inspect all known replacements and distinguish pending, replaced, reverted and finalized outcomes. Absence from one explorer or Textile status is insufficient.
3. Before treating funds as settled, require a canonical finalized successful receipt with the same sender, nonce, target, native value and complete tagged calldata. Check exact USDt and cNGN transfers and compare to the committed invoice. A replacement with different calldata or a canonical failure requires a fresh human decision. This implementation deliberately has no attach-hash or clear/retry operation. Escalate independently corroborated evidence for controlled recovery and leave the invoice locked until an authorized audited recovery path exists.

Run npm ci --ignore-scripts --no-audit --no-fund, npm run typecheck and npm test with Node 22.23.3. Use a populated cache for offline installation. Tests require no public network and use localhost only for the host integration cases.

Final result with the issued attribution tag was 53/53 passing, zero failures and no skips. Strict TypeScript checking passed.
