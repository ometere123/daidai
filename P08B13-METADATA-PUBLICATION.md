# Daidai | P08B.13 metadata publication

**Published to public IPFS on Pinata Free ($0/month).** The operator approved the exact source file, hosting provider and cost. No paid plan was activated.

- Source: [DAIDAI-ERC8004-METADATA.json](DAIDAI-ERC8004-METADATA.json), unchanged, including the final newline. It contains 516 bytes and keeps active false.
- SHA-256: 157bf72f79324331a1d676d8b9c69aa2468101845379acf7b44520fe9d5398a2.
- CID: bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui.
- URI: ipfs://bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui.
- Managed pin: Pinata returned the CID from the public upload, and its authenticated Public Files lookup independently listed the same CID and 516-byte size. Keep the file pinned and the Free account in good standing.
- Independent retrieval: Filebase returned the exact 516 bytes at 12:41 WAT on 22 November 2026. A byte-for-byte comparison and SHA-256 both matched. The Pinata gateway also matched. Initial ipfs.io and dweb.link requests returned HTTP 429. No duplicate upload was made. [Independent Filebase retrieval](https://ipfs.filebase.io/ipfs/bafkreiavpp3s66jsimy2dvtw3c44ngvci2aqdbctpgwppncfed7j2u4yui)

The official Loops event skill states that its checklist checks the ERC-8004 identity from the enrolled wallet. It does not specify the effect of active false on verification or discoverability. Both behaviors remain **UNKNOWN**. Active remains false while the prototype is pre-release. [Official Loops skill](https://www.loops.house/api/v1/events/agents-open-for-business/skill)

After a separately approved registration is finalized, take the actual agent ID from the Registered event. Verify owner and agent wallet, then add a registrations entry containing that ID and agentRegistry eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 to a new metadata revision. Re-review its claims and active flag, get publication approval, pin the new bytes and independently verify the new CID. If the onchain pointer should refer to that revision, a separate owner-authorized setAgentURI transaction is required. Keep the original CID pinned while it remains the adopted URI or is needed for evidence. [ERC-8004 specification](https://eips.ethereum.org/EIPS/eip-8004#agent-uri-and-agent-registration-file) · [Celo registration guide](https://docs.celo.org/build/agents/8004)
