import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const config = JSON.parse(read('ops/p12-launch.json'));
const worker = read('workers/api/wrangler.toml');
const web = read('apps/web/.env.example');
assert.deepEqual(config, {
  frontend: { platform: 'vercel', root: 'apps/web', node: '22.x', productionPrivate: false, previewPrivate: false },
  worker: { platform: 'cloudflare', routes: [], mode: 'closed', productionWrites: false },
  database: { platform: 'd1', binding: 'DB', remoteMigration: false }, financialExecution: false,
});
assert.match(worker, /^workers_dev = false$/m);
assert.match(worker, /^preview_urls = false$/m);
assert.match(worker, /^DAIDAI_LAUNCH_MODE = "closed"$/m);
assert.match(worker, /^database_id = "00000000-0000-0000-0000-000000000000"$/m);
assert.doesNotMatch(worker, /^\s*(routes?|workers_dev\s*=\s*true)\b/m);
for (const key of ['DAIDAI_APP_ENABLED', 'DAIDAI_PREVIEW_ACCESS', 'DAIDAI_LOCAL_PRODUCT', 'DAIDAI_LOCAL_TEXTILE_PREVIEW']) {
  assert(web.split(/\r?\n/).includes(key + '=0'), key);
}
assert.doesNotMatch(web, /^NEXT_PUBLIC_.*(?:KEY|SECRET|TOKEN|RPC)/m);
console.log('P12 launch configuration validated. No remote operation performed.');
