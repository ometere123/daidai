import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { amount, parseAtomic, phase, fixtures } from '../app/model.ts';

const base = 'http://127.0.0.1:3219';
const output = process.env.PLUMB_SCREENSHOTS;
let browser;
before(async () => {
  const executablePath = process.env.DAIDAI_CHROMIUM_PATH ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath, args: ['--disable-extensions'] });
  if (output) mkdirSync(output, {recursive: true});
});
after(async () => { await browser?.close(); });

test('amounts stay exact and inconsistent evidence cannot settle', () => {
  assert.equal(amount(150000000001n,'cNGN'),'150,000.000001\u00a0cNGN');
  assert.equal(amount(102480000n,'USDt'),'102.48\u00a0USDt');
  assert.equal(parseAtomic('1.000001'),1000001n);
  assert.equal(parseAtomic('1.0000001'),null);
  const i = fixtures(0).at(-1);
  assert.equal(phase(i),'Settled');
  assert.equal(phase({...i,evidence:{...i.evidence,amount:i.target-1n}}),'Needs reconciliation');
  assert.equal(phase({...i,evidence:{...i.evidence,recipient:'0xother'}}),'Needs reconciliation');
  assert.equal(phase({...i,flow:'converted'}),'Needs you');
});

const views = [
  ['dashboard','/','Invoices'],
  ['details','/?invoice=INV-0042','Amaka'],
  ['receipt','/?invoice=INV-0032&view=progress','Settled'],
];
for (const width of [375, 768, 1440]) {
  test('layout and screenshot at '+width+' px',async t=>{
    const page=await browser.newPage({viewport:{width,height:950},reducedMotion:'reduce'});
    t.after(()=>page.close());
    for (const [name,url,title] of views) {
      await page.goto(base+url);
      await page.getByRole('heading',{level:1,name:new RegExp(title)}).waitFor();
      await page.evaluate(()=>document.fonts.ready);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' overflows at '+width);
      if (output) await page.screenshot({path:join(output,name+'-'+width+'.png'),fullPage:true});
    }
  });
}

test('keyboard dialog focus returns and an empty invoice list is accessible',async t=>{
  const page=await browser.newPage();
  t.after(()=>page.close());
  await page.goto(base+'/?data=empty');
  await page.getByRole('heading',{name:'No invoices yet'}).waitFor();
  const newButton = page.getByRole('button',{name:'New invoice'}).first();
  await newButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.locator('button:focus').filter({hasText:'New invoice'}).waitFor();
});

test('expiry disables conversion and uncertain payout offers no retry or wallet dispatch',async t=>{
  const page=await browser.newPage();
  t.after(()=>page.close());
  await page.addInitScript(()=>{
    window.walletCalls=[];
    window.ethereum={request(args){ window.walletCalls.push(args); throw Error('Unexpected wallet path'); }};
  });
  await page.clock.install();
  await page.goto(base+'/?invoice=INV-0042');
  await page.getByRole('heading',{level:1,name:/Amaka/}).waitFor();
  await page.clock.fastForward(45000);
  await page.locator(".plumb-instrument:visible > .plumb-gauge > p").filter({hasText:/Quote expired at/}).waitFor();
  await page.goto(base+'/?invoice=INV-0039&view=progress');
  await page.getByRole('alert').filter({hasText:/outcome is uncertain/}).waitFor();
  assert.equal(await page.getByRole('button',{name:/retry/i}).count(),0);
  assert.deepEqual(await page.evaluate(()=>window.walletCalls),[]);
});

test('conversion and payout decisions stay in the demo and submission stays unsettled', async t => {
  const page = await browser.newPage({viewport:{width:740,height:375}, reducedMotion:'reduce'});
  t.after(() => page.close());
  await page.addInitScript(() => {
    window.walletCalls = [];
    window.ethereum = { request(input) { window.walletCalls.push(input); throw Error('Live wallet dispatch'); } };
  });
  await page.goto(base+'/?invoice=INV-0042');
  await page.getByRole('button',{name:/Review conversion/}).click();
  await page.getByRole('button',{name:'Simulate conversion approval'}).click();
  await page.getByText(/Amaka.*has not been paid/i).waitFor();
  await page.getByRole('button',{name:/review.*payout/i}).click();
  await page.getByRole('button',{name:'Simulate payout submission'}).click();
  assert.equal(await page.getByRole('heading',{level:1,name:'Settled',exact:true}).count(),0);
  assert.deepEqual(await page.evaluate(()=>window.walletCalls),[]);
  await page.evaluate(()=>document.documentElement.style.fontSize='200%');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'large text overflows in landscape');
});
