import type { RegistrationReview } from './registration.ts';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { address } from './invoice.ts';
import { walletBoundary } from './wallet-boundary.ts';

const shell = '<!doctype html><meta charset="utf-8"><title>Daidai local wallet bridge</title><h1>Daidai wallet bridge</h1><button id="start">Start local session</button><p id="status"></p><script type="module" src="/entry.js"></script>';
const entry = `
import {browserWallet} from '/browser-wallet.ts';
const expected = document.querySelector('#registration');
const reviewed = expected && JSON.parse(expected.textContent);
const fragment = location.hash.slice(1);
history.replaceState(null, '', '/');
const status = document.querySelector('#status');
let stop = () => {};
let cancelled = false;
document.querySelector('#cancel')?.addEventListener('click', () => {
  cancelled = true;
  stop();
  document.querySelector('#start').disabled = true;
  status.textContent = 'Cancelled locally. If MetaMask already opened, reject there. Reconcile any uncertain submission.';
});
document.querySelector('#start').addEventListener('click', async () => {
  try {
    document.querySelector('#start').disabled = true;
    const provider = window.ethereum;
    if (!provider || (reviewed && (!provider.isMetaMask || provider.providers?.length > 1))) {
      throw Error('Unambiguous injected MetaMask unavailable');
    }
    const response = await fetch('/bootstrap', {method:'POST', headers:{Authorization:'Bearer '+fragment}});
    if (!response.ok) throw Error('Bootstrap denied');
    const {token,sender} = await response.json();
    const wallet = browserWallet({provider,token,sender,endpoint:'/wallet',
      registration:reviewed?.transaction, review:job=>Promise.resolve(!cancelled && confirm('Review the exact local wallet job:\\n'+JSON.stringify(job,null,2)))});
    const interval = setInterval(() => wallet.step().catch(() => {
      clearInterval(interval); wallet.dispose(); status.textContent='Local wallet session stopped';
    }), 250);
    stop = () => {clearInterval(interval);wallet.dispose();};
    addEventListener('pagehide', stop, {once:true});
    if (cancelled) { stop(); return; }
    status.textContent='Local session started. Only previously permitted account access is used.';
  } catch {status.textContent='Local session could not start';}
}, {once:true});
`;

export async function startWalletHost(senderAddress: string, registration?: {
  review: RegistrationReview; start: () => void; port: number;
}) {
  const page = registration
    ? shell.replace('Daidai wallet bridge</h1>', 'Daidai single ERC-8004 registration</h1>')
      .replace('<button id="start">Start local session</button>',
        '<pre id="registration">' + JSON.stringify(registration.review, null, 2)
          .replaceAll('&', '&amp;').replaceAll('<', '&lt;') +
        '</pre><p>Review all fields before starting. Keep the same account and chain. ' +
        'Reject any wallet prompt that differs from the reviewed intent.</p>' +
        '<button id="start">Start reviewed registration</button> <button id="cancel">Cancel</button>')
    : shell;
  const sender = address(senderAddress);
  const asset = new Map<string, string>([['/entry.js', entry]]);
  for (const file of ['browser-wallet.ts', 'taker-schema.ts']) {
    asset.set('/' + file, stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), 'utf8')));
  }
  const bootstrap = randomBytes(32).toString('hex');
  const expected = Buffer.from('Bearer ' + bootstrap);
  let bootstrapped = false;
  let origin = '';
  let boundary: ReturnType<typeof walletBoundary>;
  const server = createServer(async (req, res) => {
    function reply(status: number, body = '', type = 'text/plain') {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(body);
    }
    try {
      if (!origin || req.headers.host !== new URL(origin).host) return reply(403);
      const path = req.url;
      if (req.method === 'GET' && path === '/') return reply(200, page, 'text/html; charset=utf-8');
      if (req.method === 'GET' && path && asset.has(path)) return reply(200, asset.get(path), 'text/javascript');
      if (req.method !== 'POST' || req.headers.origin !== origin) return reply(403);
      if (path === '/bootstrap') {
        const supplied = Buffer.from(req.headers.authorization ?? '');
        if (bootstrapped || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return reply(403);
        bootstrapped = true;
        registration?.start();
        return reply(200, JSON.stringify({ token: boundary.token, sender }), 'application/json');
      }
      if (path !== '/wallet' || !bootstrapped) return reply(404);
      if (req.headers['content-type'] !== 'application/json') return reply(415);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return reply(413);
        chunks.push(chunk);
      }
      const response = await boundary.handle(new Request(origin + '/wallet', {
        method: 'POST', headers: { origin, authorization: req.headers.authorization ?? '' },
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      reply(response.status, await response.text(), 'application/json');
    } catch { if (!res.headersSent) reply(400); else res.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(registration?.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') { server.close(); throw Error('wallet host not bound'); }
  origin = 'http://127.0.0.1:' + bound.port;
  boundary = walletBoundary(origin, sender);
  return {
    origin, bootstrapUrl: origin + '/#' + bootstrap, provider: boundary.provider, signTaker: boundary.signTaker,
    async close() {
      boundary.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
