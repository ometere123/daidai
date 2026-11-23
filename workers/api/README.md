# Daidai read-only API Worker (P10.4 + P10.5 sessions, local prototype)

A Cloudflare Worker that serves the P10.3 authoritative invoice projection over Cloudflare D1. It is **read-only,
non-spending and local-only**: it runs in Miniflare/workerd on this machine and is not deployed anywhere.

## Architecture

```
Vercel server (HMAC-signed GET, viewer token in x-daidai-viewer)
  └─▶ src/index.ts      binds env (D1, secrets) + module-scope nonce window and rate limiter
       └─▶ src/handler.ts
            1. Origin header present (a browser)        → 401 unauthenticated-service; never any CORS header
            2. parseRequest (src/api-contract.ts)        → 405 method-not-allowed / 400 invalid-request
            3. verifyRequest HMAC (src/service-auth.ts)  → 401 unauthenticated-service (health too)
            4. token bucket per key id (per isolate)      → 429 rate-limited
            5. authenticateViewerToken → invoiceViewerAuthorizer (permission + tenant directory) → invoice read
               → readAuthoritativeInvoice (P10.3 projector) with projectionSources over D1 repositories
               anything that is not a projection          → 404 not-found-or-forbidden (uniform, no existence oracle)
            6. parseResponse on every outgoing body, responseHeaders (no-store, private, nosniff, DENY, CSP)
            exceptions                                     → 503 unavailable, no message
  src/d1-repositories.ts   D1 implementations of InvoiceRepository, SignatureRepository, ViewerSessionRepository,
                           PermissionRepository, AttemptRepository (SELECT only; attempt rows attested like
                           AttemptLineageReader, history included)
  src/d1-schema.ts         idempotent schema: read tables + the shared LINEAGE_SCHEMA_STATEMENTS
  src/d1-lineage.ts        PROTOTYPE D1 lineage writer for tests (never imported by the Worker)
```

Decisions:
- **`/v1/health` requires service authentication.** An unauthenticated health check would let anyone probe whether the
  service and its key configuration exist; the Vercel server can sign health checks as easily as reads.
- **No chain reader is configured.** `projectionSources` gets no `chain`, so transaction and canonical-block observations
  are always null: operations stay `unverified`/`unknown`/`reconciliation-required` and `settlement` is never `settled`.
  There is no fixture chain in the Worker.
- **One request time.** The projector rejects observations stamped after `opts.nowMs`, so the composition clock returns
  the same `nowMs` for the whole request. (A live `Date.now()` clock makes every observation a few ms "in the future"
  and every read fail closed; this was observed and is covered by a test.)
- A malformed viewer token is reported as 404 only *after* service authentication succeeds, so an unauthenticated
  caller always sees 401.
- A D1 failure during the session lookup is swallowed by `authenticateViewer()` and becomes the uniform 404 (fail closed
  as a denial); a failure elsewhere becomes 503.
- Logs: one JSON line per request with `rid` (8 hex chars), `route`, `status` and (after authentication) `keyId`.
  Never tokens, signatures, nonces, bodies or invoice data (tested).

## Run locally

Requires Node 22 (uses `--experimental-strip-types` and `node:sqlite` for the parity test). From `workers/api`:

```sh
npm ci                 # also run `npm ci` at the repo root: shared src/ resolves viem from the root first
npm run typecheck
npm test               # builds dist/worker.js with esbuild, then runs test/*.test.ts against Miniflare in-process
npm run seed           # wipes and seeds .wrangler/local-d1; writes .dev.vars and .wrangler/demo-identities.json (gitignored)
npm run dev            # serves the seeded Worker on 127.0.0.1:8787 (prints only the port)
```

The local prototype uses Miniflare. The optional Wrangler CLI is not installed by this package. **Never run
`wrangler deploy`, `wrangler login` or any `--remote` command from this package.**

Seeded identities (`npm run seed`): tenant-a `demo-viewer` may read `inv-a1` (no attempts), `inv-a2` (hashless,
outcome-unknown payout) and `inv-a3` (legacy unresolved payout); `inv-a4` exists without a permission; tenant-b `viewer-b`
owns `inv-b1`. Invoices use real `commit()` digests and real EIP-712 approval/consent signatures from throwaway keys
generated at seed time (`viem generatePrivateKey`). Sessions expire 8 hours after seeding.

## Environment and secrets

| Name | Kind | Where |
| --- | --- | --- |
| `DB` | D1 binding | `wrangler.toml` (`daidai-local`, placeholder id `00000000-…`: LOCAL ONLY, not provisioned) |
| `DAIDAI_AUDIENCE` | var (non-secret) | `wrangler.toml`; the EIP-712 audience origin stored signatures were made for |
| `DAIDAI_CHAIN_RPC_URL` | var, **unset by default** | P10.5 optional read-only chain reader (`src/chain-config.ts` → `src/celo-rpc.ts`). Only `https://…` (or `http://127.0.0.1[:port]` for tests); anything else leaves the hook off. A production endpoint needs owner approval |
| `DAIDAI_ATTRIBUTION_CODE` | var | Required together with `DAIDAI_CHAIN_RPC_URL`; without it the chain hook stays off |
| `DAIDAI_SERVICE_KEYS` | **secret** | JSON `{"<keyId>": "<secret ≥ 32 chars>"}`. Locally `.dev.vars` (gitignored, written by the seed script). Remotely it would be `wrangler secret put` (not done in P10.4). Never committed. Missing or malformed → every request 503 |

