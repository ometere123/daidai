'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  currentStage, demoSpender, formatTokenAmount, missingSignatures, parseAtomic, phase, quoteState, settled, signaturesValid,
  stages, UNIT, type Invoice, type Signed,
} from './model';
import { Address, countdown, returnFocus, DemoEvidence, PlumbBob, StatusGlyph, StatusMark, TokenAmount, watDate, watTime, type Mark } from './ui';

type Kind = 'allowance' | 'conversion' | 'payout';
type Props = {
  invoice: Invoice; now: number; update: (invoice: Invoice) => void;
  go: (id: string | undefined, view?: 'detail' | 'progress') => void;
  announce: (message: string) => void;
};
const fixtureQuote = { pay: 102_480_000n, fee: 200_000n };
const num = (id: string) => id.replace(/^INV-/, '');
const plainUSDt = (v: bigint) => formatTokenAmount(v, 'USDt').split(' ')[0].replaceAll(',', '');

// ---------------------------------------------------------------- shared pieces

/** The sticky bottom bar: one-line status on the left, the one next action on the right. */
export function ActionBar({ status, children }: { status: ReactNode; children?: ReactNode }) {
  // Hide while the on-screen keyboard is open so the bar never covers the field being edited.
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => setKeyboard(vv.height < window.innerHeight * 0.75 && document.activeElement instanceof HTMLInputElement);
    vv.addEventListener('resize', check);
    return () => vv.removeEventListener('resize', check);
  }, []);
  return <section className={'action-bar' + (keyboard ? ' kb-hidden' : '')} aria-label="Next step">
    <p className="action-status">{status}</p>
    {children ? <div className="action-buttons">{children}</div> : null}
  </section>;
}

/** The ink target slab: the fixed amount, stated once, on every invoice screen. */
function TargetSlab({ invoice, now, openSignatures }: { invoice: Invoice; now: number; openSignatures: () => void }) {
  const valid = signaturesValid(invoice, now);
  const missing = missingSignatures(invoice, now);
  return <section className="slab" aria-labelledby="slab-title">
    <PlumbBob size={22} onInk className="slab-mark" />
    <div className="slab-body">
      <h1 id="slab-title" className="slab-sentence">
        {invoice.recipient} receives exactly <span className="nowrap"><TokenAmount value={invoice.target} unit="cNGN" className="display-amount" /></span>
      </h1>
      <p className="slab-peg">Pegged to ₦{formatTokenAmount(invoice.target, 'cNGN').split(' ')[0]}. {invoice.id}.</p>
      <button type="button" className={'slab-link' + (valid ? '' : ' warn')} onClick={openSignatures}>
        {valid ? 'Invoice signed by approver and recipient (demo)' : missing.join('; ') + ' (demo)'}<span aria-hidden="true"> ›</span>
      </button>
    </div>
  </section>;
}

