import { checkTakerChallenge, takerWalletRequest, type TakerChallenge } from './taker-schema.ts';
export type RpcRequest = { method: string; params?: unknown[] };
export interface InjectedProvider {
  request(args: RpcRequest): Promise<unknown>;
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

export type WalletJob = { id: string; expires: number; request: RpcRequest; challenge?: TakerChallenge };

function assertScope(request: RpcRequest, sender: string) {
  if (request.method === 'eth_accounts' || request.method === 'eth_chainId') {
    if (request.params !== undefined) throw Error('unexpected wallet parameters');
    return;
  }
  const tx = request.params?.[0] as { from?: string; chainId?: string } | undefined;
  if (request.method !== 'eth_sendTransaction' || request.params?.length !== 1 ||
    tx?.from !== sender || tx.chainId !== '0xa4ec') throw Error('unsupported wallet request');
}

// Invoke from the browser only. Review must present the exact job and obtain explicit human assent.
export function browserWallet(options: {
  provider: InjectedProvider; sender: string; token: string; endpoint: string;
  review: (job: Readonly<WalletJob>) => Promise<boolean>; transport?: typeof fetch; clock?: () => number;
}) {
  const { provider, sender, token, endpoint, review } = options;
  const transport = options.transport ?? fetch;
  const clock = options.clock ?? Date.now;
  let invalid = false;
  let busy = false;
  const invalidate = () => { invalid = true; };
  const events = ['accountsChanged', 'chainChanged', 'disconnect'];
  for (const event of events) provider.on(event, invalidate);

  async function exchange(body: object) {
    const response = await transport(endpoint, { method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (!response.ok) throw Error('wallet session request denied');
    return response.json();
  }

  async function step() {
    if (invalid || busy) return;
    busy = true;
    try {
      const job = await exchange({ action: 'poll' }) as WalletJob | null;
      if (!job) return;
      try {
        if (job.challenge) {
          checkTakerChallenge(job.challenge, sender, clock());
          const expected = takerWalletRequest(job.challenge);
          if (JSON.stringify(job.request) !== JSON.stringify(expected)) throw Error('unexpected Textile payload');
        } else assertScope(job.request, sender);
        if (job.challenge || job.request.method === 'eth_sendTransaction') {
          // Pass a separate copy to review so it cannot edit the request being approved.
          if (invalid || clock() >= job.expires || !(await review(structuredClone(job)))) {
            await exchange({ action: 'complete', id: job.id, error: 4001 });
            return;
          }
          const accounts = await provider.request({ method: 'eth_accounts' });
          const chain = await provider.request({ method: 'eth_chainId' });
          if (invalid || clock() >= job.expires || !Array.isArray(accounts) ||
            accounts[0]?.toLowerCase() !== sender || chain !== '0xa4ec') throw Error('wallet context changed');
        }
        if (invalid || clock() >= job.expires) throw Error('wallet job expired or invalidated');
        if (job.challenge) checkTakerChallenge(job.challenge, sender, clock());
        const result = await provider.request(job.request);
        await exchange({ action: 'complete', id: job.id, result });
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error && error.code === 4001 ? 4001 : 4900;
        await exchange({ action: 'complete', id: job.id, error: code });
      }
    } finally { busy = false; }
  }

  return { step, dispose() { invalidate(); for (const event of events) provider.removeListener(event, invalidate); } };
}