`wrangler.toml` has `workers_dev = false`, no routes and no custom domain.

## D1 vs node:sqlite (A5–A8)

All findings below are from tests against local D1 in workerd (Miniflare), not assumed from node:sqlite.

What **held** on D1 (test/d1-lineage.test.ts): the shared triggers apply unchanged statement by statement and enforce
immutable identity, set-once hash, unique hash, `INSERT/UPDATE OR REPLACE` guards (attempt id, operation key, hash,
event seq), terminal `verified-final` (fresh id refused), a new commitment digest refused after final and while open,
`reconciled-not-landed` refused (writer and raw SQL), `verified-final` requiring a hash and a latest
`verifier: 'attested-evidence'` verdict for that hash, append-only events, retained attempts, frozen closed rows,
legacy unresolved attempts blocking. The D1 attempt reader returns rows deep-equal to `AttemptLineageReader` for the same
operation sequence (shape, history and `seq`). Concurrent writers (24 fresh ids, mixed digests; 16 raw inserts with no
pre-check) produce exactly one attempt; 12 concurrent identical claims give one `created` and 11 `existing`. A failing
statement rolls back its whole `db.batch()`. A persisted D1 directory reopened by a new Miniflare instance keeps rows and
triggers.

What **differs** (and how the prototype writer handles it):

| node:sqlite store | D1 | Handling |
| --- | --- | --- |
| `BEGIN IMMEDIATE … COMMIT` around pre-check and writes | **No interactive transactions**: `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` are rejected ("use state.storage.transaction()") | Pre-checks are advisory; triggers are the authority. Multi-statement writes are one `db.batch()` (atomic). Writes that depended on a just-read row are made conditional in SQL (`INSERT … SELECT … WHERE`, `UPDATE … WHERE hash IS NOT ?` + `WHERE changes() = 1`). A losing concurrent `recordAttempt`/`importLegacy` re-reads and maps the trigger error back to node's message or to `'existing'` |
| `PRAGMA journal_mode = WAL; busy_timeout` | **Not authorized** (`SQLITE_AUTH`) | Not needed: D1 serializes writes per database |
| Reader opens the file `readOnly` + `PRAGMA query_only` | **No read-only connection**; `PRAGMA query_only` not authorized. The binding that reads can write, and can even `DROP TRIGGER` (tested) | Read-only is enforced by code (all Worker queries are SELECTs, asserted by a test) and review. Re-applying the idempotent schema restores dropped triggers. A production design needs separate databases/bindings or a write-proxy |
| `PRAGMA foreign_keys = ON` set explicitly | ON by default, but a query may set `PRAGMA foreign_keys = OFF` | Triggers do not depend on foreign keys |
| `appendVerification` reads the hash, then inserts | — | The verdict's `hash` comes from the row in the same statement (`json_object(…, 'hash', hash)`), same JSON key order |
| Same-hash `recordHash` race serialized by the transaction | — | Conditional update + `changes()` in one batch: exactly one `hash-recorded` event (tested) |
| — | `ATTACH`, `sqlite_version()` not authorized | Not used |
| Trigger messages | D1 wraps them: `D1_ERROR: <message>: SQLITE_CONSTRAINT` | Tests match the message text |

Observed in both engines: when two triggers would fire, SQLite runs the most recently created first, so a duplicate
under the same commitment reports "…invoice operation is open or finalized under some commitment".

**Blocked / not covered:** cross-request atomic read-modify-write (needs a Durable Object or a single-statement design),
remote D1 behaviour (replication, read replicas and `withSession` consistency were not exercised, by design), and
time-travel/restore semantics.

## P10.5: sessions, invitations and global replay protection

### Routes (all HMAC-signed over key ID, method, path, timestamp, nonce, SHA-256(body) and SHA-256(viewer token); Origin header → 401)

| Route | Behaviour |
| --- | --- |
| `POST /v1/sessions` body `{"invitation":"<code>"}` | Content type must be `application/json` (else 400). Body read with a hard cap of `MAX_BODY_BYTES` (larger, or invalid UTF-8 → 400, before auth). After HMAC + nonce: stricter per-key bucket (429), `parseSessionBody` (400), then one atomic `db.batch`: conditional `UPDATE viewer_invitations SET used_at_ms, session_sha256 … WHERE used_at_ms IS NULL AND expires_at_ms > now` + `INSERT INTO viewer_sessions … SELECT … WHERE session_sha256 = <this token's hash>`. Unknown, used, expired → uniform **403 `invalid-credentials`**. Success → `SessionResponse` with a fresh 256-bit base64url token (stored only as SHA-256), absolute expiry now + 12 h, idle timeout 30 min |
| `DELETE /v1/sessions/current` (viewer header) | Sets `revoked_at_ms` once. Idempotent; an unknown token also answers `{"kind":"revoked"}` (no oracle). Malformed token → 404 (contract). If D1 cannot acknowledge the write, the server returns 503 and the browser retains its cookie |
| `GET /v1/invoices` (viewer header) | Permitted invoices of the viewer's tenant (`invoice_permissions` ⨝ `tenant_directory` ⨝ `invoices`, same tenant on every join), `LIMIT MAX_LIST`, ordered by id. Each row's commitment is re-derived with `commit()`; rows whose digest or id do not match are skipped. Returns `{id, revision, targetAtomic: buyAmount, maxDebitAtomic: maxSell}` only, no settlement claims |
| `GET /v1/invoices/{id}/authoritative` | Unchanged, but the session check is the P10.5 one below |

