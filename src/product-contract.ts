import { address, atomic } from './invoice-core.ts';

export const productPath = '/v1/product';
export const productId = /^[0-9a-f]{32}$/;
export const shareCode = /^[A-Za-z0-9_-]{43}$/;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const matches = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);

export type Draft = { recipient: string; approver: string; target: string; cap: string; expiry: number };
export type Revision = Draft & { id: string; revision: number; state: 'draft' | 'committed' | 'cancelled'; digest: string | null; at: number };

export function parseDraft(value: unknown): Draft | null {
  const v = obj(value);
  if (!integer(v.expiry) || !matches(v.target, /^[0-9]{1,78}$/) || !matches(v.cap, /^[0-9]{1,78}$/) ||
      typeof v.recipient !== 'string' || typeof v.approver !== 'string') return null;
  try {
    if (atomic(v.target) === 0n || atomic(v.cap) === 0n) return null;
    return { target: v.target, cap: v.cap, expiry: v.expiry, recipient: address(v.recipient), approver: address(v.approver) };
  } catch { return null; }
}
export function parseRevision(value: unknown): Revision | null {
  const v = obj(value), draft = parseDraft(v);
  if (!draft || !matches(v.id, productId) || !integer(v.revision) || !integer(v.at) || v.revision < 1) return null;
  if (v.state !== 'draft' && v.state !== 'committed' && v.state !== 'cancelled') return null;
  if (v.digest !== null && !matches(v.digest, /^[0-9a-f]{64}$/)) return null;
  if (v.state === 'draft' && v.digest !== null || v.state === 'committed' && v.digest === null) return null;
  return { ...draft, id: v.id, revision: v.revision, state: v.state, digest: v.digest, at: v.at };
}
export type ProductRequest =
  | { kind: 'list' }
  | { kind: 'redeem'; code: string }
  | { kind: 'detail'; id: string }
  | { kind: 'revoke'; id: string }
  | { kind: 'share'; id: string; code: string }
  | { kind: 'save'; id: string; key: string; expected: number; draft: Draft }
  | { kind: 'commit' | 'cancel'; id: string; key: string; expected: number };

export function parseProduct(value: unknown): ProductRequest | null {
  const v = obj(value);
  if (v.version !== 'p11.v1') return null;
  if (v.kind === 'list') return { kind: 'list' } as const;
  if (v.kind === 'redeem') return matches(v.code, shareCode) ? { kind: v.kind, code: v.code } as const : null;
  if (!matches(v.id, productId)) return null;
  const id = v.id;
  if (v.kind === 'detail' || v.kind === 'revoke') return { kind: v.kind, id } as const;
  if (v.kind === 'share') return matches(v.code, shareCode) ? { kind: v.kind, id, code: v.code } as const : null;
  if ((v.kind !== 'save' && v.kind !== 'commit' && v.kind !== 'cancel') || !matches(v.key, productId) || !integer(v.expected) || v.expected >= 99) return null;
  if (v.kind !== 'save') return v.expected > 0 ? { kind: v.kind, id, key: v.key, expected: v.expected } as const : null;
  const draft = parseDraft(v.draft);
  return draft ? { kind: v.kind, id, key: v.key, expected: v.expected, draft } as const : null;
}
export function parseProductReply(value: unknown) {
  const v = obj(value);
  if (v.version !== 'p11.v1' || !['list','history','revision','shared','revoked','denied','invalid','conflict','unavailable'].includes(String(v.kind))) return null;
  const kind = v.kind as 'list'|'history'|'revision'|'shared'|'revoked'|'denied'|'invalid'|'conflict'|'unavailable';
  if (!Array.isArray(v.revisions) || v.revisions.length > 100 || typeof v.merchant !== 'boolean') return null;
  const revisions = v.revisions.map(parseRevision);
  if (!revisions.every((r): r is Revision => r !== null)) return null;
  if (['list','history','revision'].includes(kind) ? kind === 'revision' && revisions.length !== 1 : revisions.length !== 0) return null;
  return { kind, revisions, merchant: v.merchant };
}
