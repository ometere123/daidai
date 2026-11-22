"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { amount, parseAtomic, phase, stepsRemaining, type Invoice } from "./model";
import "./settlement.css";

export const demoSpender = "0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3";
const unit = 1_000_000n;
const inputAmount = (value: bigint) => amount(value, "USDt").split("\u00a0")[0].replaceAll(",", "");
const fixtureQuote = { pay: 102_480_000n, fee: 200_000n };
const evidenceHash = (seed: string) => "0x" + seed.repeat(32);
type Props = { invoice: Invoice; now: number; update: (invoice: Invoice) => void; openReview: (kind: "allowance" | "conversion" | "payout") => void };

const localTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function Address({ value, label }: { value: string; label: string }) {
  const [feedback, setFeedback] = useState("");
  async function copyAddress() {
    try { await navigator.clipboard.writeText(value); setFeedback("Copied"); }
    catch { setFeedback("Select the address to copy it"); }
  }
  return <div className="plumb-address">
    <code translate="no">{value}</code>
    <button type="button" className="button" onClick={copyAddress} aria-label={"Copy " + label}> {feedback === "Copied" ? "Copied" : "Copy"}</button>
    {feedback && feedback !== "Copied" ? <small>{feedback}</small> : null}
  </div>;
}

function Instrument({ invoice, now, spent }: { invoice: Invoice; now: number; spent?: bigint }) {
  const quote = invoice.quote;
  const actual = spent ?? quote?.pay;
  const cap = Number(invoice.cap) / Number(unit);
  const pay = actual === undefined ? undefined : Number(actual) / Number(unit);
  const reference = pay === undefined ? cap : Math.min(pay, cap);
  const lower = Math.max(0.01, Math.floor(reference * 0.9 / 5) * 5);
  const upper = Math.max(lower + 5, Math.ceil(Math.max(cap * 1.05, (pay ?? 0) * 1.015) / 5) * 5);
  const position = (value: number) => 6 + Math.max(0, Math.min(1, (value - lower) / (upper - lower))) * 88;
  const boundary = position(cap);
  const needle = pay === undefined ? undefined : position(pay);
  const expired = spent === undefined && Boolean(quote && now >= quote.expires);
  const over = actual !== undefined && actual > invoice.cap;
  const remaining = quote ? Math.max(0, Math.ceil((quote.expires - now) / 1000)) : 0;
  const ticks = Array.from({ length: Math.min(24, Math.floor((upper - lower) / 5) + 1) }, (_, i) => lower + i * 5);
  const countdown = Math.floor(remaining / 60) + ":" + String(remaining % 60).padStart(2, "0");
  const status = spent !== undefined ? "Within the spending limit" : expired && quote
    ? "Quote expired at " + localTime.format(quote.expires) + " WAT"
    : over ? "Quote exceeds the spending limit" : quote ? "Within the spending limit · " + countdown + " remaining" : "No quote yet";
  return <section className="plumb-instrument panel" aria-label="Exact target and spending limit">
    <div className="plumb-target">
      <span className="plumb-target-mark" aria-hidden="true"><i /></span>
      <span className="plumb-instrument-label">Fixed target</span>
      <strong translate="no">{amount(invoice.target, "cNGN")}</strong>
      <span className="muted">{invoice.recipient} · {invoice.consent ? "Consent verified in demo" : "Consent pending"}</span>
    </div>
    <span className="plumb-link" aria-hidden="true"><span>costs</span><span className="plumb-arrow-horizontal">⟶</span><span className="plumb-arrow-vertical">↓</span></span>
    <div className="plumb-gauge">
      <div className="plumb-gauge-key" aria-hidden="true">
        <div><span className="plumb-dot" />{spent !== undefined ? "Spent" : "All-in quote"}<strong>{actual === undefined ? "—" : amount(actual, "USDt")}</strong></div>
        <div><span className="plumb-cap-dot" />Hard stop<strong>{amount(invoice.cap, "USDt")}</strong></div>
      </div>
      <svg className={over ? "plumb-over" : ""} viewBox="0 0 100 19" aria-hidden="true">
        <rect x={boundary} y="3" width={94 - boundary} height="11" className="plumb-over-zone" />
        <path d="M6 10H94" className="plumb-track" />
        {ticks.map(value => <path key={value} className="plumb-tick" d={`M${position(value)} 10v3.1`} />)}
        <path d={`M${boundary} 2.2v12.9`} className="plumb-hard-stop" />
        {needle === undefined ? null : <g className={expired ? "plumb-expired-needle" : "plumb-needle"}>
          <path d={`M${needle} 5v9`} />
          <path d={`M${needle} 1l1.7 1.7-1.7 1.7-1.7-1.7Z`} />
        </g>}
      </svg>
      <div className="plumb-axis" aria-hidden="true"><span>{lower.toLocaleString("en-GB")}</span><span>USDt · scale starts at {lower.toLocaleString("en-GB")}</span><span>{upper.toLocaleString("en-GB")}</span></div>
      <p className={quote && remaining > 0 && remaining <= 15 && spent === undefined ? "plumb-expiry" : "muted"}>{status}</p>
      <dl className="plumb-sr">
        <dt>Fixed recipient target</dt><dd>{amount(invoice.target, "cNGN")}</dd>
        <dt>{spent !== undefined ? "Spent" : "All-in quote"}</dt><dd>{actual === undefined ? "No quote yet" : amount(actual, "USDt")}</dd>
        <dt>USDt spending limit</dt><dd>{amount(invoice.cap, "USDt")}</dd>
        <dt>Status</dt><dd>{status}</dd>
      </dl>
    </div>
  </section>;
}

