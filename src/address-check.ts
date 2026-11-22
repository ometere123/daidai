const celoChain = '0xa4ec';
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) &&
  !/^0x0{40}$/i.test(value);

type Listener = (value?: unknown) => void;
export interface AccountProvider {
  request(input: { method: 'eth_chainId' | 'eth_requestAccounts' | 'eth_accounts' }): Promise<unknown>;
  on(event: string, listener: Listener): unknown;
  removeListener(event: string, listener: Listener): unknown;
}

export function addressCheck(provider: AccountProvider, expected: string, onInvalidate: () => void) {
  if (!isAddress(expected)) throw Error('Expected address must be a nonzero EVM address.');
  const pinned = expected.toLowerCase();
  let phase: 'ready' | 'prompt' | 'verified' | 'invalid' = 'ready';
  function invalidate() {
    if (phase === 'invalid') return;
    phase = 'invalid';
    onInvalidate();
  }
  const current = () => phase !== 'invalid';
  const matches = (accounts: unknown) => Array.isArray(accounts) && isAddress(accounts[0]) &&
    accounts[0].toLowerCase() === pinned;
  const accountChanged: Listener = value => {
    // MetaMask can emit the newly authorized account as permission is granted.
    if (phase !== 'prompt' || !matches(value)) invalidate();
  };
  provider.on('accountsChanged', accountChanged);
  provider.on('chainChanged', invalidate);
  provider.on('disconnect', invalidate);

  return {
    async requestAddress() {
      if (phase !== 'ready') throw Error('This check is already in use or invalid. Reload to try again.');
      phase = 'prompt';
      try {
        if (await provider.request({ method: 'eth_chainId' }) !== celoChain || !current()) {
          throw Error('Select Celo mainnet (42220) in MetaMask first.');
        }
        const granted = await provider.request({ method: 'eth_requestAccounts' });
        if (!current()) throw Error('Account or network changed.');
        if (!matches(granted)) throw Error('MetaMask returned an unexpected account.');
        const accounts = await provider.request({ method: 'eth_accounts' });
        const chainId = await provider.request({ method: 'eth_chainId' });
        if (!current() || !matches(accounts) || chainId !== celoChain) throw Error('Account or network changed.');
        phase = 'verified';
        return { address: pinned, chainId: 42220 } as const;
      } catch (error) {
        invalidate();
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 4001) {
          throw Error('Account access was declined.');
        }
        throw error;
      }
    },
    dispose() {
      invalidate();
      provider.removeListener('accountsChanged', accountChanged);
      provider.removeListener('chainChanged', invalidate);
      provider.removeListener('disconnect', invalidate);
    },
  };
}
