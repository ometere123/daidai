// Serves the built Worker in Miniflare on 127.0.0.1:8787 over the seeded local D1 (run `npm run seed` first).
// Local only: binds to loopback, no Cloudflare account, no remote resources. Prints only the port.
import { existsSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { AUDIENCE, WORKER } from '../test/fixtures.ts';
import { PORT, devVarsFile, persistDir } from './local-paths.mjs';

if (!existsSync(devVarsFile) || !existsSync(persistDir)) { console.error('not seeded: run `npm run seed` first'); process.exit(1); }
const line = readFileSync(devVarsFile, 'utf8').split('\n').find(l => l.startsWith('DAIDAI_SERVICE_KEYS='));
const keys = JSON.parse(line.slice('DAIDAI_SERVICE_KEYS='.length));
const mf = new Miniflare({
  modules: true, scriptPath: WORKER, compatibilityDate: '2024-11-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: { DB: 'daidai-local' }, d1Persist: persistDir, host: '127.0.0.1', port: PORT,
  bindings: { DAIDAI_SERVICE_KEYS: keys, DAIDAI_AUDIENCE: process.env.DAIDAI_AUDIENCE ?? AUDIENCE },
});
const url = await mf.ready;
console.log(`port ${url.port}`);
const stop = async () => { await mf.dispose(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
