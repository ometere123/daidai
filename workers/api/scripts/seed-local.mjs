// Seeds an isolated LOCAL D1 (Miniflare persist dir under workers/api/.wrangler/) with controlled test identities.
// Keys, signatures and tokens are generated at runtime; they are written only to gitignored files:
//   workers/api/.dev.vars                       DAIDAI_SERVICE_KEYS for the local Worker
//   workers/api/.wrangler/demo-identities.json  service key + viewer tokens for the lead's frontend demo
// No network, no remote D1, no Cloudflare account. Re-running wipes and re-seeds.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { AUDIENCE, seed, serviceKey, startWorker } from '../test/fixtures.ts';
import { PORT, devVarsFile, identitiesFile, persistDir, root } from './local-paths.mjs';

rmSync(persistDir, { recursive: true, force: true });
mkdirSync(persistDir, { recursive: true });
const key = serviceKey();
const { mf, db } = await startWorker({ keys: { [key.keyId]: key.secret }, persist: persistDir });
const s = await seed(db);
await mf.dispose();

writeFileSync(devVarsFile, `DAIDAI_SERVICE_KEYS=${JSON.stringify(JSON.stringify({ [key.keyId]: key.secret }))}\n`, { mode: 0o600 });
writeFileSync(identitiesFile, JSON.stringify({
  warning: 'LOCAL DEMO ONLY. Throwaway identities generated at seed time. Never commit, never reuse.',
  apiBaseUrl: `http://127.0.0.1:${PORT}`, audience: AUDIENCE, service: key,
  viewers: {
    'demo-viewer': { tenantId: 'tenant-a', token: s.tokens.demo, readable: ['inv-a1', 'inv-a2', 'inv-a3'] },
    'viewer-b': { tenantId: 'tenant-b', token: s.tokens.viewerB, readable: ['inv-b1'] },
    'viewer-a-none': { tenantId: 'tenant-a', token: s.tokens.noPermission, readable: [] },
    'demo-viewer-expired': { tenantId: 'tenant-a', token: s.tokens.expired, readable: [] },
  },
  scenarios: { 'inv-a1': 'no attempts', 'inv-a2': 'hashless outcome-unknown payout', 'inv-a3': 'legacy unresolved payout',
    'inv-a4': 'exists, demo-viewer has no permission', 'inv-b1': 'tenant-b invoice' },
  sessionsExpireAtMs: Date.now() + 8 * 3600_000,
}, null, 2), { mode: 0o600 });
chmodSync(identitiesFile, 0o600);
console.log(`seeded local D1 at ${persistDir.slice(root.length)}; identities in ${identitiesFile.slice(root.length)} and .dev.vars (gitignored)`);
