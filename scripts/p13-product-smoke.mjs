import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const origin = process.env.DAIDAI_P13_PREVIEW ?? 'http://127.0.0.1:3219';
const publicPages = ['/', '/pay', '/agent', '/proof', '/demo'];
const offered = new Map(); // every same-origin link a visitor can click, and where it was offered
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
      for (const href of await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')))) {
        if (href && href.startsWith('/') && !href.startsWith('//')) offered.set(href.split('#')[0] || path, path);
      }
      // The public profile must not advertise a door that answers 404.
      const navText = await page.locator('nav[aria-label="Main navigation"]').innerText();
      for (const closed of ['Invoices', 'Activity']) assert(!navText.includes(closed), path + ' offers ' + closed);
      assert.equal(await page.getByRole('link', { name: 'Sign in' }).count(), 0, path + ' offers Sign in');
      assert.equal(await page.getByRole('link', { name: 'Create an invoice' }).count(), 0, path + ' offers Create an invoice');
      if (process.env.DAIDAI_P13_SCREENSHOTS && (path === '/' || path === '/proof')) {
        await page.screenshot({ path: process.env.DAIDAI_P13_SCREENSHOTS + '/p13-' + width + (path === '/' ? '-home' : '-proof') + '.png', fullPage: true });
      }
    }
    await page.close();
    console.log('Public routes verified at ' + width + ' px. Zero wallet calls.');
  }
  // Link crawl: every link offered on every public page resolves to a page, never a 404 or an error.
  for (const [href, from] of offered) {
    const r = await fetch(origin + href, { redirect: 'manual' });
    assert(r.status === 200, `dead link ${href} offered on ${from}: HTTP ${r.status}`);
  }
  assert(offered.size >= 6, 'link crawl saw too few links: ' + offered.size);
  console.log('Link crawl: ' + offered.size + ' distinct same-origin links, all 200.');
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
