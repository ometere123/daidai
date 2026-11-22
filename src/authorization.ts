import { recoverTypedDataAddress, type Hex } from 'viem';
import type { Invoice } from './invoice.ts';

type Role = 'invoice approval' | 'recipient consent';
export type SignedAuthorization = { approval: Hex; consent: Hex };
const certificates = new WeakSet<object>();
export type VerifiedAuthorization = Readonly<{ digest: string; approver: string; recipient: string; expires: number }>;
export function isVerifiedAuthorization(proof: VerifiedAuthorization) { return certificates.has(proof); }

export function authorizationMessage(invoice: Invoice, digest: string, role: Role, origin: string) {
  return {
    domain: { name: 'Daidai invoice authorization', version: '1', chainId: invoice.chain },
    types: { Authorization: [
      { name: 'invoiceDigest', type: 'bytes32' }, { name: 'purpose', type: 'string' },
      { name: 'audience', type: 'string' }, { name: 'expiresAtMs', type: 'uint256' },
    ] },
    primaryType: 'Authorization',
    message: { invoiceDigest: `0x${digest}`, purpose: role, audience: origin, expiresAtMs: BigInt(invoice.expires) },
  } as const;
}

export async function verifyAuthorization(invoice: Invoice, digest: string, origin: string, proof: SignedAuthorization, now: number) {
  if (!Number.isSafeInteger(now) || now >= invoice.expires || !/^[a-f0-9]{64}$/.test(digest) ||
    new URL(origin).origin !== origin || invoice.approver === invoice.recipient) throw Error('invalid authorization scope');
  const [approver, recipient] = await Promise.all([
    recoverTypedDataAddress({ ...authorizationMessage(invoice, digest, 'invoice approval', origin), signature: proof.approval }),
    recoverTypedDataAddress({ ...authorizationMessage(invoice, digest, 'recipient consent', origin), signature: proof.consent }),
  ]);
  if (approver.toLowerCase() !== invoice.approver || recipient.toLowerCase() !== invoice.recipient) throw Error('invalid approval or consent signature');
  const result = Object.freeze({ digest, approver: invoice.approver, recipient: invoice.recipient, expires: invoice.expires });
  certificates.add(result);
  return result;
}