/** Sheet listing both halves of the SignedAuthorization (src/authorization.ts). */
function SignatureSheet({ invoice, now, open, onOpenChange }: { invoice: Invoice; now: number; open: boolean; onOpenChange: (v: boolean) => void }) {
  const rows: [string, Signed | undefined, string][] = [
    ['Invoice approval', invoice.auth.approval, invoice.approver],
    ['Recipient consent', invoice.auth.consent, invoice.recipient],
  ];
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay" />
      <Dialog.Content className="dialog sheet" {...returnFocus}>
        <span className="sheet-handle" aria-hidden="true" />
        <Dialog.Title className="dialog-title">Invoice signatures for {invoice.id}</Dialog.Title>
        <Dialog.Description className="meta">
          Daidai needs two invoice-bound EIP-712 signatures (domain “Daidai invoice authorization”) before it prepares any payment. This demo shows fixtures; it collects no signatures.
        </Dialog.Description>
        {rows.map(([title, s, who]) => {
          const state = !s ? 'Missing' : s.expiresAtMs <= now ? 'Expired' : 'Verified (demo)';
          return <section key={title} className="sig">
            <h3 className="sig-title"><StatusMark mark={state === 'Verified (demo)' ? 'confirmed' : 'waiting'}>{title}: {state}</StatusMark></h3>
            <DemoEvidence>
              <dl className="kv">
                <dt>Signer</dt><dd>{who}</dd>
                <dt>Invoice digest</dt><dd className="mono">demo-digest-{num(invoice.id)}</dd>
                <dt>Purpose</dt><dd className="mono">{title === 'Invoice approval' ? 'invoice approval' : 'recipient consent'}</dd>
                <dt>Audience</dt><dd className="mono">demo origin</dd>
                <dt>expiresAtMs</dt><dd>{s ? watDate.format(s.expiresAtMs) + ' WAT' : 'Not signed'}</dd>
              </dl>
            </DemoEvidence>
          </section>;
        })}
        <div className="dialog-foot"><Dialog.Close className="btn secondary">Close</Dialog.Close></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Review dialog shown before any (simulated) wallet step. Never opens a wallet. */
function ReviewDialog({ invoice, kind, onClose, onConfirm, blocked }: { invoice: Invoice; kind: Kind | null; onClose: () => void; onConfirm: () => void; blocked?: string }) {
  const q = invoice.quote;
  const title = kind === 'allowance' ? 'Allow Textile to use up to ' + formatTokenAmount(invoice.cap, 'USDt')
    : kind === 'conversion' ? 'Convert ' + (q ? formatTokenAmount(q.pay, 'USDt') : 'USDt') + ' to ' + formatTokenAmount(invoice.target, 'cNGN')
      : 'Send ' + formatTokenAmount(invoice.target, 'cNGN') + ' to ' + invoice.recipient;
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!kind) setBusy(false); }, [kind]);
  return <Dialog.Root open={kind !== null} onOpenChange={v => { if (!v) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay" />
      <Dialog.Content className="dialog sheet" {...returnFocus}>
        <span className="sheet-handle" aria-hidden="true" />
        <Dialog.Title className="dialog-title">{title}</Dialog.Title>
        <Dialog.Description className="meta">Demo review. This never opens a wallet, signs or moves funds.</Dialog.Description>
        <table className="review-table">
          <tbody>
            <tr><th scope="row">What moves</th><td>{kind === 'allowance' ? <>Nothing. This authorizes a spender up to <TokenAmount value={invoice.cap} unit="USDt" />; it doesn’t spend USDt.</>
              : kind === 'conversion' && q ? <><TokenAmount value={q.pay} unit="USDt" /> all-in (includes the <TokenAmount value={q.fee} unit="USDt" /> quote fee) for exactly <TokenAmount value={invoice.target} unit="cNGN" /></>
                : <>Exactly <TokenAmount value={invoice.target} unit="cNGN" /></>}</td></tr>
            <tr><th scope="row">From / to</th><td>{kind === 'allowance' ? <>Daidai taker wallet → spender Textile <Address value={demoSpender} label="Textile spender address" /></>
              : kind === 'conversion' ? <>USDt from the Daidai taker wallet → cNGN back to the Daidai taker wallet. {invoice.recipient} is paid in a separate step.</>
                : <>Daidai taker wallet → {invoice.recipient} <Address value={invoice.wallet} label={invoice.recipient + ' wallet address'} /></>}</td></tr>
            <tr><th scope="row">Who signs</th><td>{invoice.operator}, the Daidai operator, with the Daidai taker wallet</td></tr>
            <tr><th scope="row">Network fee</th><td>About <span className="mono">0.004 CELO</span> (simulated), outside the USDt limit</td></tr>
          </tbody>
        </table>
        {blocked ? <p className="field-error" role="alert">{blocked}</p> : null}
        <div className="dialog-foot">
          <Dialog.Close className="btn secondary">Cancel</Dialog.Close>
          <button type="button" className="btn primary" disabled={Boolean(blocked) || busy} onClick={() => { setBusy(true); onConfirm(); }}>
            {busy ? <><span className="spinner" aria-hidden="true" /> Simulating…</> : 'Simulate approval (demo)'}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

// ---------------------------------------------------------------- the Plumb Line gauge

const floor5 = (v: number) => Math.floor(v / 5) * 5;
const ceil5 = (v: number) => Math.ceil(v / 5) * 5;

export function PlumbLine({ invoice, now, requesting }: { invoice: Invoice; now: number; requesting: boolean }) {
  const q = invoice.quote;
  const state = requesting ? 'requesting' : quoteState(invoice, now);
  const limit = Number(invoice.cap) / Number(UNIT);
  const pay = q ? Number(q.pay) / Number(UNIT) : undefined;
  const lo = Math.max(0, floor5(Math.min(pay ?? limit, limit) * 0.93));
  const hi = Math.max(ceil5(limit * 1.05), pay ? ceil5(pay * 1.02) : 0, lo + 5);
  const at = (v: number) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * 100;
  const step = hi - lo > 60 ? Math.ceil((hi - lo) / 6 / 5) * 5 : 5;
  const ticks: number[] = []; for (let t = lo; t <= hi; t += step) ticks.push(t);
  const showNeedle = q && !q.invalid && state !== 'requesting' && state !== 'none';
  const left = q ? q.expires - now : 0;
  const headroom = q ? invoice.cap - q.pay : 0n;
  const text = state === 'requesting' ? 'Requesting a firm quote…'
    : state === 'none' ? 'No quote yet. Your limit is ' + formatTokenAmount(invoice.cap, 'USDt') + '.'
      : state === 'invalid' ? 'Daidai rejected this quote: it didn’t match the invoice.'
        : state === 'over' && q ? 'Needs ' + formatTokenAmount(q.pay, 'USDt') + ', over your ' + formatTokenAmount(invoice.cap, 'USDt') + ' limit. Daidai won’t continue.'
          : state === 'expired' && q ? 'Expired at ' + watTime.format(q.expires) + ' WAT. No USDt was spent on it.'
            : 'Within your limit. Holds ' + countdown(left) + '.';
  const urgent = state === 'held' && left <= 15_000;
  return <div className={'gauge gauge-' + state}>
    <div className="gauge-head" aria-hidden="true">
      <span>{q && state !== 'requesting' && !q.invalid ? <>Quote <TokenAmount value={q.pay} unit="USDt" tabular /> all-in</> : 'Quote'}</span>
      <span>Your limit <TokenAmount value={invoice.cap} unit="USDt" tabular /></span>
    </div>
    <div className="gauge-field" aria-hidden="true">
      <div className="gauge-track" />
      {ticks.map(t => <span key={t} className="gauge-tick" style={{ left: at(t) + '%' }}><span>{t}</span></span>)}
      <div className="gauge-hatch" style={{ left: at(limit) + '%' }} />
      <div className="gauge-stop" style={{ left: at(limit) + '%' }} />
      {state === 'requesting' ? <div className="gauge-crawl" /> : null}
      {showNeedle && pay !== undefined ? <div key={String(q?.pay) + String(q?.expires)} className={'gauge-needle needle-' + state} style={{ left: at(pay) + '%' }}><span className="needle-head" /></div> : null}
    </div>
    <div className="gauge-foot" aria-hidden="true">
      <span>USDt, from {lo}</span>
      {showNeedle && state !== 'over' ? <span>{formatTokenAmount(headroom, 'USDt')} headroom</span> : null}
    </div>
    <p className={'gauge-text' + (urgent ? ' urgent' : '') + (state === 'over' ? ' over' : '')}>{state === 'held' ? <>Within your limit. Holds <span className="tnum">{countdown(left)}</span>.</> : text}</p>
    <dl className="sr-only">
      <dt>All-in quote</dt><dd>{q && !q.invalid ? formatTokenAmount(q.pay, 'USDt') : 'No quote'}</dd>
      <dt>Your limit</dt><dd>{formatTokenAmount(invoice.cap, 'USDt')}</dd>
      {showNeedle && state !== 'over' ? <><dt>Headroom</dt><dd>{formatTokenAmount(headroom, 'USDt')}</dd></> : null}
      <dt>Status</dt><dd>{text}</dd>
    </dl>
  </div>;
}

function CostBreakdown({ invoice }: { invoice: Invoice }) {
  const q = invoice.quote && !invoice.quote.invalid ? invoice.quote : undefined;
  return <section className="panel" aria-labelledby="cost-h">
    <h2 id="cost-h" className="heading">Cost breakdown</h2>
    <table className="cost">
      <tbody>
        <tr><th scope="row">Recipient receives exactly</th><td><TokenAmount value={invoice.target} unit="cNGN" tabular /></td></tr>
        <tr><th scope="row">USDt required, all-in</th><td>{q ? <TokenAmount value={q.pay} unit="USDt" tabular /> : <span className="muted">Awaiting quote</span>}</td></tr>
        <tr className="sub"><th scope="row">includes quote fee</th><td>{q ? <TokenAmount value={q.fee} unit="USDt" tabular /> : '—'}</td></tr>
        <tr><th scope="row">Your spending limit</th><td><TokenAmount value={invoice.cap} unit="USDt" tabular /></td></tr>
        <tr><th scope="row">Network fees</th><td><span className="mono">~0.004 CELO</span> per step <span className="muted">(simulated)</span></td></tr>
      </tbody>
    </table>
    <p className="meta">The quote fee is already inside the all-in figure; it isn’t added twice. Network fees are paid in CELO, outside the USDt limit.</p>
  </section>;
}

function StageStrip({ current }: { current: number }) {
  return <div className="stage-strip">
    <ol className="stage-dots" aria-label="Invoice review steps">
      {stages.map((s, n) => <li key={s} className={n < current ? 'done' : n === current ? 'current' : ''} aria-current={n === current ? 'step' : undefined}>
        <span className="sr-only">{s}{n < current ? ', done' : n === current ? ', current' : ''}</span>
      </li>)}
    </ol>
    <p className="stage-name">{current >= stages.length ? 'All steps done' : 'Step ' + (current + 1) + ' of ' + stages.length + ': ' + stages[current]}</p>
  </div>;
}

function People({ invoice }: { invoice: Invoice }) {
  return <section className="panel" aria-labelledby="people-h">
    <h2 id="people-h" className="heading">People and roles</h2>
    <p className="you">You’re the Daidai operator on this invoice.</p>
    <dl className="people">
      <div><dt>Recipient</dt><dd><strong>{invoice.recipient}</strong><span className="meta">{invoice.recipientRole}, {invoice.recipientCity}. Receives the cNGN and signs the recipient consent.</span>
        <Address value={invoice.wallet} label={invoice.recipient + ' wallet address'} /></dd></div>
      <div><dt>Invoice approver</dt><dd><strong>{invoice.approver}</strong><span className="meta">Authorizes the spend. Not the onchain signer.</span></dd></div>
      <div><dt>Daidai operator</dt><dd><strong>{invoice.operator} (you)</strong><span className="meta">Controls the Daidai taker wallet and signs each onchain step.</span></dd></div>
    </dl>
  </section>;
}

// ---------------------------------------------------------------- Screen 2: invoice review

export function Detail({ invoice, now, update, go, announce }: Props) {
  const [review, setReview] = useState<Kind | null>(null);
  const [sigOpen, setSigOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [editLimit, setEditLimit] = useState(false);
  const [cap, setCap] = useState(() => plainUSDt(invoice.cap));
  const [error, setError] = useState('');
  const capInput = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const announced = useRef('');
  useEffect(() => () => clearTimeout(timer.current), []);
  const stage = currentStage(invoice, now);
  const qs = quoteState(invoice, now);
  const q = invoice.quote;
  const setup = invoice.flow === 'setup';
  const left = q ? q.expires - now : 0;

  // Announce quote milestones once: at 15 s and at expiry.
  useEffect(() => {
    const key = qs === 'held' && left <= 15_000 ? 'q15' : qs === 'expired' ? 'qexp' : '';
    if (key && announced.current !== key + String(q?.expires)) { announced.current = key + String(q?.expires); announce(key === 'q15' ? 'Quote expires in 15 seconds.' : 'This quote expired. No USDt was spent on it.'); }
  }, [qs, left, q?.expires, announce]);

  function saveCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const limit = parseAtomic(cap.trim());
    if (!limit || limit <= 0n) { setError('Enter a positive USDt limit with up to six decimal places.'); capInput.current?.focus(); return; }
    setError(''); setEditLimit(false);
    if (limit !== invoice.cap) { update({ ...invoice, cap: limit, quote: undefined }); announce('Limit saved at ' + formatTokenAmount(limit, 'USDt') + '. Get a new quote.'); }
  }
  function getQuote() {
    if (requesting) return;
    setRequesting(true); announce('Requesting a firm quote.');
    timer.current = setTimeout(() => {
      const nextQuote = { ...fixtureQuote, expires: Date.now() + 42_000 };
      update({ ...invoice, quote: nextQuote }); setRequesting(false);
      announce(nextQuote.pay <= invoice.cap ? 'Quote within your limit: ' + formatTokenAmount(nextQuote.pay, 'USDt') + ' all-in.' : 'Quote is over your limit.');
    }, 900);
  }
  function confirm() {
    const kind = review;
    if (kind === 'allowance') {
      setTimeout(() => { update({ ...invoice, allowance: invoice.cap }); setReview(null); announce('Allowance confirmed (demo). No USDt was spent.'); }, 400);
    } else if (kind === 'conversion' && qs === 'held' && invoice.allowance >= invoice.cap && signaturesValid(invoice, Date.now())) {
      setTimeout(() => { setReview(null); update({ ...invoice, flow: 'conversion-submitted' }); go(invoice.id, 'progress'); }, 400);
    } else setReview(null);
  }
  async function copyLink() {
    const text = 'Daidai (demo): signing request for ' + invoice.id + '. Demo only; nothing to sign.';
    try { await navigator.clipboard.writeText(text); announce('Demo signing link copied.'); } catch { announce('Clipboard unavailable in this browser.'); }
  }
  function openLimit() { setEditLimit(true); requestAnimationFrame(() => capInput.current?.focus()); }

  const missing = missingSignatures(invoice, now);

  // ---- the open stage
  let open: ReactNode = null;
  let bar: ReactNode;
  if (!setup) {
    open = <section className="panel stage-open"><h2 className="heading"><StatusMark mark="confirmed">Conversion approved (demo)</StatusMark></h2>
      <p>Preparation is closed for this invoice. Follow the settlement for what happens next.</p></section>;
    bar = <ActionBar status="Preparation closed"><button className="btn primary" onClick={() => go(invoice.id, 'progress')}>View settlement</button></ActionBar>;
  } else if (stage === 0) {
    const who = !invoice.auth.consent || invoice.auth.consent.expiresAtMs <= now ? invoice.recipient + '’s consent' : invoice.approver + '’s approval';
    open = <section className="panel stage-open" aria-labelledby="open-h">
      <h2 id="open-h" className="heading"><StatusMark mark="waiting">Waiting for {who} signature (demo)</StatusMark></h2>
      <p>Daidai won’t prepare a payment until both invoice-bound EIP-712 signatures (the approver’s approval and the recipient’s consent) are verified and unexpired.</p>
      <ul className="missing">{missing.map(m => <li key={m}>{m}.</li>)}</ul>
    </section>;
    bar = <ActionBar status="Waiting for signatures"><button className="btn primary" onClick={copyLink}>Copy signing link</button></ActionBar>;
  } else if (stage === 2) {
    open = <section className="panel stage-open" aria-labelledby="open-h">
      <h2 id="open-h" className="heading">Allow Textile to use up to <TokenAmount value={invoice.cap} unit="USDt" /> (demo)</h2>
      <p>This authorizes a spender. It doesn’t spend USDt. The allowance matches your spending limit for this invoice.</p>
      <dl className="kv">
        <dt>Current allowance</dt><dd><TokenAmount value={invoice.allowance} unit="USDt" tabular /></dd>
        <dt>Spender</dt><dd>Textile <Address value={demoSpender} label="Textile spender address" /></dd>
      </dl>
    </section>;
    bar = <ActionBar status="Allowance needed"><button className="btn primary" onClick={() => setReview('allowance')}>Review allowance</button></ActionBar>;
  } else {
    const heading = requesting ? 'Requesting a firm quote… (demo)' : qs === 'held' ? 'Quote within your limit (demo)' : qs === 'expired' ? 'This quote expired (demo)'
      : qs === 'over' ? 'Quote is over your limit (demo)' : qs === 'invalid' ? 'Daidai rejected this quote (demo)' : 'No quote available now (demo)';
    const line = requesting ? 'Daidai is asking for an exact-output quote for ' + formatTokenAmount(invoice.target, 'cNGN') + '.'
      : qs === 'held' && q ? formatTokenAmount(q.pay, 'USDt') + ' all-in for exactly ' + formatTokenAmount(invoice.target, 'cNGN') + '. An offer, not a payment.'
        : qs === 'expired' && q ? 'It ended at ' + watTime.format(q.expires) + ' WAT. No USDt was spent on it.'
          : qs === 'over' && q ? 'It needs ' + formatTokenAmount(q.pay, 'USDt') + '; your limit is ' + formatTokenAmount(invoice.cap, 'USDt') + '.'
            : qs === 'invalid' ? 'It didn’t match the invoice, so it can’t be used. No USDt was spent.'
              : 'The ' + formatTokenAmount(invoice.allowance, 'USDt') + ' allowance is still active. No USDt was spent.';
    open = <section className="panel stage-open" aria-labelledby="open-h">
      <h2 id="open-h" className={'heading' + (qs === 'over' ? ' text-error' : '')}>{heading}</h2>
      <p>{line}</p>
      <PlumbLine invoice={invoice} now={now} requesting={requesting} />
      {qs === 'held' || requesting ? null : <button type="button" className="quiet" onClick={() => { update({ ...invoice, allowance: 0n, quote: undefined }); announce('Allowance reduced to 0 (demo).'); }}>
        Reduce allowance to 0</button>}
    </section>;
    bar = requesting
      ? <ActionBar status="Requesting a firm quote…"><button className="btn primary" disabled><span className="spinner" aria-hidden="true" /> Requesting quote…</button></ActionBar>
      : qs === 'held' && q
        ? <ActionBar status={<span className={left <= 15_000 ? 'urgent' : ''}>Quote holds <span className="tnum">{countdown(left)}</span></span>}>
          <button className="btn primary" onClick={() => setReview('conversion')}>Review conversion: <TokenAmount value={q.pay} unit="USDt" /></button></ActionBar>
        : qs === 'over'
          ? <ActionBar status="Over your limit"><button className="btn primary" onClick={openLimit}>Edit limit</button></ActionBar>
          : <ActionBar status={qs === 'expired' ? 'Quote expired' : qs === 'invalid' ? 'Quote rejected' : 'No quote'}><button className="btn primary" onClick={getQuote}>Get a new quote</button></ActionBar>;
  }

  // ---- collapsed, completed stages
  const sigsDone = signaturesValid(invoice, now);
  const limitEditable = setup && sigsDone;
  const collapsed = <div className="stages-done">
    {sigsDone ? <details className="done-row">
      <summary><StatusGlyph mark="confirmed" /><span>Consent</span><span className="done-sum">Both signatures verified (demo)</span></summary>
      <div className="done-body"><p className="meta">Approval by {invoice.approver}; consent by {invoice.recipient}. Both expire {invoice.auth.consent ? watDate.format(invoice.auth.consent.expiresAtMs) + ' WAT' : ''}.</p>
        <button type="button" className="quiet" onClick={() => setSigOpen(true)}>View signatures</button></div>
    </details> : null}
    {sigsDone || stage > 1 ? <div className={'done-row limit-row' + (editLimit ? ' editing' : '')}>
      {!editLimit ? <div className="done-line"><StatusGlyph mark="confirmed" /><span>Spending limit</span><span className="done-sum"><TokenAmount value={invoice.cap} unit="USDt" tabular /></span>
        {limitEditable ? <button type="button" className="quiet" onClick={openLimit} aria-label="Edit spending limit">Edit</button> : null}</div>
        : <form onSubmit={saveCap} className="field" noValidate>
          <label htmlFor="cap" className="label">Spending limit, USDt all-in</label>
          <div className={'input-wrap' + (error ? ' invalid' : '')}>
            <input ref={capInput} id="cap" inputMode="decimal" autoComplete="off" value={cap} onChange={e => setCap(e.target.value)}
              aria-invalid={Boolean(error)} aria-describedby={'cap-help' + (error ? ' cap-err' : '')} />
            <span className="suffix" aria-hidden="true">USDt</span>
          </div>
          <p id="cap-help" className="meta">Includes the quote fee. Network fees are separate. Changing it clears the current quote.</p>
          {error ? <p id="cap-err" className="field-error" role="alert"><StatusGlyph mark="failed" /> {error}</p> : null}
          <div className="row-gap"><button className="btn secondary" type="submit">Save limit</button><button className="quiet" type="button" onClick={() => { setEditLimit(false); setError(''); setCap(plainUSDt(invoice.cap)); }}>Cancel</button></div>
        </form>}
    </div> : null}
    {stage > 2 ? <details className="done-row">
      <summary><StatusGlyph mark="confirmed" /><span>Allowance</span><span className="done-sum"><TokenAmount value={invoice.allowance} unit="USDt" tabular /> ready</span></summary>
      <div className="done-body"><p className="meta">Allowance <TokenAmount value={invoice.allowance} unit="USDt" />, not a cost. Spender Textile <Address value={demoSpender} label="Textile spender address" /></p></div>
    </details> : null}
  </div>;

  const blocked = review === 'conversion' && qs !== 'held' ? 'This quote no longer meets the invoice conditions. Get a new quote.' : undefined;
  return <div className="screen review">
    <TargetSlab invoice={invoice} now={now} openSignatures={() => setSigOpen(true)} />
    <StageStrip current={stage} />
    <div className="review-grid">
      <div className="decision">
        {open}
        <CostBreakdown invoice={invoice} />
      </div>
      <div className="facts">
        {collapsed}
        <People invoice={invoice} />
      </div>
    </div>
    {bar}
    <SignatureSheet invoice={invoice} now={now} open={sigOpen} onOpenChange={setSigOpen} />
    <ReviewDialog invoice={invoice} kind={review} onClose={() => setReview(null)} onConfirm={confirm} blocked={blocked} />
  </div>;
}

// ---------------------------------------------------------------- Screen 3: settlement and receipt

type Verdict = { tone: 'settled' | 'recon' | 'error' | 'ink' | 'paper'; mark: Mark; headline: string; line: ReactNode; alert?: boolean };
function verdict(i: Invoice): Verdict {
  const t = formatTokenAmount(i.target, 'cNGN');
  if (settled(i)) return { tone: 'settled', mark: 'settled', headline: 'Settled (demo)', line: i.recipient + ' received exactly ' + t + '. Difference 0.00 cNGN.' };
  switch (i.flow) {
    case 'verified': return { tone: 'recon', mark: 'recon', alert: true, headline: 'Needs reconciliation: amounts differ (demo)',
      line: 'Found ' + formatTokenAmount(i.evidence?.amount ?? 0n, 'cNGN') + ' at the recipient’s wallet; the invoice is ' + t + '. Not settled.' };
    case 'uncertain': return { tone: 'recon', mark: 'recon', alert: true, headline: 'Needs reconciliation (demo)',
      line: 'Daidai can’t confirm whether the payout landed. Retrying is blocked to avoid paying twice.' };
    case 'conversion-submitted': return { tone: 'ink', mark: 'submitted', headline: 'Conversion submitted, waiting for confirmation… (demo)', line: 'Don’t start another payment for this invoice.' };
    case 'conversion-confirmed': return { tone: 'ink', mark: 'confirmed', headline: 'Conversion confirmed, waiting for finality… (demo)', line: 'Confirmed in a block; Daidai waits for the agreed confirmations before the next step.' };
    case 'converted': return { tone: 'ink', mark: 'needs-you', headline: t + ' is in the Daidai taker wallet (demo)', line: i.recipient + ' has not been paid. The payout is a separate approval.' };
    case 'payout-declined': return { tone: 'paper', mark: 'waiting', headline: 'You declined in your wallet (demo)', line: 'Daidai didn’t receive a transaction hash. If a transaction was broadcast anyway, it will appear in the check.' };
    case 'payout-submitted': return { tone: 'ink', mark: 'submitted', headline: 'Payout submitted, waiting for confirmation… (demo)', line: 'Don’t start another payment for this invoice. ' + i.recipient + ' is not marked paid until the payout is verified.' };
    case 'payout-reverted': return { tone: 'error', mark: 'failed', alert: true, headline: 'The payout didn’t complete (demo)', line: 'It reverted onchain. ' + t + ' is still in the Daidai taker wallet. The network fee was used.' };
    case 'checked': return { tone: 'paper', mark: 'confirmed', headline: 'Checked: the payout did not land (demo)', line: t + ' is still in the Daidai taker wallet. A retry is now safe.' };
    default: return { tone: 'ink', mark: 'waiting', headline: 'Not started (demo)', line: 'Conversion hasn’t been approved yet.' };
  }
}

function VerdictBand({ invoice }: { invoice: Invoice }) {
  const v = verdict(invoice);
  const [drop, setDrop] = useState(false);
  useEffect(() => {
    if (v.tone !== 'settled') return;
    try { const k = 'daidai-settled-' + invoice.id; if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, '1'); setDrop(true); } } catch { /* storage unavailable */ }
  }, [v.tone, invoice.id]);
  return <section className={'verdict tone-' + v.tone + (drop ? ' first' : '')} aria-labelledby="verdict-h">
    <div className="verdict-top"><PlumbBob size={22} onInk={v.tone !== 'paper'} className="verdict-mark" /><StatusMark mark={v.mark}>{invoice.id}</StatusMark></div>
    <h1 id="verdict-h" className="title">{v.headline}</h1>
    <p className="verdict-line" role={v.alert ? 'alert' : undefined}>{v.line}</p>
    <p className="verdict-demo">(demo record: not onchain)</p>
  </section>;
}

