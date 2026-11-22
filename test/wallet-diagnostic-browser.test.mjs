import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startWalletDiagnostic } from '../src/wallet-diagnostic.ts';

const account = '0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e';
let browser;
before(async () => {
  const executablePath = process.env.DAIDAI_CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find(existsSync);
  assert(executablePath, 'Set DAIDAI_CHROMIUM_PATH to an installed Chromium browser.');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-extensions'] });
});
after(async () => { await browser?.close(); });

const cases = [
  ['missing', 'PROVIDER_MISSING'],
  ['ambiguous', 'PROVIDER_AMBIGUOUS'],
  ['another-wallet', 'PROVIDER_NOT_METAMASK'],
  ['expired', 'BOOTSTRAP_EXPIRED'],
  ['rejected', 'BOOTSTRAP_MALFORMED'],
  ['no-fragment', 'BOOTSTRAP_MISSING'],
  ['reload', 'BOOTSTRAP_MISSING'],
  ['rpc-failed', 'PASS'],
  ['rpc-stale', 'PASS'],
  ['exception', 'STARTUP_EXCEPTION'],
  ['success', 'PASS'],
  ['announced', 'PASS'],
  ['wrong-chain', 'WRONG_CHAIN'],
  ['wrong-account', 'WRONG_ACCOUNT'],
  ['unshared', 'ACCOUNT_NOT_SHARED'],
];

for (const [mode, expected] of cases) {
  test('isolated Chromium wallet diagnostic: ' + mode, async t => {
    const host = await startWalletDiagnostic(account, { durationMs: mode === 'expired' ? 0 : undefined });
    const page = await browser.newPage();
    t.after(async () => { await page.close(); await host.close(); });
    await page.addInitScript(({ mode, account }) => {
      const calls = [];
      window.calls = calls;
      const wallet = {
        isMetaMask: mode !== 'another-wallet', on() {}, removeListener() {},
        async request({ method }) {
          calls.push(method);
          if (mode === 'exception') throw new Error('private error payload');
          if (method === 'eth_chainId') return mode === 'wrong-chain' ? '0x1' : '0xa4ec';
          if (method === 'eth_getBlockByNumber') {
            if (mode === 'rpc-failed') throw Error('Private RPC failure');
            return {number:'0x100',timestamp:'0x'+(Math.floor(Date.now()/1000)-(mode==='rpc-stale'?100:0)).toString(16),hash:'0x'+'ab'.repeat(32)};
          }
          if (method === 'eth_getBalance') return '0x1000';
          if (method === 'eth_accounts') {
            if (mode === 'unshared') return [];
            return [mode === 'wrong-account' ? '0x0000000000000000000000000000000000000001' : account];
          }
          throw Error('Unsupported provider method');
        },
      };
      if (mode === 'ambiguous' || mode === 'announced') {
        window.ethereum = { ...wallet, providers: [wallet, { ...wallet }] };
        if (mode === 'announced') addEventListener('eip6963:requestProvider', () => {
          dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail:{info:{rdns:'io.metamask'},provider:wallet}}));
        });
      } else if (mode !== 'missing') window.ethereum = wallet;
    }, { mode, account });
    if (mode === 'rejected') await page.route('**/bootstrap', async route => {
      const headers = { ...route.request().headers(), authorization: 'Bearer invalid' };
      await route.continue({ headers });
    });
    const path = ['missing', 'ambiguous', 'another-wallet'].includes(mode) ? false : true;
    let bootstrapRequests = 0;
    page.on('request', request => { if (request.url().endsWith('/bootstrap')) bootstrapRequests++; });
    await page.goto(mode === 'no-fragment' ? host.origin : host.bootstrapUrl);
    if (mode === 'reload') {
      await page.waitForFunction(() => location.hash === '');
      await page.reload();
    }
    const button = page.getByRole('button', { name: 'Run read-only check' });
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    await button.click();
    await page.waitForFunction(code => document.querySelector('#status').textContent.startsWith(code), expected);
    assert.equal(bootstrapRequests, path ? 1 : 0);
    if (['success','announced','rpc-failed','rpc-stale'].includes(mode)) {
      const expectedRpc = mode==='rpc-failed' ? 'RPC_FAILED' : mode==='rpc-stale' ? 'RPC_STALE' : 'RPC_PASS';
      await page.waitForFunction(code => document.querySelector('#rpc').textContent.startsWith(code), expectedRpc);
    }
    const methods = await page.evaluate(() => window.calls);
    if (['success','announced'].includes(mode)) {
      assert.deepEqual(methods,['eth_chainId','eth_accounts','eth_getBlockByNumber','eth_getBalance','eth_chainId','eth_accounts']);
    } else if (['rpc-failed','rpc-stale'].includes(mode)) {
      assert.deepEqual(methods,['eth_chainId','eth_accounts','eth_getBlockByNumber']);
    } else if (['wrong-account','unshared'].includes(mode)) {
      assert.deepEqual(methods, ['eth_chainId', 'eth_accounts']);
    } else if (mode === 'wrong-chain' || mode === 'exception') {
      assert.deepEqual(methods, ['eth_chainId']);
      assert.doesNotMatch(await page.locator('#status').textContent(), /private error payload/);
    } else assert.deepEqual(methods, []);
    if (mode === 'announced') assert.match(await page.locator('#legacy').textContent(), /PROVIDER_AMBIGUOUS/);
    assert.equal((await page.request.post(host.origin + '/wallet', { data: { action: 'poll' } })).status(), 404);
  });
}

test('diagnostic bootstrap enforces same-origin authentication and one-use ticket', async t => {
  const host = await startWalletDiagnostic(account);
  t.after(() => host.close());
  const ticket = new URL(host.bootstrapUrl).hash.slice(1);
  assert(ticket);
  async function status(origin, token) {
    const headers = { Origin: origin };
    if (token !== undefined) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(host.origin + '/bootstrap', { method:'POST', headers });
    return [response.status,(await response.json()).code];
  }
  assert.deepEqual(await status('https://unexpected.example', ticket), [403,'BOOTSTRAP_CONTEXT_MISMATCH']);
  assert.deepEqual(await status(host.origin), [403,'BOOTSTRAP_MISSING']);
  assert.deepEqual(await status(host.origin,'wrong'), [403,'BOOTSTRAP_MALFORMED']);
  assert.deepEqual(await status(host.origin,'0'.repeat(64)), [403,'BOOTSTRAP_INCORRECT']);
  assert.deepEqual(await status(host.origin,ticket), [200,undefined]);
  assert.deepEqual(await status(host.origin,ticket), [403,'BOOTSTRAP_CONSUMED']);
});
