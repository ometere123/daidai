import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startAddressHost } from '../src/address-host.ts';

const expected = '0x000000000000000000000000000000000000d101';
const wrong = '0x000000000000000000000000000000000000d102';
let browser;
let host;

before(async () => {
  const executablePath = process.env.DAIDAI_CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find(existsSync);
  assert(executablePath, 'Set DAIDAI_CHROMIUM_PATH to an installed Chrome or Chromium binary.');
  host = await startAddressHost(expected);
  // Playwright creates a fresh temporary profile. No installed extensions or user browser profile.
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); await host?.close(); });

async function mockPage(t, mode) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.addInitScript(({ mode, expected, wrong }) => {
    const calls = [];
    const handlers = new Map();
    const emit = (event, value) => handlers.get(event)?.(value);
    const provider = {
      isMetaMask: true,
      on: (name, callback) => handlers.set(name, callback),
      removeListener: name => handlers.delete(name),
      async request(input) {
        calls.push(input);
        if (input.method === 'eth_chainId') return mode === 'chain' ? '0x1' : '0xa4ec';
        if (input.method === 'eth_requestAccounts') {
          if (mode === 'decline') throw Object.assign(Error('declined'), { code: 4001 });
          if (mode === 'midprompt') emit('chainChanged', '0x1');
          else emit('accountsChanged', [mode === 'account' ? wrong : expected]);
          return [mode === 'account' ? wrong : expected];
        }
        if (input.method === 'eth_accounts') return [expected];
        throw Error('Unexpected wallet method');
      },
    };
    window.mockWallet = { calls, emit };
    if (mode !== 'missing') addEventListener('eip6963:requestProvider', () =>
      dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask' }, provider } })));
  }, { mode, expected, wrong });
  await page.goto(host.origin);
  await page.waitForFunction(() => !document.querySelector('#verify').disabled);
  assert.deepEqual(await page.evaluate(() => window.mockWallet.calls), []);
  return page;
}

const cases = [
  ['ok', 'Verified public address', ['eth_chainId', 'eth_requestAccounts', 'eth_accounts', 'eth_chainId']],
  ['account', 'Account or network changed', ['eth_chainId', 'eth_requestAccounts']],
  ['chain', 'Select Celo mainnet', ['eth_chainId']],
  ['midprompt', 'Account or network changed', ['eth_chainId', 'eth_requestAccounts']],
  ['decline', 'Account access was declined', ['eth_chainId', 'eth_requestAccounts']],
  ['missing', 'No unambiguous MetaMask provider', []],
];
for (const [mode, result, methods] of cases) {
  test('isolated Chromium address check: ' + mode, async t => {
    const page = await mockPage(t, mode);
    await page.locator('#verify').click();
    await page.waitForFunction(result => document.querySelector('#status').textContent.includes(result), result);
    assert.deepEqual(await page.evaluate(() => window.mockWallet.calls), methods.map(method => ({ method })));
    if (mode === 'ok') {
      await page.evaluate(() => window.mockWallet.emit('accountsChanged', ['0x000000000000000000000000000000000000d102']));
      assert.match(await page.locator('#status').textContent(), /invalidated/);
    }
  });
}

test('address-only host exposes no wallet job or bootstrap routes', async () => {
  assert.equal((await fetch(host.origin + '/wallet')).status, 404);
  assert.equal((await fetch(host.origin + '/bootstrap', { method: 'POST' })).status, 405);
});