function Recon({ invoice }: { invoice: Invoice }) {
  const e = invoice.evidence;
  const checked = Boolean(e);
  const pending = !checked && invoice.flow !== 'uncertain';
  const recipientOk = e?.recipient.toLowerCase() === invoice.wallet.toLowerCase();
  const diff = e ? e.amount - invoice.target : undefined;
  const isSettled = settled(invoice);
  const notYet = <span className="muted">{pending ? 'Not checked yet' : 'Not found yet'}</span>;
  return <section className="sheet-doc recon" aria-labelledby="recon-h">
    <h2 id="recon-h" className="heading">Reconciliation</h2>
    <table className="ledger">
      <thead><tr><th scope="col">Check</th><th scope="col">Invoice</th><th scope="col">Found (demo)</th></tr></thead>
      <tbody>
        <tr><th scope="row">Recipient</th><td>{invoice.recipient}<br /><span className="mono small" translate="no">{invoice.wallet.slice(0, 6)}…{invoice.wallet.slice(-4)}</span></td>
          <td>{!checked ? notYet : recipientOk ? <span className="match"><StatusGlyph mark="settled" /> matches (demo)</span> : <span className="mismatch"><StatusGlyph mark="recon" /> different address</span>}</td></tr>
        <tr><th scope="row">Amount</th><td><TokenAmount value={invoice.target} unit="cNGN" tabular /></td>
          <td>{!e ? notYet : <><TokenAmount value={e.amount} unit="cNGN" tabular /> {diff === 0n ? <span className="match"><StatusGlyph mark="settled" /> matches (demo)</span> : <span className="mismatch"><StatusGlyph mark="recon" /> differs</span>}</>}</td></tr>
        <tr><th scope="row">Payout</th><td>One exact cNGN transfer</td>
          <td>{isSettled ? <span className="mono small">demo-tx-{num(invoice.id)}-pay</span> : e ? <span className="mono small">demo-tx-{num(invoice.id)}-pay</span> : notYet}</td></tr>
        <tr className="difference"><th scope="row">Difference</th><td></td><td>{diff === undefined ? <span className="muted">Unknown</span> : <TokenAmount value={diff} unit="cNGN" tabular minFraction={2} />}</td></tr>
      </tbody>
    </table>
  </section>;
}

