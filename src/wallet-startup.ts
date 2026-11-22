type StartupCode = 'PROVIDER_MISSING' | 'PROVIDER_AMBIGUOUS' | 'PROVIDER_NOT_METAMASK' |
  'BOOTSTRAP_REJECTED' | 'BOOTSTRAP_EXPIRED' | 'STARTUP_EXCEPTION';

const messages: Record<StartupCode, string> = {
  PROVIDER_MISSING: 'MetaMask was not injected. Check its extension site access for this localhost address.',
  PROVIDER_AMBIGUOUS: 'More than one wallet matches. Check extension injection and try with a single MetaMask provider.',
  PROVIDER_NOT_METAMASK: 'The available injected wallet could not be identified as MetaMask.',
  BOOTSTRAP_REJECTED: 'Local session authorization was rejected. The one-use session may be invalid or already used.',
  BOOTSTRAP_EXPIRED: 'The local session expired before startup.',
  STARTUP_EXCEPTION: 'Local startup failed unexpectedly. No internal error details were displayed.',
};

class StartupError extends Error {
  readonly code: StartupCode;
  constructor(code: StartupCode) {
    super(messages[code]);
    this.code = code;
  }
}

type ProviderShape = { isMetaMask?: unknown; providers?: unknown; request?: unknown; on?: unknown; removeListener?: unknown };

function isProvider(value: unknown): value is ProviderShape {
  if (typeof value !== 'object' || !value) return false;
  const provider = value as ProviderShape;
  return typeof provider.request === 'function' && typeof provider.on === 'function' &&
    typeof provider.removeListener === 'function';
}

export function startupStatus(error: unknown) {
  const code = error instanceof StartupError ? error.code : 'STARTUP_EXCEPTION';
  return code + ' — ' + messages[code];
}

// This describes the old P08B.18 gate without using it to select a wallet.
export function legacyWalletGate(injected?: ProviderShape) {
  if (!injected) return 'PROVIDER_MISSING';
  if (!injected.isMetaMask) return 'PROVIDER_NOT_METAMASK';
  if (Array.isArray(injected.providers) && injected.providers.length > 1) return 'PROVIDER_AMBIGUOUS';
  return 'PASS';
}

export function detectWallets(target: EventTarget) {
  const announced = new Set<ProviderShape>();
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail?.info?.rdns === 'io.metamask' && isProvider(detail.provider) && detail.provider.isMetaMask === true) {
      announced.add(detail.provider);
    }
  };
  target.addEventListener('eip6963:announceProvider', listener);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return {
    pick(injected?: ProviderShape) {
      if (announced.size > 1) throw new StartupError('PROVIDER_AMBIGUOUS');
      if (announced.size === 1) return [...announced][0];
      if (!injected) throw new StartupError('PROVIDER_MISSING');
      if (Array.isArray(injected.providers) && injected.providers.length > 1) throw new StartupError('PROVIDER_AMBIGUOUS');
      if (!isProvider(injected) || injected.isMetaMask !== true) throw new StartupError('PROVIDER_NOT_METAMASK');
      return injected;
    },
    close() { target.removeEventListener('eip6963:announceProvider', listener); },
  };
}

export async function bootstrapWallet(ticket: string) {
  const response = await fetch('/bootstrap', { method: 'POST', headers: { Authorization: 'Bearer ' + ticket },
    redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 410) throw new StartupError('BOOTSTRAP_EXPIRED');
  if (response.status === 401 || response.status === 403) throw new StartupError('BOOTSTRAP_REJECTED');
  if (!response.ok) throw new StartupError('STARTUP_EXCEPTION');
  return response.json();
}
