'use client';

import { useEffect, useState } from 'react';

export function ShareFragment({ merchant = false }: { merchant?: boolean }) {
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(fragment)) return;
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    setCode(fragment);
  }, []);
  if (merchant) return code ? <div>
    <button className="btn" type="button" onClick={async () => {
      try { await navigator.clipboard.writeText(new URL('/pay#' + code, window.location.origin).href); setNotice('Payment link copied.'); }
      catch { setNotice('Copy the link using the browser link menu.'); }
    }}>Copy payment link</button>{' '}
    <a href={'/pay#' + code}>Open payer review</a><p role="status">{notice}</p>
  </div> : null;
  return <form action="/api/product" method="post">
    <input type="hidden" name="kind" value="redeem" />
    <label>Payment link code<br /><input name="code" value={code} onChange={event => setCode(event.target.value)} required minLength={43} maxLength={43} autoComplete="off" className="mono" /></label>
    <button className="btn" type="submit">Review shared invoice</button>
  </form>;
}