function Cost({ invoice }: { invoice: Invoice }) {
  const debited = invoice.flow !== 'setup' && invoice.flow !== 'conversion-submitted' && invoice.flow !== 'conversion-confirmed';
  const spent = invoice.evidence?.debit ?? invoice.quote?.pay;
  return <section className="panel" aria-labelledby="costr-h">
    <h2 id="costr-h" className="heading">Cost</h2>
    {spent !== undefined ? <p className="cost-sentence">{debited ? 'Spent ' : 'Quoted '}<TokenAmount value={spent} unit="USDt" />{debited ? ', within your ' : ', not yet final. Your limit is '}<TokenAmount value={invoice.cap} unit="USDt" />{debited ? ' limit.' : '.'}</p> : null}
    <table className="cost">
      <tbody>
        <tr><th scope="row">{debited ? 'USDt debited' : 'USDt quoted'}</th><td>{spent !== undefined ? <TokenAmount value={spent} unit="USDt" tabular /> : '—'}</td></tr>
        <tr className="sub"><th scope="row">includes quote fee</th><td>{invoice.quote ? <TokenAmount value={invoice.quote.fee} unit="USDt" tabular /> : '—'}</td></tr>
        <tr><th scope="row">Recipient target</th><td><TokenAmount value={invoice.target} unit="cNGN" tabular /></td></tr>
      </tbody>
    </table>
    <DemoEvidence><p className="small">Network fees <span className="mono">0.0068 CELO</span> (simulated), paid outside the USDt limit.</p></DemoEvidence>
  </section>;
}

