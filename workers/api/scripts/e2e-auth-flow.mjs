// P10.5 U1 end to end, real components only: seeded local D1 -> real Worker (Miniflare, loopback) -> real Next.js
// production build -> real Chromium. Login with a single-use invitation, list, detail, cross-tenant denial, logout,
// invitation reuse, and Preview gating. Local only; prints no codes, tokens or keys.
// Prereqs: workers/api: npm run seed (invitations are single-use, so re-seed before each run) ; apps/web: npm run build. Usage: node workers/api/scripts/e2e-auth-flow.mjs
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const W = resolve(here, '..'), WEB = resolve(here, '../../../apps/web'), ROOT = resolve(here, '../../..');
const { chromium } = createRequire(resolve(ROOT, 'package.json'))('playwright-core');
const id = JSON.parse(readFileSync(W + '/.wrangler/demo-identities.json', 'utf8'));
const codes = id.invitations['demo-viewer'];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };
const wait = async (url, ok = r => r.status < 500) => { for (let i = 0; i < 80; i++) { try { if (ok(await fetch(url, { redirect: 'manual' }))) return; } catch {} await new Promise(r => setTimeout(r, 500)); } throw Error('timeout ' + url); };
const kill = p => { if (!p.pid) return; try { process.kill(process.platform === 'win32' ? p.pid : -p.pid, 'SIGTERM'); } catch {} };
const startWeb = (port, extra) => spawn(process.execPath, [resolve(WEB, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: WEB, detached: true, stdio: 'ignore', env: {
  ...process.env, DAIDAI_API_BASE_URL: 'http://127.0.0.1:8787', DAIDAI_SERVICE_KEY_ID: id.service.keyId, DAIDAI_SERVICE_KEY: id.service.secret, ...extra } });

const worker = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', 'scripts/dev-server.mjs'], { cwd: W, env: { ...process.env, DAIDAI_AUDIENCE: id.audience }, stdio: 'ignore', detached: true });
const procs = [worker];
let browser;
try {
  const executablePath = process.env.DAIDAI_CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/opt/pw-browsers/chromium', '/usr/bin/chromium',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath, args: ['--disable-extensions'] });
  await wait('http://127.0.0.1:8787/v1/health', r => r.status === 401);
  const web = startWeb(3400, { DAIDAI_APP_ENABLED: '1' }); procs.push(web);
  await wait('http://127.0.0.1:3400/');
  const base = 'http://127.0.0.1:3400';
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { window.__walletCalls = 0; window.ethereum = { request() { window.__walletCalls++; throw Error('no'); } }; });
  const page = await ctx.newPage();

  await page.goto(base + '/invoices');
  check('unauthenticated /invoices redirects to /login', new URL(page.url()).pathname === '/login');

  await page.fill('input[name=invitation]', codes[0]);
  await Promise.all([page.waitForURL(/\/invoices$/), page.click('button[type=submit]')]);
  const list = await page.textContent('body');
  check('login with a single-use invitation lands on /invoices', new URL(page.url()).pathname === '/invoices');
  check('list shows permitted invoices of own tenant only', ['inv-a1', 'inv-a2', 'inv-a3'].every(i => list.includes(i)) && !list.includes('inv-b1') && !list.includes('inv-a4'),
    ['inv-a1', 'inv-a2', 'inv-a3', 'inv-a4', 'inv-b1'].map(i => i + ':' + list.includes(i)).join(' '));
  const cookie = (await ctx.cookies()).find(c => c.name === '__Host-daidai_session');
  check('session cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/', !!cookie && cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict' && cookie.path === '/' && !cookie.domain.startsWith('.'));
  check('session cookie is not readable by page JavaScript', !(await page.evaluate(() => document.cookie)).includes('daidai_session'));

  await page.goto(base + '/invoices/inv-a2');
  const detail = await page.textContent('body');
  check('detail shows the authoritative record (digest, authorization, payout outcome unknown)', /[a-f0-9]{64}/.test(detail) && /Outcome unknown/.test(detail) && /Authoritative/.test(detail));
  check('detail never shows Settled without verified chain evidence', !/\bSettled\b/.test(detail));
  check('no session token in the HTML', !(await page.content()).includes(cookie?.value ?? '\u0000'));

  await page.goto(base + '/invoices/inv-b1');
  check('cross-tenant invoice is not available', /This invoice is not available/.test(await page.textContent('body')) && !/[a-f0-9]{64}/.test(await page.textContent('body')));

  // Logout (POST via the button), then everything private is gone and the cookie is cleared.
  await page.goto(base + '/invoices');
  await Promise.all([page.waitForURL(/\/login/), page.click('form[action="/api/session/logout"] button[type=submit]')]);
  check('logout clears the session cookie', !(await ctx.cookies()).some(c => c.name === '__Host-daidai_session'));
  await page.goto(base + '/invoices/inv-a1');
  check('after logout, private pages redirect to /login', new URL(page.url()).pathname === '/login');

  // The used invitation cannot be reused; an unused one works and creates a new, independent session.
  await page.fill('input[name=invitation]', codes[0]);
  await page.click('button[type=submit]'); await page.waitForLoadState();
  const msg = await page.textContent('body');
  check('reusing an invitation shows the uniform failure', /That invitation is not valid/.test(msg) && new URL(page.url()).pathname === '/login');
  await page.fill('input[name=invitation]', codes[1]);
  await Promise.all([page.waitForURL(/\/invoices$/), page.click('button[type=submit]')]);
  check('a fresh invitation creates a new session', new URL(page.url()).pathname === '/invoices');
  check('no wallet-provider calls', (await page.evaluate(() => window.__walletCalls)) === 0);
  await page.goto(base + '/');
  check('fixture demo at / unchanged (Demo workspace strip)', /Demo workspace/.test(await page.textContent('body')));
  const sessionCookie = (await ctx.cookies()).find(c => c.name === '__Host-daidai_session');
  kill(web);

  // Preview without explicit access: 404 even with a valid session cookie.
  const preview = startWeb(3401, { VERCEL_ENV: 'preview', DAIDAI_APP_ENABLED: '1' }); procs.push(preview);
  await wait('http://127.0.0.1:3401/');
  // Cookies are not port-scoped: the same context sends the real, still-valid session cookie to this server.
  check('a valid session cookie is present for the Preview check', !!sessionCookie);
  const pp = await ctx.newPage();
  const r1 = await pp.goto('http://127.0.0.1:3401/invoices');
  const r2 = await pp.goto('http://127.0.0.1:3401/login');
  check('Preview without DAIDAI_PREVIEW_ACCESS: private pages and /login are 404', r1?.status() === 404 && r2?.status() === 404, `${r1?.status()} ${r2?.status()}`);
} finally {
  await browser?.close();
  procs.forEach(kill);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