export function Detail({ invoice, now, update, openReview }: Props) {
  const [cap, setCap] = useState(() => inputAmount(invoice.cap));
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const capInput = useRef<HTMLInputElement>(null);
  useEffect(() => () => clearTimeout(quoteTimer.current), []);
  const quote = invoice.quote;
  const allowanceReady = invoice.allowance >= invoice.cap;
  const expired = Boolean(quote && now >= quote.expires);
  const over = Boolean(quote && quote.pay > invoice.cap);
  const setup = invoice.flow === "setup";
  const authorized = invoice.consent && setup;
  const canQuote = authorized && allowanceReady;
  const canConvert = canQuote && quote && !expired && !over && !requesting;
  function saveCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authorized || requesting) return;
    const limit = parseAtomic(cap.trim()) ?? 0n;
    if (limit <= 0n) { setError("Enter a positive USDt limit with up to six decimal places."); capInput.current?.focus(); return; }
    setError("");
    if (limit !== invoice.cap) update({ ...invoice, cap: limit, quote: undefined });
  }
  function getQuote() {
    if (!canQuote || requesting) return;
    setRequesting(true);
    quoteTimer.current = setTimeout(() => {
      update({ ...invoice, quote: { ...fixtureQuote, expires: Date.now() + 42_000 } });
      setRequesting(false);
    }, 350);
  }
  const quoteStatus = requesting ? "Preparing demo quote…" : !allowanceReady ? "Locked until the allowance covers the spending limit"
    : !quote ? "No quote yet" : expired ? "Quote expired. The allowance is still active." : over ? "Quote is over the spending limit"
      : "Demo quote is within the limit";
  const convertLabel = quote ? "Review conversion · " + amount(quote.pay, "USDt") : "Review conversion";
  const remaining = quote ? Math.ceil((quote.expires - now) / 1000) : 0;
  return <div className="plumb-settlement">
    <header className="plumb-page-title">
      <div><h1>{invoice.recipient} receives exactly <span translate="no">{amount(invoice.target, "cNGN")}</span></h1>
      <p>{invoice.id} <span aria-hidden="true">·</span> Target fixed when the invoice was created</p></div>
      <span className="plumb-lock" title="Fixed when the invoice was created"><LockKeyhole size={19} aria-hidden="true" /></span>
    </header>
    <div className="plumb-mobile-instrument"><Instrument invoice={invoice} now={now} /></div>
    <div className="plumb-detail-grid">
      <aside className="plumb-detail-facts">
        <section className="panel plumb-panel"><h2>Invoice facts</h2>
        <dl className="plumb-facts"><div><dt>Recipient</dt><dd>{invoice.recipient}</dd></div><div><dt>Invoice approver</dt><dd>{invoice.payer}</dd></div><div><dt>Onchain signer</dt><dd>Daidai operator</dd></div></dl>
        <h3>Recipient wallet</h3><Address value={invoice.wallet} label={invoice.recipient + "’s wallet address"} />
        <p className="muted">The operator uses the dedicated Daidai wallet to sign onchain. The invoice approver can be a different person.</p>
        <details className="plumb-disclosure">
          <summary>{invoice.consent ? "✓ Invoice consent verified in demo" : "Waiting for invoice consent"}</summary>
          <p>{invoice.consent ? "This fixture represents verified EIP-712 consent for this invoice commitment, recipient address, chain and expiry." : "The recipient must give invoice-bound EIP-712 consent before settlement preparation is available."} The demo does not collect signatures.</p>
        </details></section>
        <section className="panel plumb-panel"><h2>Cost breakdown</h2>
          <dl className="plumb-facts">
            <div><dt>Recipient receives exactly</dt><dd>{amount(invoice.target, "cNGN")}</dd></div>
            <div><dt>Total USDt required, all-in</dt><dd>{quote ? amount(quote.pay, "USDt") : "Awaiting quote"}</dd></div>
            <div className="plumb-included"><dt>Includes quote fee</dt><dd>{quote ? amount(quote.fee, "USDt") : "—"}</dd></div>
            <div><dt>Spending limit</dt><dd>{amount(invoice.cap, "USDt")}</dd></div>
            <div><dt>Illustrative network fee</dt><dd>~0.004 CELO / step</dd></div>
          </dl><p className="muted">Network fees are separate from the USDt limit.</p></section>
      </aside>
      <div className="plumb-detail-main">
        <div className="plumb-desktop-instrument"><Instrument invoice={invoice} now={now} /></div>
        {!invoice.consent ? <p role="alert" className="plumb-notice">Waiting for {invoice.recipient} to give consent for this invoice.</p> : null}
        {!setup ? <p className="plumb-notice">Conversion preparation is closed. Follow the settlement progress for this invoice.</p> : null}
        <section className="panel plumb-panel plumb-action-panel">
          <div className="plumb-step-heading"><span aria-hidden="true">1</span><h2>Spending limit</h2></div>
          <form onSubmit={saveCap}>
            <label htmlFor="plumb-cap">Maximum USDt spend</label>
            <div className="plumb-form-row"><input ref={capInput} id="plumb-cap" inputMode="decimal" value={cap} onChange={event => setCap(event.target.value)} disabled={!authorized} aria-invalid={Boolean(error)} aria-describedby={"plumb-cap-help" + (error ? " plumb-cap-error" : "")} /><button className="button" disabled={!authorized || requesting}>Save limit</button></div>
            <p id="plumb-cap-help" className="muted">Includes the quote fee. Network fees are separate.</p>
            {error ? <p id="plumb-cap-error" className="plumb-error" role="alert">{error}</p> : null}
          </form>
        </section>
        <section className="panel plumb-panel plumb-action-panel">
          <div className="plumb-step-heading"><span aria-hidden="true">2</span><h2>Token allowance</h2></div>
          <dl className="plumb-facts"><div><dt>Current allowance</dt><dd>{amount(invoice.allowance, "USDt")}</dd></div><div><dt>Allowance spender</dt><dd>Textile reactor</dd></div></dl>
          <Address value={demoSpender} label="Textile reactor address" />
          <p className="muted">{allowanceReady ? "The existing allowance covers the invoice limit." : "The operator can allow up to the invoice limit. An allowance does not spend USDt."}</p>
          {allowanceReady ? null : <button type="button" className="button" disabled={!authorized} onClick={() => openReview("allowance")}>Review allowance · {amount(invoice.cap, "USDt")}</button>}
        </section>
        <section className="panel plumb-panel plumb-action-panel">
          <div className="plumb-step-heading"><span aria-hidden="true">3</span><h2>Settlement quote</h2></div>
          <p>{quoteStatus}</p>
          {quote ? <p className="muted">Expiry <time dateTime={new Date(quote.expires).toISOString()}>{localTime.format(quote.expires)} WAT</time></p> : null}
          <p className="plumb-sr" aria-live="polite">{requesting ? "Preparing demo quote" : expired ? "Demo quote expired" : quote && remaining <= 15 && remaining > 0 ? "Demo quote expires in 15 seconds or less" : quoteStatus}</p>
          {canConvert ? <button type="button" className="button primary" onClick={() => openReview("conversion")}>{convertLabel}</button> : <button type="button" className="button" disabled={!canQuote || requesting} onClick={getQuote}>{requesting ? "Preparing…" : quote ? "Get another demo quote" : "Get demo quote"}</button>}
          <p className="muted">The conversion delivers cNGN to Daidai’s taker wallet first. The recipient receives a separate payout.</p>
          {setup ? <p className="muted">Operator wallet steps remaining: {stepsRemaining(invoice)}</p> : null}
        </section>
      </div>
    </div>
  </div>;
}

