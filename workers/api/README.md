# Daidai read-only API Worker (P10.4, local prototype)

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

`wrangler` is a devDependency only for local `wrangler dev`/types; tests and scripts never invoke it. **Never run
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
| `DAIDAI_SERVICE_KEYS` | **secret** | JSON `{"<keyId>": "<secret ≥ 32 chars>"}`. Locally `.dev.vars` (gitignored, written by the seed script). Remotely it would be `wrangler secret put` (not done in P10.4). Never committed. Missing or malformed → every request 503 |

`wrangler.toml` has `workers_dev = false`, no routes and no custom domain.

## D1 vs node:sqlite (A5–A8)

All findings below are from tests against local D1 in workerd (Miniflare 3), not assumed from node:sqlite.

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

## Limitations: NOT production-ready

- Nonce replay window and rate limiter are **per isolate**: a replay or burst can succeed on another isolate within the
  ±60 s window. Production needs a global store (Durable Object or D1 nonce table) and a platform rate limit.
- Sessions must be inserted server-side; there is no login flow, rotation or revocation API.
- No chain reader; nothing can settle. Adding one requires the P10.3 `readOnlyRpc` and a reviewed RPC configuration.
- The D1 lineage writer is a test prototype. There is no write route, no execution service, no wallet and no dispatch.
- No remote D1 is provisioned; the database id is a placeholder.
- The read binding can write (see A8); a compromised Worker could modify data. Not acceptable for production.
