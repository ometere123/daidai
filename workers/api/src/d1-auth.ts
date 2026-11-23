/**
 * P10.5 authentication state on D1: invitation exchange, session lifecycle and the global service-nonce store.
 * Writes ONLY to viewer_invitations, viewer_sessions and service_nonces. Never to invoices, signatures or lineage.
 *
 * Every state change is a single conditional statement (or one atomic db.batch), so concurrent requests on any isolate
 * resolve on D1's single primary: an invitation is consumed at most once, a revoked session stays revoked, and a nonce is
 * accepted at most once per key id. Raw invitation codes and session tokens are never stored or logged, only SHA-256.
 */
import { MAX_SKEW_MS, sha256Hex } from '../../../src/service-auth.ts';
import type { ViewerAuthenticator } from '../../../src/viewer-access.ts';
import type { D1Like, D1Result } from './d1-schema.ts';

export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
export const SESSION_IDLE_MS = 30 * 60_000;
export const INVITATION_TTL_MS = 15 * 60_000;
/** Nonce rows older than this are pruned. Strictly more than the 2 x skew window any replay could still use. */
export const NONCE_RETENTION_MS = 2 * MAX_SKEW_MS + 60_000;

const hashPattern = /^[a-f0-9]{64}$/;
const changes = (r: D1Result | undefined) => Number((r?.meta as { changes?: unknown } | undefined)?.changes ?? 0);

/** A fresh 256-bit opaque secret, base64url (43 chars). Used for session tokens and invitation codes. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type NonceClaim = 'claimed' | 'replayed' | 'unavailable';

/**
 * Claims (key id, nonce) globally. Call only AFTER the HMAC verified. A primary-key conflict is a replay; any other error
 * is 'unavailable' (the caller fails closed with 503, never accepts).
 */
export async function claimNonce(db: D1Like, keyId: string, nonce: string, nowMs: number): Promise<NonceClaim> {
  try {
    const result = await db.prepare('INSERT INTO service_nonces (key_id, nonce, seen_at_ms) VALUES (?, ?, ?)').bind(keyId, nonce, nowMs).run();
    return result.success && changes(result) === 1 ? 'claimed' : 'unavailable';
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return /UNIQUE constraint failed: service_nonces|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(msg) ? 'replayed' : 'unavailable';
  }
}

/** Deletes nonce rows older than NONCE_RETENTION_MS. Never touches rows a replay inside the skew window could match. */
export async function pruneNonces(db: D1Like, nowMs: number): Promise<void> {
  await db.prepare('DELETE FROM service_nonces WHERE seen_at_ms < ?').bind(nowMs - NONCE_RETENTION_MS).run();
}

export type IssuedSession = Readonly<{ token: string; expiresAtMs: number; idleTimeoutMs: number }>;

/**
 * Atomically consumes an unused, unexpired invitation and creates a session for its (tenant, viewer). Returns null for an
 * unknown, used or expired invitation (callers answer with one uniform 'invalid-credentials'). D1 errors propagate.
 */
export async function exchangeInvitation(db: D1Like, code: string, nowMs: number, previousToken = ''): Promise<IssuedSession | null> {
  const codeHash = await sha256Hex(code);
  const priorHash = /^[A-Za-z0-9_-]{32,256}$/.test(previousToken) ? await sha256Hex(previousToken) : null;
  const token = randomSecret();
  const tokenHash = await sha256Hex(token);
  const expiresAtMs = nowMs + SESSION_ABSOLUTE_MS;
  const idle = Math.min(nowMs + SESSION_IDLE_MS, expiresAtMs);
  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(`UPDATE viewer_invitations SET used_at_ms = ?, session_sha256 = ?
        WHERE code_sha256 = ? AND used_at_ms IS NULL AND session_sha256 IS NULL AND expires_at_ms > ?`).bind(nowMs, tokenHash, codeHash, nowMs),
      // Only the request that won the conditional update binds its own token hash, so only it inserts a session.
      db.prepare(`INSERT INTO viewer_sessions (token_sha256, viewer_id, tenant_id, authenticated_at_ms, expires_at_ms, idle_expires_at_ms,
          revoked_at_ms, created_from, rotated_from)
        SELECT ?, viewer_id, tenant_id, ?, ?, ?, NULL, code_sha256, (SELECT token_sha256 FROM viewer_sessions WHERE token_sha256 = ? AND revoked_at_ms IS NULL) FROM viewer_invitations WHERE code_sha256 = ? AND session_sha256 = ?`)
        .bind(tokenHash, nowMs, expiresAtMs, idle, priorHash, codeHash, tokenHash),
      db.prepare(`UPDATE viewer_sessions SET revoked_at_ms = ? WHERE token_sha256 = ? AND revoked_at_ms IS NULL
        AND EXISTS (SELECT 1 FROM viewer_sessions AS replacement WHERE replacement.token_sha256 = ?
          AND replacement.rotated_from = viewer_sessions.token_sha256)`).bind(nowMs, priorHash, tokenHash),
    ]);
  } catch (e) {
    // A losing concurrent exchange can hit the single-use trigger: that is a used invitation, not an outage.
    if (/invitation already used/.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
  if (results.length !== 3 || results.some(result => !result.success)) throw Error('session exchange unavailable');
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) return null;
  return Object.freeze({ token, expiresAtMs, idleTimeoutMs: SESSION_IDLE_MS });
}

