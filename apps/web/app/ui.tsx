'use client';

import { useState, type ReactNode } from 'react';
import { formatNumber, type Token } from './model';

/** The Daidai wordmark: Schibsted 600, the dots of both i's replaced by level brass diamonds. */
export function Wordmark({ onInk = false, className = '' }: { onInk?: boolean; className?: string }) {
  const i = <span className="wm-i" aria-hidden="true">ı<span className="wm-dot" /></span>;
  return <span className={'wordmark' + (onInk ? ' on-ink' : '') + (className ? ' ' + className : '')}>
    <span className="sr-only">Daidai</span>
    <span aria-hidden="true">Da</span>{i}<span aria-hidden="true">da</span>{i}
  </span>;
}

/** The plumb bob: a hairline into a brass diamond whose point lands on an ink baseline. */
export function PlumbBob({ size = 20, onInk = false, line = true, className = '' }: { size?: number; onInk?: boolean; line?: boolean; className?: string }) {
  return <svg className={'plumb-bob' + (onInk ? ' on-ink' : '') + (className ? ' ' + className : '')} width={size * 0.75} height={size}
    viewBox="0 0 24 32" aria-hidden="true" focusable="false">
    {line ? <path className="pb-line" d="M12 0V9" /> : null}
    <path className="pb-weight" d="M12 9L16.5 19.5L12 28L7.5 19.5Z" />
    <path className="pb-base" d="M4 28H20" />
  </svg>;
}

/** Every amount in the product goes through this: tight proportional figures, unit at 0.62×, no tracking. */
export function TokenAmount({ value, unit, tabular = false, minFraction, className = '' }: { value: bigint; unit: Token; tabular?: boolean; minFraction?: number; className?: string }) {
  const number = formatNumber(value, unit, minFraction);
  return <span className={'amt' + (tabular ? ' tnum' : '') + (className ? ' ' + className : '')} translate="no">
    <span className="amt-n">{number}</span>{' '}<span className="amt-u">{unit}</span>
  </span>;
}

export type Mark = 'waiting' | 'needs-you' | 'submitted' | 'confirmed' | 'settled' | 'failed' | 'recon' | 'demo';
/** A 10 px drawn glyph. Always paired with a word by the caller; never colour alone. */
export function StatusGlyph({ mark }: { mark: Mark }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false, className: 'glyph glyph-' + mark } as const;
  switch (mark) {
    case 'waiting': return <svg {...common}><circle cx="6" cy="6" r="4.25" fill="none" strokeWidth="1.5" /></svg>;
    case 'needs-you': return <svg {...common}><path d="M6 1L10.5 6L6 11L1.5 6Z" /></svg>;
    case 'submitted': return <svg {...common}><circle cx="6" cy="6" r="4.25" fill="none" strokeWidth="1.5" /><path d="M6 1.75A4.25 4.25 0 0 1 6 10.25Z" /></svg>;
    case 'confirmed': return <svg {...common}><path d="M2 6.5L4.75 9L10 3" fill="none" strokeWidth="1.75" /></svg>;
    case 'settled': return <svg {...common}><circle cx="6" cy="6" r="5" fill="none" strokeWidth="1.25" /><path d="M3.5 6.2L5.3 8L8.6 4.3" fill="none" strokeWidth="1.5" /></svg>;
    case 'failed': return <svg {...common}><path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" fill="none" strokeWidth="1.75" /></svg>;
    case 'recon': return <svg {...common}><rect x="1" y="1" width="10" height="10" fill="none" strokeWidth="1.25" /><path d="M1 5L5 1M1 9L9 1M3 11L11 3M7 11L11 7" fill="none" strokeWidth="1" /></svg>;
    case 'demo': return <svg {...common}><path d="M6 1L10.5 6L6 11L1.5 6Z" fill="none" strokeWidth="1.25" strokeDasharray="1.6 1.4" /></svg>;
  }
}
export function StatusMark({ mark, children }: { mark: Mark; children: ReactNode }) {
  return <span className={'status-mark sm-' + mark}><StatusGlyph mark={mark} /><span>{children}</span></span>;
}

/** Mono address, first 6 and last 4, with a quiet Copy button and tap-to-expand. */
export function Address({ value, label }: { value: string; label: string }) {
  const [full, setFull] = useState(false);
  const [feedback, setFeedback] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(value); setFeedback('Copied'); }
    catch { setFeedback('Copy unavailable. Select the address instead'); }
  }
  return <span className="address">
    <button type="button" className="address-value mono" translate="no" aria-expanded={full} onClick={() => setFull(v => !v)}
      aria-label={(full ? 'Shorten ' : 'Show full ') + label}>
      {full ? value : value.slice(0, 6) + '…' + value.slice(-4)}
    </button>
    <button type="button" className="quiet" onClick={copy} aria-label={'Copy ' + label}>{feedback === 'Copied' ? 'Copied' : 'Copy'}</button>
    <span className="sr-only" aria-live="polite">{feedback}</span>
  </span>;
}

/** Everything that looks like chain evidence lives inside this violet dashed frame in demo mode. */
export function DemoEvidence({ children, label = 'Demo evidence' }: { children: ReactNode; label?: string }) {
  return <div className="demo-evidence"><span className="demo-evidence-label"><StatusGlyph mark="demo" /> {label}</span>{children}</div>;
}

export function DemoStrip() {
  return <div className="demo-strip" role="region" aria-label="Demo notice"><StatusGlyph mark="demo" /> Demo workspace. Nothing here happened onchain.</div>;
}

export const watTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const watDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const countdown = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/** Radix returns focus only to a Dialog.Trigger. Our dialogs open from ordinary buttons, so capture the opener
 *  when the dialog opens and return focus to it on close (if it still exists). */
let opener: HTMLElement | null = null;
export const returnFocus = {
  onOpenAutoFocus: () => { opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null; },
  onCloseAutoFocus: (event: Event) => { if (opener?.isConnected) { event.preventDefault(); opener.focus(); } },
};
