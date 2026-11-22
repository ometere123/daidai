// Daidai web demo: unit checks on the model plus Chromium checks against a running preview.
// The preview must be built with NEXT_PUBLIC_DAIDAI_DEMO_TOOLS=1 so ?demo= and ?data= fixtures are reachable.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { formatTokenAmount, parseAtomic, phase, fixtures, scenarios, settled, nextAction } from '../app/model.ts';

const base = process.env.DAIDAI_PREVIEW_URL ?? 'http://127.0.0.1:3219';
const output = process.env.PLUMB_SCREENSHOTS;
let browser;
before(async () => {
  const executablePath = process.env.DAIDAI_CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/opt/pw-browsers/chromium', '/usr/bin/chromium',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath, args: ['--disable-extensions'] });
  if (output) mkdirSync(output, { recursive: true });
});
after(async () => { await browser?.close(); });

const spy = () => { window.walletCalls = []; window.ethereum = { request(args) { window.walletCalls.push(args); throw Error('Unexpected wallet path'); } }; };

/** Page-level demo-safety checks shared by every screen. */
async function demoSafety(page, label) {
  const text = await page.evaluate(() => document.body.innerText);
  assert(!/\bdaidai\b/.test(text), label + ': lowercase brand "daidai" rendered');
  assert(!/0x[0-9a-fA-F]{64}/.test(text), label + ': 64-hex hash rendered in demo');
  assert(!/0x[0-9a-fA-F]{40}\b/.test(text), label + ': real-looking 40-hex address rendered in demo');
  assert(!/0x0000/i.test(text), label + ': zero-padded address rendered');
  assert(!/\b\d{2},\d{3},\d{3}\b/.test(text.replace(/[\d,]+(\.\d+)?\s(cNGN|USDt|CELO)/g, '')), label + ': block-number-like figure rendered');
  assert(text.includes('Nothing here happened onchain'), label + ': demo strip missing');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), label + ': horizontal overflow');
  // No fixed element may cover main content (the sticky action bar sits in flow).
  const fixed = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => getComputedStyle(el).position === 'fixed' && el.getClientRects().length && getComputedStyle(el).display !== 'none').map(el => el.className));
  assert.deepEqual(fixed, [], label + ': fixed elements present ' + fixed.join(','));
  assert.equal(await page.locator('h1').count(), 1, label + ': expected one h1');
}

test('amounts format tightly and exactly', () => {
  assert.equal(formatTokenAmount(0n, 'cNGN'), '0\u00a0cNGN');
  assert.equal(formatTokenAmount(200_000n, 'USDt'), '0.20\u00a0USDt');
  assert.equal(formatTokenAmount(48_500_000_000n, 'cNGN'), '48,500\u00a0cNGN');
  assert.equal(formatTokenAmount(150_000_000_000n, 'cNGN'), '150,000\u00a0cNGN');
  assert.equal(formatTokenAmount(102_480_000n, 'USDt'), '102.48\u00a0USDt');
  assert.equal(formatTokenAmount(150_000_000_001n, 'cNGN'), '150,000.000001\u00a0cNGN');
  assert.equal(formatTokenAmount(0n, 'cNGN', 2), '0.00\u00a0cNGN');
  assert.equal(parseAtomic('1.000001'), 1_000_001n);
  assert.equal(parseAtomic('1.0000001'), null);
});

test('settlement rules and role-correct cast', () => {
  const now = 0;
  const items = fixtures(now);
  const receipt = items.find(i => i.id === 'INV-0032');
  assert.equal(phase(receipt), 'Settled');
  assert.equal(phase({ ...receipt, evidence: { ...receipt.evidence, amount: receipt.target - 1n } }), 'Needs reconciliation');
  assert.equal(phase({ ...receipt, evidence: { ...receipt.evidence, recipient: '0xother' } }), 'Needs reconciliation');
  assert.equal(phase({ ...receipt, evidence: { ...receipt.evidence, debit: receipt.cap + 1n } }), 'Needs reconciliation');
  assert.equal(phase({ ...receipt, flow: 'converted' }), 'Needs you');
  assert.equal(phase({ ...receipt, flow: 'payout-submitted' }), 'In progress');
  assert.equal(phase(items.find(i => i.id === 'INV-0035')), 'Waiting for signatures');
  assert.equal(settled(scenarios.mismatch.patch(items.find(i => i.id === 'INV-0039'), now)), false);
  assert.equal(new Set(items.map(i => i.recipient)).size, items.length, 'each invoice has its own recipient');
  assert.equal(new Set(items.map(i => i.wallet)).size, items.length, 'each invoice has its own wallet');
  for (const i of items) {
    assert.notEqual(i.approver, i.recipient);
    assert.match(i.wallet, /DEMO/);
    assert(i.quote === undefined || i.quote.pay <= i.cap, i.id + ' quote within limit');
    assert(nextAction(i, now).length > 0);
  }
});