const demoEpoch = Date.UTC(2026, 10, 21, 13, 4, 0);
type Step = { title: string; detail: string; mark: Mark; at?: number; tx?: string };
function TxEvidence({ id, tx, fee }: { id: string; tx: string; fee: string }) {
  return <details className="evidence">
    <summary>Evidence</summary>
    <DemoEvidence>
      <dl className="kv">
        <dt>Transaction</dt><dd className="mono">demo-tx-{num(id)}-{tx}</dd>
        <dt>Block</dt><dd>demo block</dd>
        <dt>Network fee</dt><dd><span className="mono">{fee}</span> (simulated)</dd>
      </dl>
      <button type="button" className="btn secondary small-btn" disabled aria-describedby={'cs-' + tx + num(id)}>View on Celoscan (unavailable in demo)</button>
      <p id={'cs-' + tx + num(id)} className="meta">Demo transactions don’t exist on Celo, so there is nothing to look up.</p>
    </DemoEvidence>
  </details>;
}

function Timeline({ invoice, open }: { invoice: Invoice; open: boolean }) {
  const f = invoice.flow;
  const base = demoEpoch + Number(num(invoice.id)) * 60_000;
  const convertedDone = !['setup', 'conversion-submitted', 'conversion-confirmed'].includes(f);
  const payoutSent = ['payout-submitted', 'uncertain', 'verified', 'payout-reverted'].includes(f);
  const done = settled(invoice);
  const phases: { title: string; steps: Step[]; bridge?: string }[] = [
    { title: 'Get ready', steps: [
      { title: 'Invoice signatures', detail: 'Approval and recipient consent verified (demo)', mark: 'confirmed', at: base },
      { title: 'Spending limit', detail: formatTokenAmount(invoice.cap, 'USDt') + ' all-in', mark: 'confirmed', at: base + 60_000 },
      { title: 'Allowance', detail: formatTokenAmount(invoice.allowance, 'USDt') + ' for Textile. Authorization, not spend', mark: 'confirmed', at: base + 120_000, tx: 'allow' },
    ] },
    { title: 'Convert', bridge: convertedDone ? formatTokenAmount(invoice.target, 'cNGN') + ' reached the Daidai taker wallet. ' + invoice.recipient + ' was not paid by this step.' : undefined, steps: [
      { title: 'Exact-output quote', detail: invoice.quote ? formatTokenAmount(invoice.quote.pay, 'USDt') + ' all-in for exactly ' + formatTokenAmount(invoice.target, 'cNGN') : 'No quote', mark: 'confirmed', at: base + 180_000 },
      { title: 'Conversion', detail: f === 'conversion-submitted' ? 'Submitted, waiting for confirmation' : f === 'conversion-confirmed' ? 'Confirmed, waiting for finality' : 'Final',
        mark: f === 'conversion-submitted' ? 'submitted' : 'confirmed', at: base + 240_000, tx: 'conv' },
    ] },
    { title: 'Send', steps: [
      { title: 'Payout to ' + invoice.recipient, mark: done ? 'confirmed' : f === 'payout-reverted' ? 'failed' : f === 'uncertain' ? 'recon' : payoutSent ? 'submitted' : f === 'converted' || f === 'checked' || f === 'payout-declined' ? 'needs-you' : 'waiting',
        detail: done ? 'Confirmed' : f === 'payout-reverted' ? 'Reverted onchain' : f === 'uncertain' ? 'Outcome unknown' : f === 'verified' ? 'Found, amount differs' : f === 'payout-submitted' ? 'Submitted, waiting for confirmation'
          : f === 'payout-declined' ? 'Declined in wallet' : f === 'checked' ? 'Checked: did not land' : f === 'converted' ? 'Needs your approval' : 'Waiting for the conversion',
        at: payoutSent ? base + 600_000 : undefined, tx: payoutSent ? 'pay' : undefined },
    ] },
    { title: 'Check', steps: [
      { title: 'Reconcile recipient and amount', mark: done ? 'settled' : f === 'uncertain' || f === 'verified' ? 'recon' : 'waiting',
        detail: done ? 'Exact payout matched (demo)' : f === 'uncertain' || f === 'verified' ? 'Needs reconciliation' : 'Not checked yet', at: done ? base + 660_000 : undefined },
    ] },
  ];
  if (!convertedDone) phases.splice(2);
  const fees: Record<string, string> = { allow: '0.0017 CELO', conv: '0.0038 CELO', pay: '0.0013 CELO' };
  return <details className="timeline panel" open={open}>
    <summary className="heading">How it settled{settled(invoice) ? '' : ' so far'}</summary>
    {phases.map(p => <section key={p.title} className="tl-phase">
      <h3 className="label">{p.title}</h3>
      <ol>{p.steps.map(s => <li key={s.title} className="tl-step">
        <span className="tl-mark"><StatusGlyph mark={s.mark} /></span>
        <div className="tl-body"><p className="tl-title">{s.title}</p><p className="meta">{s.detail}</p>
          {s.tx ? <TxEvidence id={invoice.id} tx={s.tx} fee={fees[s.tx]} /> : null}</div>
        {s.at ? <time className="meta tl-time" dateTime={new Date(s.at).toISOString()}>{watTime.format(s.at).slice(0, 5)} WAT</time> : null}
      </li>)}</ol>
      {p.bridge ? <p className="bridge">{p.bridge}</p> : null}
    </section>)}
  </details>;
}

