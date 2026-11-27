import { createRequire } from 'node:module';
const { chromium } = createRequire('/tmp/clean/package.json')('playwright-core');
const base='http://127.0.0.1:3500', routes=['/','/agent','/proof','/demo','/pay'];
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}); const p=await b.newPage();
const seen=new Map();
for(const r of routes){ await p.goto(base+r,{waitUntil:'networkidle'});
  const links=await p.$$eval('a[href]',as=>as.map(a=>({h:a.getAttribute('href'),t:(a.innerText||a.getAttribute('aria-label')||'').trim().slice(0,30)})));
  for(const l of links){ if(!l.h.startsWith('/')) { if(!seen.has(l.h)) seen.set(l.h,{ext:true,from:[r],t:l.t}); continue;} const k=l.h.split('#')[0]; const e=seen.get(k)??{from:[],t:l.t}; e.from.push(r); seen.set(k,e);} }
for(const [h,e] of seen){ if(e.ext){console.log('EXT ',h.slice(0,70));continue;} const s=(await fetch(base+h,{redirect:'manual'})).status; console.log(String(s).padEnd(4),h.padEnd(26),'"'+e.t+'"','on',[...new Set(e.from)].length,'pages'); }
await b.close();
