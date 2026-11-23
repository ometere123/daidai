// Operator CLI (LOCAL ONLY): creates a single-use viewer invitation in the persisted local D1 (workers/api/.wrangler/).
//   npm run invite -- <tenantId> <viewerId> [ttlMinutes=15]
// Prints the invitation code ONCE to stdout. Only its SHA-256 is stored. No network, no remote D1.
import { existsSync } from 'node:fs';
import { createInvitation } from '../src/d1-auth.ts';
import { applySchema } from '../src/d1-schema.ts';
import { startWorker } from '../test/fixtures.ts';
import { persistDir } from './local-paths.mjs';

const [tenantId, viewerId, ttlRaw] = process.argv.slice(2);
if (!tenantId || !viewerId) { console.error('usage: npm run invite -- <tenantId> <viewerId> [ttlMinutes=15]'); process.exit(2); }
const ttlMinutes = ttlRaw === undefined ? 15 : Number(ttlRaw);
if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 24 * 60) { console.error('ttlMinutes must be an integer in 1..1440'); process.exit(2); }
if (!existsSync(persistDir)) { console.error('no local D1; run `npm run seed` first'); process.exit(1); }
const { mf, db } = await startWorker({ keys: { 'cli-unused': 'x'.repeat(32) }, persist: persistDir });
try {
  await applySchema(db);
  const { code, expiresAtMs } = await createInvitation(db, { tenantId, viewerId, nowMs: Date.now(), ttlMs: ttlMinutes * 60_000 });
  console.error(`invitation for ${tenantId}/${viewerId}, expires ${new Date(expiresAtMs).toISOString()} (single use; shown once):`);
  console.log(code);
} finally { await mf.dispose(); }
