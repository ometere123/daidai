// Real end-to-end check (P10.4): seeded local D1 -> real Worker (Miniflare, loopback) -> real Next.js internal demo.
// Prereqs: workers/api: npm run seed; apps/web: a production build (npm run build). Local only; prints no secrets.
// Usage: node workers/api/scripts/e2e-with-web.mjs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const W = resolve(here, '..'), WEB = resolve(here, '../../../apps/web');
const id = JSON.parse(readFileSync(W + '/.wrangler/demo-identities.json', 'utf8'));
const wait = async (url, ok = r => r.status < 500) => { for (let i = 0; i < 60; i++) { try { if (ok(await fetch(url))) return; } catch {} await new Promise(r => setTimeout(r, 500)); } throw Error('timeout ' + url); };
const worker = spawn('npm', ['run', 'dev'], { cwd: W, env: { ...process.env, DAIDAI_AUDIENCE: id.audience }, stdio: 'ignore', detached: true });
await wait('http://127.0.0.1:8787/v1/health', r => r.status === 401);   // unsigned health must be refused
const start = (token) => spawn('npx', ['next', 'start', '--hostname', '127.0.0.1', '--port', '3300'], { cwd: WEB, stdio: 'ignore', detached: true, env: {
  ...process.env, DAIDAI_INTERNAL_DEMO: '1', DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD: '1', DAIDAI_API_BASE_URL: 'http://127.0.0.1:8787',
  DAIDAI_SERVICE_KEY_ID: id.service.keyId, DAIDAI_SERVICE_KEY: id.service.secret, DAIDAI_DEMO_VIEWER_TOKEN: token } });
const kill = p => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} };
const text = h => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const tok = v => typeof v === 'string' ? v : v.token;
try {
  let web = start(tok(id.viewers['demo-viewer']));
  await wait('http://127.0.0.1:3300/');
  for (const inv of ['inv-a1', 'inv-a2', 'inv-a3', 'inv-a4', 'inv-b1', 'does-not-exist']) {
    const r = await fetch('http://127.0.0.1:3300/internal/authoritative/' + inv);
    const t = text(await r.text());
    const show = t.includes('Authoritative') && /[a-f0-9]{64}/.test(t);
    console.log(inv.padEnd(15), r.status, 'cache:', r.headers.get('cache-control'),
      '| shows record:', show, '| Settled:', / Settled(?! )|Settlement verified/i.test(t) && !/Reconciliation required|Settlement unverified/.test(t),
      '| states:', (t.match(/Outcome unknown|Reconciliation required|Settlement unverified|Unverified|Verified|not available|no chain reader[^.]*/gi) || []).slice(0, 6).join(', '));
  }
  kill(web);
  await new Promise(r => setTimeout(r, 1500));
  web = start(tok(id.viewers['demo-viewer-expired']));
  await wait('http://127.0.0.1:3300/');
  const r = await fetch('http://127.0.0.1:3300/internal/authoritative/inv-a1');
  console.log('expired session ', r.status, '| shows record:', /[a-f0-9]{64}/.test(text(await r.text())));
  kill(web);
} finally { kill(worker); }
