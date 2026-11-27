// Real-browser inspection: screenshots, console, network, overflow, a11y (axe), focus, reduced motion.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire('/tmp/clean/package.json');
const { chromium } = require('playwright-core');
const axeSrc = readFileSync('/tmp/audit/node_modules/axe-core/axe.min.js', 'utf8');
const base = process.env.BASE ?? 'http://127.0.0.1:3500';
const out = process.env.OUT ?? '/tmp/audit/shots';
mkdirSync(out, { recursive: true });
const routes = (process.env.ROUTES ?? '/,/agent,/proof,/demo,/pay').split(',');
const VPS = { desktop: [1440, 900], tablet: [820, 1180], mobile: [390, 844] };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const report = [];
for (const [vp, [w, h]] of Object.entries(VPS)) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  for (const r of routes) {
    const page = await ctx.newPage();
    const errs = [], reqs = [], bad = [];
    page.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 160)); });
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 160)));
    page.on('request', q => reqs.push(new URL(q.url()).host));
    page.on('response', s => { if (s.status() >= 400) bad.push(s.status() + ' ' + new URL(s.url()).pathname); });
    const t0 = Date.now();
    const resp = await page.goto(base + r, { waitUntil: 'networkidle' }).catch(e => ({ status: () => 'ERR ' + e.message.slice(0, 60) }));
    const ms = Date.now() - t0;
    const name = (r === '/' ? 'home' : r.slice(1).replace(/\//g, '_')) + '-' + vp;
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    await page.addScriptTag({ content: axeSrc });
    const m = await page.evaluate(async () => {
      const ax = await window.axe.run(document, { resultTypes: ['violations'] });
      const de = document.documentElement;
      const fonts = [...new Set([...document.querySelectorAll('h1,h2,p,button,a,td')].slice(0, 80).map(e => getComputedStyle(e).fontFamily.split(',')[0].trim()))];
      return {
        title: document.title, h1: document.querySelectorAll('h1').length, lang: de.lang,
        scrollW: de.scrollWidth, clientW: de.clientWidth, overflowX: de.scrollWidth > de.clientWidth + 1,
        interactive: document.querySelectorAll('a,button,input,select,textarea').length,
        smallTargets: [...document.querySelectorAll('a,button')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.height < 24 || b.width < 24); }).length,
        imgsNoAlt: [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).length,
        fonts, bodyBg: getComputedStyle(document.body).backgroundColor, textLen: document.body.innerText.length,
        axe: ax.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      };
    });
    report.push({ route: r, vp, status: resp.status?.(), ms, ...m, console: errs, hosts: [...new Set(reqs)], badResponses: bad });
    await page.close();
  }
  await ctx.close();
}
// Reduced motion + keyboard focus on home (desktop)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const p = await ctx.newPage();
await p.goto(base + '/', { waitUntil: 'networkidle' });
const anim = await p.evaluate(() => {
  let running = 0, total = 0;
  for (const a of document.getAnimations()) { total++; if (a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity) running++; }
  return { total, infiniteRunning: running };
});
const focus = [];
for (let i = 0; i < 12; i++) {
  await p.keyboard.press('Tab');
  focus.push(await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { tag: e.tagName, text: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30), outline: cs.outlineStyle + ' ' + cs.outlineWidth, shadow: cs.boxShadow.slice(0, 40) }; }));
}
report.push({ route: 'reduced-motion+keyboard(/)', anim, focus });
await ctx.close(); await browser.close();
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 1));
console.log('pages inspected:', report.filter(r => r.vp).length);