const views = [
  ['dashboard', '/', /Invoices/],
  ['review', '/?invoice=INV-0042', /Amaka Nwosu receives exactly/],
  ['receipt', '/?invoice=INV-0032&view=progress', /Settled \(demo\)/],
];
for (const width of [320, 375, 768, 1440]) {
  test('layout, demo safety and screenshots at ' + width + ' px', async t => {
    const page = await browser.newPage({ viewport: { width, height: width < 800 ? 812 : 900 }, reducedMotion: 'reduce' });
    t.after(() => page.close());
    for (const [name, url, title] of views) {
      await page.goto(base + url);
      await page.getByRole('heading', { level: 1, name: title }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await demoSafety(page, name + ' @' + width);
      if (output) await page.screenshot({ path: join(output, name + '-' + width + '.png'), fullPage: true });
    }
  });
}

test('every transaction state renders from a fixture with a (demo) headline and one safe action', async t => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(spy);
  for (const [key, s] of Object.entries(scenarios)) {
    await page.goto(base + '/?demo=' + key);
    await page.locator('h1').waitFor();
    await page.waitForTimeout(150);
    const headline = s.view === 'progress' ? await page.locator('h1').innerText() : await page.locator('.stage-open h2').innerText();
    assert.match(headline, /\(demo\)/, key + ': headline lacks (demo): ' + headline);
    assert(await page.locator('.action-bar').count() === 1, key + ': no action bar');
    assert(await page.locator('.action-bar .btn.primary').count() <= 1, key + ': more than one primary action');
    if (key === 'unknown' || key === 'mismatch') {
      assert.equal(await page.getByRole('button', { name: /retry|review payout/i }).count(), 0, key + ': retry offered');
      await page.getByRole('alert').first().waitFor();
    }
    await demoSafety(page, key);
    if (output) await page.screenshot({ path: join(output, 'state-' + key + '-375.png'), fullPage: true });
  }
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
});

test('dashboard keyboard: arrows move the selection, Enter opens', async t => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.goto(base + '/');
  await page.getByRole('heading', { level: 1, name: 'Invoices' }).waitFor();
  await page.locator('a.row[tabindex="0"]').focus();
  await page.keyboard.press('ArrowDown');
  await page.locator('.focus').getByText('Chinedu Obi receives exactly').waitFor();
  assert.match(page.url(), /selected=INV-0041/);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { level: 1, name: /Daidai taker wallet/ }).waitFor();
});

test('empty state is accessible and the dialog returns focus', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(base + '/?data=empty');
  await page.getByRole('heading', { name: 'No invoices yet' }).waitFor();
  const newButton = page.locator('.empty').getByRole('button', { name: 'New invoice' });
  await newButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'New invoice');
});

test('quote expiry closes conversion; unknown payout blocks retry; no wallet dispatch', async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(spy);
  await page.clock.install();
  await page.goto(base + '/?invoice=INV-0042');
  await page.getByRole('heading', { level: 1, name: /Amaka/ }).waitFor();
  await page.clock.fastForward(45_000);
  await page.locator('.gauge-text').filter({ hasText: /Expired at .* WAT\. No USDt was spent/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Review conversion/ }).count(), 0);
  await page.getByRole('button', { name: 'Get a new quote' }).waitFor();
  await page.goto(base + '/?invoice=INV-0039&view=progress');
  await page.getByRole('alert').filter({ hasText: /Retrying is blocked/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /retry/i }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
});