type SessionRow = Readonly<{ viewerId: string; tenantId: string; authenticatedAtMs: number; expiresAtMs: number }>;

/**
 * Validates a session by token hash and slides its idle expiry, in one conditional UPDATE ... RETURNING. Rejects revoked,
 * absolutely expired and idle-expired sessions. Writes only idle_expires_at_ms (never beyond expires_at_ms).
 */
export async function touchSession(db: D1Like, tokenHash: string, nowMs: number): Promise<SessionRow | null> {
  if (!hashPattern.test(tokenHash) || !Number.isSafeInteger(nowMs)) return null;
  const r = await db.prepare(`UPDATE viewer_sessions SET idle_expires_at_ms = MIN(? + ${SESSION_IDLE_MS}, expires_at_ms)
    WHERE token_sha256 = ? AND revoked_at_ms IS NULL AND expires_at_ms > ? AND authenticated_at_ms <= ?
      AND COALESCE(idle_expires_at_ms, MIN(authenticated_at_ms + ${SESSION_IDLE_MS}, expires_at_ms)) > ?
    RETURNING viewer_id, tenant_id, authenticated_at_ms, expires_at_ms`).bind(nowMs, tokenHash, nowMs, nowMs, nowMs).first<Record<string, unknown>>();
  if (!r) return null;
  const { viewer_id, tenant_id, authenticated_at_ms, expires_at_ms } = r;
  if (typeof viewer_id !== 'string' || typeof tenant_id !== 'string' || typeof authenticated_at_ms !== 'number' || typeof expires_at_ms !== 'number') return null;
  return Object.freeze({ viewerId: viewer_id, tenantId: tenant_id, authenticatedAtMs: authenticated_at_ms, expiresAtMs: expires_at_ms });
}

/** A ViewerAuthenticator for src/viewer-access.ts authenticateViewer (which validates and brands the result). */
export function d1SessionAuthenticator(db: D1Like): ViewerAuthenticator {
  return { async verify(credential, nowMs) { return touchSession(db, await sha256Hex(credential), nowMs); } };
}

/** Revokes the session for a token. Idempotent; an unknown token is a no-op (the caller always answers 'revoked'). */
export async function revokeSession(db: D1Like, token: string, nowMs: number): Promise<void> {
  const result = await db.prepare('UPDATE viewer_sessions SET revoked_at_ms = ? WHERE token_sha256 = ? AND revoked_at_ms IS NULL')
    .bind(nowMs, await sha256Hex(token)).run();
  if (!result.success) throw Error('session revocation unavailable');
}

/** Operator revoke: every live session of a viewer in a tenant. Returns the number of sessions revoked. */
export async function revokeViewerSessions(db: D1Like, tenantId: string, viewerId: string, nowMs: number): Promise<number> {
  return changes(await db.prepare('UPDATE viewer_sessions SET revoked_at_ms = ? WHERE tenant_id = ? AND viewer_id = ? AND revoked_at_ms IS NULL')
    .bind(nowMs, tenantId, viewerId).run());
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Operator: creates an invitation and returns the raw code (shown once; only its hash is stored). */
export async function createInvitation(db: D1Like, o: { tenantId: string; viewerId: string; nowMs: number; ttlMs?: number }): Promise<{ code: string; expiresAtMs: number }> {
  if (!idPattern.test(o.tenantId) || !idPattern.test(o.viewerId)) throw Error('invalid tenant or viewer id');
  const ttl = o.ttlMs ?? INVITATION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 7 * 24 * 3600_000) throw Error('invalid invitation ttl');
  const code = randomSecret();
  const expiresAtMs = o.nowMs + ttl;
  await db.prepare('INSERT INTO viewer_invitations (code_sha256, tenant_id, viewer_id, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(code), o.tenantId, o.viewerId, o.nowMs, expiresAtMs).run();
  return { code, expiresAtMs };
}
