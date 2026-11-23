import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = process.env.DAIDAI_P13_PREVIEW ?? 'http://127.0.0.1:3219';
const browser = await chromium.launch({ executablePath: process.env.DAIDAI_CHROMIUM_PATH, args: ['--disable-extensions'] });
try {
  for (const width of [375, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => { window.walletCalls = 0; window.ethereum = { request() { window.walletCalls++; throw Error('Unexpected wallet call'); } }; });
    for (const [path, heading] of [['/','Invoice in cNGN.'], ['/pay','Payer review'], ['/agent','Daidai agent #10103'], ['/proof','Public verification'], ['/demo','Invoices']]) {
      assert.equal((await page.goto(origin + path, { timeout: 30_000 }))?.status(), 200, path);
      await page.getByRole('heading', { level: 1, name: new RegExp(heading) }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + ' ' + path);
      assert.equal(await page.evaluate(() => window.walletCalls), 0, path);
      if (path !== '/demo') assert(!(await page.locator('body').innerText()).includes('Demo workspace'), path);
      if (process.env.DAIDAI_P13_SCREENSHOTS && (path === '/' || path === '/proof')) {
        await page.screenshot({ path: process.env.DAIDAI_P13_SCREENSHOTS + '/p13-' + width + (path === '/' ? '-home' : '-proof') + '.png', fullPage: true });
      }
    }
    await page.close();
    console.log('Public routes verified at ' + width + ' px. Zero wallet calls.');
  }
  for (const path of ['/invoices','/invoices/new','/invoices/arbitrary','/activity','/login','/merchant']) {
    const r = await fetch(origin + path + '?DAIDAI_APP_ENABLED=1', { redirect:'manual' });
    assert.equal(r.status, 404, path);
    if (path !== '/login') assert.match(r.headers.get('cache-control') ?? '', /no-store/, path);
  }
  const denied = await fetch(origin + '/api/session', { method: 'POST', headers: { origin } });
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.has('set-cookie'), false);
  console.log('Hosted flags, route denial, private caching and absent session cookie verified.');
} finally { await browser.close(); }