export function Progress({ invoice, update, go, announce }: Props) {
  const [review, setReview] = useState<'payout' | null>(null);
  const isSettled = settled(invoice);
  const f = invoice.flow;
  const recon = phase(invoice) === 'Needs reconciliation';
  const evidenceRef = useId();

  // Demo-only: a submitted conversion confirms, then becomes final. The payout is never auto-settled.
  useEffect(() => {
    if (f !== 'conversion-submitted' && f !== 'conversion-confirmed') return;
    const t = setTimeout(() => {
      const next = f === 'conversion-submitted' ? 'conversion-confirmed' as const : 'converted' as const;
      update({ ...invoice, flow: next });
      announce(next === 'converted' ? formatTokenAmount(invoice.target, 'cNGN') + ' is in the Daidai taker wallet. ' + invoice.recipient + ' has not been paid.' : 'Conversion confirmed, waiting for finality.');
    }, 1400);
    return () => clearTimeout(t);
  }, [f, invoice, update, announce]);

  async function share() {
    const text = 'Daidai (demo) receipt ' + invoice.id + ': ' + invoice.recipient + ' received exactly ' + formatTokenAmount(invoice.target, 'cNGN') + '. Demo record, not onchain.';
    try {
      if (navigator.share) await navigator.share({ title: 'Daidai (demo) — ' + invoice.id, text });
      else { await navigator.clipboard.writeText(text); announce('Demo receipt summary copied.'); }
    } catch { announce('Sharing unavailable. Use Save PDF instead.'); }
  }
  function showEvidence() {
    const el = document.getElementById(evidenceRef)?.querySelector('details');
    if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); el.querySelector('summary')?.focus(); }
  }
  function confirmPayout() {
    setTimeout(() => { setReview(null); update({ ...invoice, flow: 'payout-submitted' }); announce('Payout submitted (demo). Waiting for confirmation.'); }, 400);
  }

  const bar = isSettled
    ? <ActionBar status="Receipt (demo)"><button className="btn secondary" onClick={() => window.print()}>Save PDF</button><button className="btn primary" onClick={share}>Share receipt</button></ActionBar>
    : f === 'converted' || f === 'checked' ? <ActionBar status={f === 'checked' ? 'Retry is safe' : invoice.recipient + ' not paid yet'}><button className="btn primary" onClick={() => setReview('payout')}>Review payout</button></ActionBar>
      : f === 'payout-reverted' ? <ActionBar status="Revert confirmed"><button className="btn primary" onClick={() => setReview('payout')}>Review payout again</button></ActionBar>
        : f === 'payout-declined' ? <ActionBar status="No transaction hash"><button className="btn primary" onClick={() => { update({ ...invoice, flow: 'checked' }); announce('Checked (demo): the payout did not land.'); }}>Check status</button></ActionBar>
          : recon ? <ActionBar status="Retry blocked to avoid paying twice"><button className="btn primary" onClick={showEvidence}>View evidence</button></ActionBar>
            : f === 'setup' ? <ActionBar status="Not started"><button className="btn primary" onClick={() => go(invoice.id, 'detail')}>Open invoice review</button></ActionBar>
              : <ActionBar status="Daidai is watching for confirmation" />;

  return <div className="screen receipt">
    <div className="print-head" aria-hidden="true"><PlumbBob size={20} /> <span className="print-word">Daidai</span> <span>Demo receipt {invoice.id}</span></div>
    <VerdictBand invoice={invoice} />
    <div className="receipt-grid">
      <div className="receipt-main"><Recon invoice={invoice} /></div>
      <div className="receipt-side">
        <Cost invoice={invoice} />
        <div id={evidenceRef} className="timeline-wrap"><Timeline invoice={invoice} open={!isSettled} /></div>
      </div>
    </div>
    {bar}
    <div className="print-watermark" aria-hidden="true">DEMO, NOT A RECORD OF PAYMENT</div>
    <ReviewDialog invoice={invoice} kind={review} onClose={() => setReview(null)} onConfirm={confirmPayout} />
  </div>;
}
