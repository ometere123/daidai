import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const page = `<!doctype html><meta charset="utf-8"><title>Daidai address-only check</title>
<main><h1>Verify MetaMask address</h1><p>Expected account <code id="expected"></code> on Celo mainnet (42220).</p>
<p>Clicking below requests the eth_accounts permission through eth_requestAccounts. MetaMask can share the public addresses you authorize for this local page. Daidai checks the active address and chain.</p>
<button id="verify" disabled>Request public account access</button><p id="status" role="status">Checking for MetaMask.</p></main>
<script type="module" src="/entry.js"></script>`;
const entry = `
import {addressCheck} from '/address-check.js';
const button = document.querySelector('#verify');
const status = document.querySelector('#status');
const {expected} = await (await fetch('/config.json')).json();
document.querySelector('#expected').textContent = expected;
const found = new Set();
addEventListener('eip6963:announceProvider', ({detail}) => {
  if (detail?.info?.rdns === 'io.metamask' && detail.provider?.isMetaMask === true) found.add(detail.provider);
});
dispatchEvent(new Event('eip6963:requestProvider'));
const pick = () => {
  if (found.size === 1) return [...found][0];
  if (found.size === 0 && window.ethereum?.isMetaMask === true && !window.ethereum.providers) return window.ethereum;
};
button.disabled = false;
status.textContent = 'Select the expected account and Celo mainnet in MetaMask, then request access.';
let check;
button.addEventListener('click', async () => {
  button.disabled = true;
  const provider = pick();
  if (!provider) {status.textContent = 'No unambiguous MetaMask provider found. Reload to try again.'; return;}
  try {
    check = addressCheck(provider, expected, () => {
      status.textContent = 'Verification invalidated. Reload after checking your account and network.';
    });
    const result = await check.requestAddress();
    status.textContent = 'Verified public address ' + result.address + ' on Celo mainnet (42220).';
  } catch (error) {
    status.textContent = error instanceof Error && /^(Select Celo|MetaMask returned|Account or network changed|Account access was declined)/.test(error.message)
      ? error.message : 'Address verification failed. Reload to try again.';
  }
});
addEventListener('pagehide', () => check?.dispose(), {once:true});
`;

export async function startAddressHost(expected: string) {
  if (!/^0x[0-9a-f]{40}$/i.test(expected) || /^0x0{40}$/i.test(expected)) throw Error('Supply a nonzero public address.');
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', page]],
    ['/entry.js', ['text/javascript', entry]],
    ['/address-check.js', ['text/javascript', stripTypeScriptTypes(readFileSync(new URL('./address-check.ts', import.meta.url), 'utf8'))]],
    ['/config.json', ['application/json', JSON.stringify({ expected: expected.toLowerCase() })]],
  ]);
  let host = '';
  const server = createServer((req, res) => {
    const asset = req.url && assets.get(req.url);
    const status = !host || req.headers.host !== host ? 403 : req.method !== 'GET' ? 405 : asset ? 200 : 404;
    res.writeHead(status, {
      'Content-Type': status === 200 && asset ? asset[0] : 'text/plain', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    });
    res.end(status === 200 && asset ? asset[1] : '');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw Error('Address host not bound.'); }
  host = '127.0.0.1:' + address.port;
  return { origin: 'http://' + host, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }) };
}
