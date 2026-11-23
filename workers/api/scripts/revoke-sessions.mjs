// Operator CLI (LOCAL ONLY): revokes every live session of a viewer in the persisted local D1.
//   npm run revoke-sessions -- <tenantId> <viewerId>
import { existsSync } from 'node:fs';
import { revokeViewerSessions } from '../src/d1-auth.ts';
import { applySchema } from '../src/d1-schema.ts';
import { startWorker } from '../test/fixtures.ts';
import { persistDir } from './local-paths.mjs';

const [tenantId, viewerId] = process.argv.slice(2);
if (!tenantId || !viewerId) { console.error('usage: npm run revoke-sessions -- <tenantId> <viewerId>'); process.exit(2); }
if (!existsSync(persistDir)) { console.error('no local D1; run `npm run seed` first'); process.exit(1); }
const { mf, db } = await startWorker({ keys: { 'cli-unused': 'x'.repeat(32) }, persist: persistDir });
try {
  await applySchema(db);
  console.log(`revoked ${await revokeViewerSessions(db, tenantId, viewerId, Date.now())} session(s) for ${tenantId}/${viewerId}`);
} finally { await mf.dispose(); }