type TxFixture = { hash: string; block: string; fee: string };
const fixtures: Record<string, TxFixture> = {
  allowance: { hash: evidenceHash("ab"), block: "83,470,101", fee: "0.0017 CELO" },
  conversion: { hash: evidenceHash("bc"), block: "83,470,144", fee: "0.0038 CELO" },
  payout: { hash: evidenceHash("cd"), block: "83,470,152", fee: "0.0013 CELO" },
};

function TxEvidence({ kind }: { kind: keyof typeof fixtures }) {
  const entry = fixtures[kind];
  return <details className="plumb-disclosure"><summary>Transaction evidence</summary>
    <p className="muted">Illustrative transaction evidence</p>
    <dl className="plumb-facts"><div><dt>Hash</dt><dd><code translate="no">{entry.hash}</code></dd></div><div><dt>Block</dt><dd>{entry.block}</dd></div><div><dt>Network fee</dt><dd>{entry.fee}</dd></div></dl>
    <a className="button" href="https://celoscan.io" target="_blank" rel="noreferrer">Open Celoscan ↗</a>
    <p className="muted">This demo hash has no explorer transaction.</p>
  </details>;
}

type Step = { title: string; status: string; done: boolean; tx?: string };
function Timeline({ groups }: { groups: { title: string; steps: Step[] }[] }) {
  let index = 0;
  return <div className="plumb-timeline">
    {groups.map(group => <section className="panel plumb-panel" key={group.title}>
      <h2>{group.title}</h2>
      <ol start={index + 1}>{group.steps.map(step => {
        index++;
        return <li key={step.title} value={index}>
          <span className={step.done ? "plumb-timeline-mark plumb-done" : "plumb-timeline-mark"} aria-hidden="true">{step.done ? "✓" : index}</span>
          <div><strong>{step.title}</strong><p>{step.status}</p>{step.tx ? <TxEvidence kind={step.tx} /> : null}</div>
        </li>;
      })}</ol>
    </section>)}
  </div>;
}