test('conversion and payout stay in the demo, submission never settles, large text does not overflow', async t => {
  const page = await browser.newPage({ viewport: { width: 740, height: 375 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(spy);
  await page.goto(base + '/?invoice=INV-0042');
  await page.getByRole('button', { name: /Review conversion/ }).click();
  await page.getByRole('dialog', { name: /Convert 102\.48.USDt to 150,000.cNGN/ }).waitFor();
  await page.getByRole('button', { name: 'Simulate approval (demo)' }).click();
  await page.getByRole('heading', { level: 1, name: /Conversion submitted/ }).waitFor();
  await page.locator('.verdict').getByText(/Amaka Nwosu has not been paid/).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Review payout' }).click();
  await page.getByRole('button', { name: 'Simulate approval (demo)' }).click();
  await page.getByRole('heading', { level: 1, name: /Payout submitted/ }).waitFor();
  assert.equal(await page.getByRole('heading', { level: 1, name: /^Settled/ }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'large text overflows in landscape');
});

test('focused controls are never hidden behind the sticky bars at 375 px', async t => {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.goto(base + '/?invoice=INV-0042');
  await page.locator('h1').waitFor();
  for (let n = 0; n < 18; n++) {
    await page.keyboard.press('Tab');
    const hidden = await page.evaluate(() => {
      const el = document.activeElement; if (!el || el === document.body || el.matches('.skip') || el.closest('.action-bar, .topbar')) return false;
      const r = el.getBoundingClientRect(); const bar = document.querySelector('.action-bar')?.getBoundingClientRect(); const top = document.querySelector('.topbar')?.getBoundingClientRect();
      return Boolean((bar && r.top >= bar.top && r.bottom <= bar.bottom) || (top && r.bottom <= top.bottom));
    });
    assert.equal(hidden, false, 'focused element obscured at tab stop ' + n);
  }
});

test('P09D.1 financial copy: face value vs settlement asset, quote expiry, gated new attempts', async t => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  t.after(() => page.close());
  await page.addInitScript(spy);
  await page.goto(base + '/?invoice=INV-0042');
  await page.locator('h1').waitFor();
  const review = await page.evaluate(() => document.body.innerText);
  assert(!/Pegged/i.test(review), 'peg wording still present');
  assert.match(review, /Invoice face value ₦150,000, settled as exactly this amount of cNGN/);
  assert.match(review, /Not a naira bank payment/);
  assert(!/\bHolds\b|holds \d/i.test(review), '"holds" wording still present');
  assert.match(review, /Quote expires in \d:\d\d/);
  await page.goto(base + '/?demo=checked');
  await page.locator('h1').waitFor();
  const checked = await page.evaluate(() => document.body.innerText);
  assert(!/retry is (now )?safe/i.test(checked), 'absolute retry wording still present');
  assert.match(checked, /authoritative reconciliation, fresh preflight checks and your approval/);
  await page.getByRole('button', { name: 'Review a new payout attempt' }).click();
  await page.getByRole('dialog').getByText('Required before a new payment attempt').waitFor();
  for (const key of ['unknown', 'mismatch', 'conversion-submitted', 'payout-submitted']) {
    await page.goto(base + '/?demo=' + key);
    await page.locator('h1').waitFor();
    assert.equal(await page.getByRole('button', { name: /retry|payout attempt|review payout/i }).count(), 0, key + ': retry offered');
  }
  assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
});

test('P09D.1 layout: reconciliation readable at 320/375, gauge labels inside, desktop bar never covers costs', async t => {
  for (const width of [320, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 812 }, reducedMotion: 'reduce' });
    await page.goto(base + '/?invoice=INV-0032&view=progress');
    await page.locator('.recon').waitFor();
    const diff = await page.locator('tr.difference th').evaluate(el => ({ lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '24')), text: el.innerText }));
    assert.equal(diff.lines <= 1, true, 'Difference label wraps at ' + width);
    for (const label of ['Invoice', 'Found (demo)']) assert(await page.locator('.recon td[data-label="' + label + '"]').count() > 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
  }
  for (const width of [320, 375, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(base + '/?invoice=INV-0042');
    await page.locator('.gauge-tick.last').waitFor();
    const inside = await page.evaluate(() => { const g = document.querySelector('.gauge').getBoundingClientRect();
      return [...document.querySelectorAll('.gauge-tick span')].every(s => { const r = s.getBoundingClientRect(); return r.left >= g.left - 0.5 && r.right <= g.right + 0.5 && r.height < 24; }); });
    assert(inside, 'tick label clipped or wrapped at ' + width);
    if (width === 1440) {
      const overlap = await page.evaluate(() => { const bar = document.querySelector('.action-bar').getBoundingClientRect();
        return [...document.querySelectorAll('.cost tr, .stage-open')].some(el => { const r = el.getBoundingClientRect(); return r.bottom > bar.top + 1 && r.top < bar.bottom - 1; }); });
      assert.equal(overlap, false, 'desktop action bar overlaps cost breakdown');
    }
    await page.close();
  }
});
