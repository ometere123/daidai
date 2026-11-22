import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { fromDataSuffix } from '@celo/attribution-tags';
import { registrationSession } from '../src/registration-host.ts';
import { code, sender, uri } from '../src/registration.ts';
import { CeloReader } from '../src/celo.ts';

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

const readers = {
  eth_chainId: '0xa4ec', eth_getCode: '0x', eth_estimateGas: '0x31cc2',
  eth_getBlockByNumber: { baseFeePerGas: '0x1' }, eth_getBalance: '0x100000000000000000',
  eth_call: '0x' + '01'.padStart(64, '0'), eth_getTransactionCount: '0x0',
};
const reader = new CeloReader(async method => {
  assert(Object.hasOwn(readers, method), method);
  return readers[method];
}, async () => ({ totalWei: 100n, rollupWei: 1n }));
const ceilings = { gas: 244764n, maxFeePerGas: 240100000000n, maxPriorityFeePerGas: 1000000n,
  totalWei: 58867836400000000n, rollupReserveWei: 100000000000000n };
const hash = '0x' + 'ab'.repeat(32);

for (const mode of ['success', 'reject', 'timeout', 'account', 'network', 'tamper', 'cancel', 'decline', 'nonce']) {
  test('isolated Chromium registration: ' + mode, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'daidai-registration-'));
    const options = { file: join(directory, 'lock.sqlite'), reader, ceilings, nonce: 0,
      expires: Date.now() + 120000, refresh: async () => mode === 'nonce' ? 1 : 0, approved: () => true,
      timeoutMs: mode === 'timeout' ? 2500 : 5000 };
    const session = await registrationSession(options);
    assert(session.host);
    const page = await browser.newPage();
    t.after(async () => {
      await page.close();
      await session.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await page.addInitScript(({ mode, sender, hash }) => {
      const calls = [];
      const handlers = new Map();
      let accountsReads = 0;
      let chainReads = 0;
      window.calls = calls;
      window.ethereum = {
        isMetaMask: true,
        on(event, cb) { handlers.set(event, cb); },
        removeListener(event) { handlers.delete(event); },
        async request(input) {
          calls.push(structuredClone(input));
          if (input.method === 'eth_accounts') {
            if (++accountsReads === 3 && mode === 'account') {
              handlers.get('accountsChanged')?.();
              return ['0x0000000000000000000000000000000000000001'];
            }
            return [sender];
          }
          if (input.method === 'eth_chainId') {
            if (++chainReads === 3 && mode === 'network') {
              handlers.get('chainChanged')?.();
              return '0x1';
            }
            return '0xa4ec';
          }
          if (input.method === 'eth_sendTransaction') {
            if (mode === 'reject') throw Object.assign(Error('rejected'), { code: 4001 });
            if (mode === 'timeout') return new Promise(() => {});
            return hash;
          }
          throw Error('unexpected method');
        },
      };
    }, { mode, sender, hash });
    if (mode === 'tamper') {
      await page.route('**/wallet', async route => {
        const response = await route.fetch();
        const result = await response.json();
        if (result?.request?.method === 'eth_sendTransaction') {
          result.request.params[0].data += '00';
          await route.fulfill({ response, json: result });
        } else await route.fulfill({ response });
      });
    }
    page.on('dialog', dialog => mode === 'decline' ? dialog.dismiss() : dialog.accept());
    await page.goto(session.host.bootstrapUrl);
    assert.deepEqual(JSON.parse(await page.locator('#registration').textContent()), session.review);
    assert.equal(session.review.metadataURI, uri);
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    if (mode === 'cancel') {
      await page.locator('#cancel').click();
      assert(await page.locator('#start').isDisabled());
      assert.deepEqual(await page.evaluate(() => window.calls), []);
      return;
    }
    await page.locator('#start').click();
    const result = await session.result;
    const methods = await page.evaluate(() => window.calls);
    const sent = methods.filter(call => call.method === 'eth_sendTransaction');
    const attempt = await registrationSession({ ...options, approved: undefined });
    if (mode === 'success' || mode === 'reject' || mode === 'timeout') {
      assert.deepEqual(sent, [{ method: 'eth_sendTransaction', params: [session.review.transaction] }]);
      assert.deepEqual(fromDataSuffix(sent[0].params[0].data).codes, [code]);
    } else assert.deepEqual(sent, []);
    if (mode === 'success') assert.deepEqual(result, { status: 'hash_returned', hash });
    else if (mode === 'reject' || mode === 'decline') assert.equal(result.status, 'user_rejected');
    else if (mode === 'nonce') {
      assert.equal(result.status, 'blocked_before_wallet_dispatch');
      assert.deepEqual(methods, []);
    } else assert.equal(result.status, 'needs_reconciliation');
    if (mode !== 'nonce') {
      assert.equal(attempt.existing.status, result.status);
      const replay = await registrationSession(options);
      assert.equal(replay.host, undefined);
      assert.equal(replay.existing.status, result.status);
    }
  });
}