export function Progress({ invoice, now, openReview }: Props) {
  const [notice, setNotice] = useState("");
  const current = phase(invoice);
  const settled = current === "Settled";
  const evidence = invoice.evidence;
  const needsChecks = current === "Needs reconciliation";
  const converted = invoice.flow === "converted" || invoice.flow === "submitted" || invoice.flow === "verified";
  const payoutSeen = invoice.flow === "submitted" || invoice.flow === "verified";
  const result = evidence ? evidence.amount - invoice.target : undefined;
  const allowanceReady = invoice.allowance >= invoice.cap;
  const recipientMatch = evidence?.recipient.toLowerCase() === invoice.wallet.toLowerCase();
  const prepared = [
    { title: "Recipient invoice consent", done: invoice.consent, status: invoice.consent ? "Verified in demo · invoice-bound EIP-712" : "Waiting for recipient" },
    { title: "Spending limit", done: true, status: amount(invoice.cap, "USDt") },
    { title: "Token allowance", done: allowanceReady, status: allowanceReady ? "Covers the approved limit" : "Waiting for allowance", tx: converted && allowanceReady ? "allowance" : undefined },
  ];
  const groups = [
    { title: "Get ready", steps: prepared },
    { title: "Convert USDt to cNGN", steps: [
      { title: "Validate exact-output quote", done: Boolean(invoice.quote), status: invoice.quote ? amount(invoice.quote.pay, "USDt") + " all-in" : "Waiting" },
      { title: "Conversion submission and confirmation", done: converted, status: converted ? "Confirmed in demo · cNGN reached the Daidai taker wallet" : needsChecks ? "Outcome unknown" : "Waiting", tx: converted ? "conversion" : undefined },
    ] },
    { title: "Send cNGN to " + invoice.recipient, steps: [
      { title: "Separate recipient payout", done: settled, status: payoutSeen ? "Submitted in demo" : needsChecks ? "Outcome unknown" : invoice.flow === "converted" ? "Needs operator approval" : "Waiting", tx: settled ? "payout" : undefined },
      { title: "Payout confirmation", done: settled, status: settled ? "Confirmed in demo" : payoutSeen ? "Awaiting final confirmation" : "Waiting" },
    ] },
    { title: "Check", steps: [
      { title: "Reconcile recipient and amount", done: settled, status: settled ? "Exact payout verified in demo" : needsChecks ? "Needs reconciliation" : "Waiting" },
    ] },
  ];
  const receiptText = "Daidai demo receipt " + invoice.id + " · " + amount(invoice.target, "cNGN") + " · Fictional evidence";
  async function share() {
    try { await navigator.clipboard.writeText(receiptText); setNotice("Demo receipt summary copied."); }
    catch { setNotice("Clipboard is unavailable. Print or save the demo receipt instead."); }
  }
  return <div className="plumb-settlement">
    <header className="plumb-page-title"><div><h1>{settled ? "Settled" : needsChecks ? "Needs reconciliation" : "Settlement progress"}</h1>
      <p>{invoice.id} · {invoice.recipient} · {amount(invoice.target, "cNGN")}</p></div>
      <span className={"plumb-status " + (needsChecks ? "plumb-hatch" : "")}>{settled ? "✓ Settled in demo" : current}</span></header>
    {needsChecks ? <p className="plumb-notice plumb-hatch" role="alert">An earlier outcome is uncertain or the evidence does not match. The operator must reconcile onchain evidence before any further action.</p> : null}
    {invoice.flow === "converted" || invoice.flow === "submitted" ? <div className="plumb-notice">
      <p>{amount(invoice.target, "cNGN")} reached the Daidai taker wallet in this demo. {invoice.flow === "converted" ? invoice.recipient + " has not been paid." : "The separate recipient payout is awaiting verification."}</p>
      {invoice.flow === "converted" ? <button type="button" className="button primary" onClick={() => openReview("payout")}>Review recipient payout</button> : null}
    </div> : null}
    <div className="plumb-progress-grid">
      <Timeline groups={groups} />
      <div className="plumb-detail-main">
        {settled && evidence ? <div className="plumb-receipt-column"><Instrument invoice={invoice} now={now} spent={evidence.debit} /></div> : null}
        <section className="panel plumb-panel">
          <h2>Ledger reconciliation</h2>
          <table className="plumb-ledger"><thead><tr><th scope="col">Check</th><th scope="col">Invoice</th><th scope="col">Onchain · demo</th></tr></thead><tbody>
            <tr><th scope="row">Recipient</th><td>{invoice.recipient}<br /><code translate="no">{invoice.wallet.slice(0, 7)}…{invoice.wallet.slice(-4)}</code></td><td className={!recipientMatch ? "plumb-hatch" : ""}>{recipientMatch ? "✓ " + evidence?.recipient.slice(0, 7) + "…" + evidence?.recipient.slice(-4) : evidence ? "Address differs" : "Not yet found"}</td></tr>
            <tr><th scope="row">Amount</th><td>{amount(invoice.target, "cNGN")}</td><td className={result !== 0n ? "plumb-hatch" : ""}>{evidence ? amount(evidence.amount, "cNGN") : "Not yet found"}</td></tr>
            <tr><th scope="row">Payout</th><td>Exact ERC-20 transfer</td><td className={settled ? "" : "plumb-hatch"}>{settled ? "✓ Block 83,470,152" : "Not yet verified"}</td></tr>
            <tr className="plumb-difference"><th scope="row">Difference</th><td>—</td><td>{result === undefined ? "Unknown" : result === 0n ? "0.00 cNGN" : amount(result, "cNGN")}</td></tr>
          </tbody></table>
        </section>
        {settled && evidence ? <section className="panel plumb-panel">
          <h2>Demo receipt</h2>
          <dl className="plumb-facts"><div><dt>USDt actually debited</dt><dd>{amount(evidence.debit, "USDt")}</dd></div><div><dt>Includes quote fee</dt><dd>{invoice.quote ? amount(invoice.quote.fee, "USDt") : "Unavailable"}</dd></div><div><dt>Network fees</dt><dd>0.0068 CELO</dd></div></dl>
          <div className="plumb-form-row"><button className="button" onClick={() => void share()}>Share receipt</button><button className="button" onClick={() => window.print()}>Print / save PDF</button></div>
          <p className="muted" aria-live="polite">{notice}</p>
        </section> : null}
      </div>
    </div>
  </div>;
}
