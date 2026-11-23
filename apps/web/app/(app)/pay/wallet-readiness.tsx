'use client';

import { useState } from 'react';

export default function WalletReadiness() {
  const [state, setState] = useState('Wallet and Celo network unchecked');
  async function inspect() {
    setState('Checking wallet status…');
    const provider = (window as Window & { ethereum?: { request(input: {method: string}): Promise<unknown> } }).ethereum;
    if (!provider || typeof provider.request !== 'function') { setState('Wallet provider unavailable'); return; }
    try {
      const chain = await provider.request({ method: 'eth_chainId' });
      setState(chain === '0xa4ec' ? 'Wallet provider available on Celo Mainnet. Account access unchecked.' : 'Wallet provider is not on Celo Mainnet.');
    } catch { setState('Wallet network unavailable'); }
  }
  return <><button type="button" className="btn secondary" onClick={inspect}>Check wallet network</button><p role="status">{state}</p>
    <p>USDt balance, gas reserve and confirmed allowance are unchecked. Conversion and payout are not ready.</p></>;
}