Every outgoing body is validated with `parseResponse` or `parseSessionOrListResponse` before sending.

### Session validation (every viewer route)

One conditional `UPDATE viewer_sessions SET idle_expires_at_ms = MIN(now + 30 min, expires_at_ms) WHERE token_sha256 = ? AND
revoked_at_ms IS NULL AND expires_at_ms > now AND authenticated_at_ms <= now AND idle > now RETURNING …` (src/d1-auth.ts),
wrapped as a `ViewerAuthenticator` and passed through `authenticateViewer` (src/viewer-access.ts brands the viewer). So the
sliding refresh is atomic and never extends beyond the absolute expiry. It writes only the auth table. Rows from P10.4
(NULL `idle_expires_at_ms`) are read as idle until `min(authenticated_at_ms + 30 min, expires_at_ms)`.

Schema (`src/d1-schema.ts`, idempotent): `viewer_invitations(code_sha256 PK, tenant_id, viewer_id, created_at_ms,
expires_at_ms, used_at_ms, session_sha256)`; `viewer_sessions` gains `idle_expires_at_ms, revoked_at_ms, created_from
(invitation hash or 'seed'/NULL for legacy rows), rotated_from` through `ALTER TABLE ADD COLUMN` (a duplicate column is ignored).
Triggers: an invitation is consumed at most once and its identity is immutable; a revocation is final; session identity is
immutable; idle expiry can never exceed absolute expiry.

### Global replay store (decision 3)

`service_nonces(key_id, nonce, seen_at_ms, PK(key_id, nonce))`. After `verifyRequest` passes (it still claims the
per-isolate `NonceWindow` first, as a fast path), the handler INSERTs the nonce. A primary-key conflict → 401
`unauthenticated-service`; **any other D1 error → 503 `unavailable`** (fail closed). Unauthenticated requests never write.
With probability 1 % a request prunes `seen_at_ms < now − (2 × 60 s + 60 s)`: a replay must carry a timestamp within ±60 s
of the verifier's clock, so its first use was at most 120 s earlier; the extra minute absorbs isolate clock drift.
Tested across two separate Miniflare instances sharing one persisted D1 directory (sequential and racing). When two local
workerd processes race on the same SQLite file, a loser can get `SQLITE_BUSY` → 503 (still never a second 200); hosted D1
has a single primary.

### Rate limiting

Invitation exchange uses the normal per-key bucket and a stricter one (10, refill 0.2/s; per isolate). Per-invitation
attempt accounting is deliberately not implemented: codes are 256-bit random, so guessing is infeasible, and every
failure answers the same 403.

### Operator CLI (local persisted D1 only)

```
npm run seed                                     # also writes 3 single-use invitations per viewer to .wrangler/demo-identities.json
npm run invite -- <tenantId> <viewerId> [ttlMin]  # default 15 min; prints the code ONCE to stdout, stores only its SHA-256
npm run revoke-sessions -- <tenantId> <viewerId>  # revokes every live session of that viewer
```

Codes and tokens are never logged by the Worker (logs carry rid, route, status and key id only).

### Optional chain hook

`chainFromEnv(env)` (`src/chain-config.ts`) returns `{ rpc: createCeloRpc({url}), attributionCode }` only when
`DAIDAI_CHAIN_RPC_URL` is a valid https (or `http://127.0.0.1`) URL and `DAIDAI_ATTRIBUTION_CODE` is set; otherwise
`undefined` and no chain reader exists (operations stay unknown). Its result goes to `projectionSources({ chain })`.

## Limitations: NOT production-ready

- Replay protection is global (D1), but the rate limiters are still **per isolate**; production needs a platform rate limit.
- Invitations are an interim identity mechanism (no IdP). There is no in-place token rotation route: a new session comes
  only from a new invitation. Successful login atomically revokes the prior browser session and records its hash in `rotated_from`. An invalid invitation leaves the prior session intact.
- The Worker never applies the schema; a database without the P10.5 tables answers 503 to every authenticated request.
- No chain reader by default; the optional hook is untested against live RPC by design.
- The D1 lineage writer is a test prototype. The only write routes touch authentication tables; no execution service, no wallet and no dispatch.
- No remote D1 is provisioned; the database id is a placeholder.
- The read binding can write (see A8); a compromised Worker could modify data. Not acceptable for production.
