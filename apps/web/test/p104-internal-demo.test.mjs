// P10.4 internal authoritative demo — REMOVED in P10.5. The env-token path (DAIDAI_DEMO_VIEWER_TOKEN) must never serve data:
// /internal/authoritative/* is 404 in every environment, even with the old P10.4 flags and a valid viewer token configured,
// and the fake API is never called. One `next build`, then `next start` with env variants. Only 127.0.0.1; no wallet, no RPC.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { errorBody, responseHeaders } from '../../../src/api-contract.ts';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const KEY_ID = 'p104-test';
const KEY = 'test-only-service-key-' + 'x'.repeat(24);
const TOKEN = 'viewer_' + 'a'.repeat(40);
const ID = 'invoice-a';

let fake, fakeUrl, browser, requests = [];
function startFake() {
  return new Promise(resolve => {
    fake = createServer((req, res) => { requests.push(req.url); res.writeHead(404, responseHeaders); res.end(JSON.stringify(errorBody('not-found-or-forbidden'))); })
      .listen(0, '127.0.0.1', () => { fakeUrl = 'http://127.0.0.1:' + fake.address().port; resolve(); });
  });
}

const nextBin = join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
async function startNext(env) {
  const port = await new Promise(r => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAIDAI_') && k !== 'VERCEL_ENV'));
  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: webRoot, env: { ...clean, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/manifest.webmanifest'); return { base, stop: () => child.kill(), log: () => log }; } catch { await new Promise(r => setTimeout(r, 150)); }
  }
  child.kill(); throw Error('next start did not come up: ' + log);
}
// Every old P10.4 switch turned on, plus the P10.5 app flag: the removed route must still be 404.
const oldEnv = (extra = {}) => ({ DAIDAI_INTERNAL_DEMO: '1', DAIDAI_INTERNAL_DEMO_ALLOW_PROD_BUILD: '1', DAIDAI_API_BASE_URL: fakeUrl,
  DAIDAI_SERVICE_KEY_ID: KEY_ID, DAIDAI_SERVICE_KEY: KEY, DAIDAI_DEMO_VIEWER_TOKEN: TOKEN, DAIDAI_APP_ENABLED: '1', DAIDAI_PREVIEW_ACCESS: '1', ...extra });

before(async () => {
  await startFake();
  if (process.env.DAIDAI_P104_SKIP_BUILD !== '1') {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DAIDAI_') && !k.startsWith('NEXT_PUBLIC_')));
    const r = spawnSync(process.execPath, [nextBin, 'build'], { cwd: webRoot, env: clean, encoding: 'utf8' });
    assert.equal(r.status, 0, 'next build failed:\n' + r.stdout + r.stderr);
  }
  browser = await chromium.launch({ executablePath: process.env.DAIDAI_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); fake?.close(); });

const spy = () => { window.walletCalls = []; window.ethereum = { request(args) { window.walletCalls.push(args); throw Error('Unexpected wallet path'); } }; };
async function visit(base, path) {
  const page = await browser.newPage();
  await page.addInitScript(spy);
  const response = await page.goto(base + path);
  const text = await page.evaluate(() => document.body.innerText);
  const walletCalls = await page.evaluate(() => window.walletCalls.length);
  await page.close();
  return { status: response.status(), text, walletCalls };
}

test('the env-token demo source is gone', () => {
  assert(!existsSync(join(webRoot, 'app', 'internal')), 'app/internal still exists');
  assert(!existsSync(join(webRoot, 'lib', 'internal-demo.ts')), 'lib/internal-demo.ts still exists');
  const files = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === 'node_modules' || f === '.next' || f === 'test') continue; statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(webRoot);
  for (const f of files.filter(f => /\.(ts|tsx|mjs|js)$/.test(f))) assert(!readFileSync(f, 'utf8').includes('DAIDAI_DEMO_VIEWER_TOKEN'), f + ' still reads the demo token');
});

test('browser chunks contain no service key name, signature header or API client', () => {
  const dir = join(webRoot, '.next', 'static');
  const files = []; const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dir);
  assert(files.length > 0);
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const needle of ['DAIDAI_SERVICE_KEY', 'DAIDAI_DEMO_VIEWER_TOKEN', 'DAIDAI_API_BASE_URL', 'x-daidai-signature', 'x-daidai-viewer', KEY, TOKEN]) {
      assert(!s.includes(needle), f + ' contains ' + needle);
    }
  }
});

test('/internal/authoritative/* is 404 in every environment; the API is never called; fixture demo unchanged', async () => {
  for (const extra of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production' }, { DAIDAI_INTERNAL_DEMO: '0' }]) {
    requests = [];
    const s = await startNext(oldEnv(extra));
    try {
      for (const p of ['/internal/authoritative/' + ID, '/internal/authoritative/nope', '/internal']) {
        const r = await visit(s.base, p);
        assert.equal(r.status, 404, JSON.stringify(extra) + ' ' + p);
        assert(!r.text.includes('Commitment digest') && !/\bSettled\b/.test(r.text));
      }
      assert.equal(requests.length, 0, 'removed route called the API');
      const home = await visit(s.base, '/demo');
      assert.equal(home.status, 200);
      assert(home.text.includes('Demo workspace'), 'fixture demo strip missing');
      assert.equal(home.walletCalls, 0);
      assert(!s.log().includes(TOKEN) && !s.log().includes(KEY), 'secret logged');
    } finally { s.stop(); }
  }
});
