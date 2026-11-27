import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/tmp/clean/package.json'); const { chromium } = require('playwright-core');
const W='/tmp/clean/workers/api', WEB='/tmp/clean/apps/web', out='/tmp/audit/shots-product'; mkdirSync(out,{recursive:true});
const id=JSON.parse(readFileSync(W+'/.wrangler/demo-identities.json','utf8'));
const wait=async(u,ok=r=>r.status<500)=>{for(let i=0;i<80;i++){try{if(ok(await fetch(u,{redirect:'manual'})))return}catch{}await new Promise(r=>setTimeout(r,500))}throw Error('timeout '+u)};
const kill=p=>{try{process.kill(-p.pid,'SIGTERM')}catch{}};
const worker=spawn('npm',['run','dev'],{cwd:W,env:{...process.env,DAIDAI_AUDIENCE:id.audience},stdio:'ignore',detached:true});
const web=spawn('npx',['next','start','--hostname','127.0.0.1','--port','3410'],{cwd:WEB,detached:true,stdio:'ignore',env:{...process.env,DAIDAI_API_BASE_URL:'http://127.0.0.1:8787',DAIDAI_SERVICE_KEY_ID:id.service.keyId,DAIDAI_SERVICE_KEY:id.service.secret,DAIDAI_APP_ENABLED:'1',DAIDAI_LOCAL_PRODUCT:'1',DAIDAI_LOCAL_TEXTILE_PREVIEW:'0'}});
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const res=[];
try{
  await wait('http://127.0.0.1:8787/v1/health',r=>r.status===401); await wait('http://127.0.0.1:3410/');
  const base='http://127.0.0.1:3410';
  for(const [vp,[w,h]] of Object.entries({desktop:[1440,900],tablet:[820,1180],mobile:[390,844]})){
    const ctx=await b.newContext({viewport:{width:w,height:h}}); const p=await ctx.newPage();
    const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,140))}); p.on('pageerror',e=>errs.push(String(e).slice(0,140)));
    await p.goto(base+'/login'); await p.screenshot({path:`${out}/login-${vp}.png`,fullPage:true});
    await p.getByLabel('Invitation code').fill(id.invitations['demo-viewer'][['desktop','tablet','mobile'].indexOf(vp)]);
    await Promise.all([p.waitForURL('**/invoices'),p.locator('button[type=submit]').click()]);
    for(const [n,u] of [['invoices','/invoices'],['invoice-detail','/invoices/inv-a2'],['invoice-new','/invoices/new'],['activity','/activity'],['pay','/pay']]){
      const r=await p.goto(base+u,{waitUntil:'networkidle'}); await p.screenshot({path:`${out}/${n}-${vp}.png`,fullPage:true});
      res.push({vp,u,status:r.status(),ovf:await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1),title:await p.title()});
    }
    res.push({vp,errors:errs}); await ctx.close();
  }
}catch(e){console.log('ERR',e.message)} finally{await b.close();kill(web);kill(worker)}
console.log(JSON.stringify(res));
