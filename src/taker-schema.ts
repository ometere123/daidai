export const proofWindowMs = 45_000;
export type TakerChallenge = { taker: string; nonce: `0x${string}`; issuedAt: number };

export function takerTypedData({ taker, nonce, issuedAt }: TakerChallenge) {
  return {
    domain: { name: 'Textile Taker Control', version: '1', chainId: 42220 },
    types: { TakerControl: [
      { name: 'taker', type: 'address' }, { name: 'chainId', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' },
    ] },
    primaryType: 'TakerControl',
    message: { taker: taker as `0x${string}`, chainId: 42220n, nonce, issuedAt: BigInt(issuedAt) },
  } as const;
}

export function checkTakerChallenge(challenge: TakerChallenge, sender: string, now: number) {
  if (challenge.taker !== sender || !/^0x[0-9a-f]{40}$/.test(sender) || /^0x0+$/.test(sender) ||
    !/^0x[0-9a-f]{64}$/.test(challenge.nonce) || !Number.isSafeInteger(challenge.issuedAt) ||
    challenge.issuedAt > now || now - challenge.issuedAt >= proofWindowMs) throw Error('invalid or stale Textile challenge');
}

export function takerWalletRequest(challenge: TakerChallenge) {
  const typedData = takerTypedData(challenge);
  const payload = { ...typedData, types: { EIP712Domain: [
    { name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' },
  ], ...typedData.types } };
  return { method: 'eth_signTypedData_v4', params: [challenge.taker,
    JSON.stringify(payload, (_, value) => typeof value === 'bigint' ? value.toString() : value)] };
}
