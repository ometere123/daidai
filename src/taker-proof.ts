import { randomBytes } from 'node:crypto';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { checkTakerChallenge, proofWindowMs, takerTypedData, type TakerChallenge } from './taker-schema.ts';

export type TakerProof = Readonly<{ nonce: Hex; issuedAt: number; signature: Hex }>;

export async function proveTextileTaker(sender: string, sign: (challenge: TakerChallenge, expires: number) => Promise<unknown>,
  clock = Date.now): Promise<TakerProof> {
  const challenge = Object.freeze({ taker: sender, nonce: `0x${randomBytes(32).toString('hex')}` as Hex, issuedAt: clock() });
  checkTakerChallenge(challenge, sender, clock());
  const raw = await sign(challenge, challenge.issuedAt + proofWindowMs);
  checkTakerChallenge(challenge, sender, clock());
  if (typeof raw !== 'string' || !/^0x[0-9a-f]{130}$/i.test(raw)) throw Error('malformed Textile signature');
  const signature = raw as Hex;
  if ((await recoverTypedDataAddress({ ...takerTypedData(challenge), signature })).toLowerCase() !== sender) {
    throw Error('Textile proof signer mismatch');
  }
  checkTakerChallenge(challenge, sender, clock());
  return Object.freeze({ nonce: challenge.nonce, issuedAt: challenge.issuedAt, signature });
}
