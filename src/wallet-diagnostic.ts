import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { oneUseBootstrap } from './localhost-bootstrap.ts';

const entry = `
import { bootstrapWallet, detectWallets, legacyWalletGate, startupStatus, takeBootstrapFragment } from '/wallet-startup.js';
const button = document.querySelector('button');
const status = document.querySelector('#status');
const legacy = document.querySelector('#legacy');
const rpc = document.querySelector('#rpc');
const page = document.querySelector('main');
const { expected } = page.dataset;
const ticket = takeBootstrapFragment();
const detected = detectWallets(window);
button.disabled = false;
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    legacy.textContent = 'P08B.18 provider gate in this session: ' + legacyWalletGate(window.ethereum);
    const provider = detected.pick(window.ethereum);
    const session = await bootstrapWallet(ticket());
    if (session.expected !== expected) throw Error('unexpected diagnostic response');
    const chain = await provider.request({ method: 'eth_chainId' });
    if (chain !== '0xa4ec') { status.textContent = 'WRONG_CHAIN — Select Celo Mainnet (42220). Bootstrap passed.'; return; }
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
      status.textContent = 'ACCOUNT_NOT_SHARED — MetaMask has no previously shared account for this origin. Bootstrap passed.';
      return;
    }
    if (accounts[0].toLowerCase() !== expected) {
      status.textContent = 'WRONG_ACCOUNT — Select the enrolled Daidai account. Bootstrap passed.';
      return;
    }
    status.textContent = 'PASS — MetaMask detected, bootstrap authenticated, and ' + expected + ' verified on Celo Mainnet (42220).';
    try {
      const head = await provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
      const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
      if (!head || !quantity.test(head.number) || !quantity.test(head.timestamp) || !/^0x[0-9a-f]{64}$/i.test(head.hash)) throw Error('invalid head');
      const age = Math.floor(Date.now() / 1000) - Number(BigInt(head.timestamp));
      if (age < -10 || age > 60) { rpc.textContent = 'RPC_STALE — Latest block age: ' + age + ' seconds.'; return; }
      const balance = await provider.request({ method: 'eth_getBalance', params: [expected, head.number] });
      if (!quantity.test(balance)) throw Error('invalid balance');
      if (await provider.request({ method: 'eth_chainId' }) !== '0xa4ec' ||
        (await provider.request({ method: 'eth_accounts' }))[0]?.toLowerCase() !== expected) {
        rpc.textContent = 'RPC_CONTEXT_CHANGED — Account or chain changed during the check.';
        return;
      }
      rpc.textContent = 'RPC_PASS — Block ' + BigInt(head.number) + ' · age ' + age +
        ' s · balance ' + BigInt(balance) + ' wei CELO · hash ' + head.hash;
    } catch { rpc.textContent = 'RPC_FAILED — MetaMask could not return a valid recent block and balance.'; }
  } catch (error) { status.textContent = startupStatus(error); }
  finally { detected.close(); }
}, {once:true});
`;

export async function startWalletDiagnostic(expected: string, options: { port?: number; durationMs?: number } = {}) {
  if (!/^0x[0-9a-f]{40}$/i.test(expected) || /^0x0{40}$/i.test(expected)) throw Error('Supply a nonzero public address.');
  const account = expected.toLowerCase();
  const bootstrap = oneUseBootstrap(Date.now() + (options.durationMs ?? 300_000));
  const startup = stripTypeScriptTypes(readFileSync(new URL('./wallet-startup.ts', import.meta.url), 'utf8'));
  const page = `<!doctype html><meta charset="utf-8"><title>Daidai MetaMask startup diagnostic</title>
<main data-expected="${account}">
<h1>Daidai MetaMask startup diagnostic</h1>
<p>This local diagnostic checks previously granted access to ${account} on Celo Mainnet (42220). It does not open a wallet permission or transaction prompt.</p>
<button disabled>Run read-only check</button><p id="status" role="status">Waiting to run.</p><p id="legacy"></p><p id="rpc" role="status"></p></main>
<script type="module" src="/entry.js"></script>`;
  let origin = '';
  const server = createServer((req, res) => {
    function reply(status: number, body = '', type = 'text/plain') {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(body);
    }
    if (req.url === '/bootstrap') {
      const { status, code } = bootstrap.consumeRequest(req, origin);
      return reply(status, JSON.stringify(status === 200 ? { expected: account } : { code }), 'application/json');
    }
    if (!origin || req.headers.host !== new URL(origin).host) return reply(403);
    if (req.method === 'GET') {
      if (req.url === '/') return reply(200, page, 'text/html; charset=utf-8');
      if (req.url === '/entry.js') return reply(200, entry, 'text/javascript');
      if (req.url === '/wallet-startup.js') return reply(200, startup, 'text/javascript');
      return reply(404);
    }
    return reply(404);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') { server.close(); throw Error('Diagnostic host not bound.'); }
  origin = 'http://127.0.0.1:' + bound.port;
  return { origin, bootstrapUrl: origin + '/#' + bootstrap.ticket, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }) };
}
