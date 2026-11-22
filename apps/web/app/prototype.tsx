'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDownRight, ArrowLeft, ArrowUpRight, CircleHelp, FileText, Plus, X } from 'lucide-react';
import { amount, fixtures, groups, parseAtomic, phase, type Invoice } from './model';
import { Detail, Progress, demoSpender } from './settlement';

type Modal = 'new' | 'allowance' | 'conversion' | 'payout' | null;
type View = 'detail' | 'progress';
const start = 1760000000000;
const symbols = { 'Needs you':'◆', 'Needs reconciliation':'◈', 'In progress':'◌', 'Waiting for payer':'◷', 'Settled':'✓' };
const groupDescriptions = { 'Needs you':'Operator review is required', 'Needs reconciliation':'Verify the last submitted operation', 'In progress':'Payout confirmation pending', 'Waiting for payer':'Invoice authorization incomplete', 'Settled':'Illustrative payout match' };

function PlumbMark() { return <span className="plumb-mark" aria-hidden="true" />; }

export default function Prototype() {
  const [data, setData] = useState(() => fixtures(start));
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>('detail');
  const [empty, setEmpty] = useState(false);
  const [now, setNow] = useState(start);
  const [modal, setModal] = useState<Modal>(null);
  const [error, setError] = useState('');
  const returnFocus = useRef<HTMLElement | null>(null);
  const invoice = data.find(item => item.id === selected);
  useEffect(() => {
    function readLocation() {
      const query = new URLSearchParams(location.search);
      setSelected(query.get('invoice'));
      setView(query.get('view') === 'progress' ? 'progress' : 'detail');
      setEmpty(query.get('data') === 'empty');
    }
    const clock = Date.now();
    setData(items => items.map(item => item.quote ? {...item,quote:{...item.quote,expires:clock+42000}} : item));
    readLocation();
    setNow(clock);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener('popstate', readLocation);
    return () => { clearInterval(timer); window.removeEventListener('popstate', readLocation); };
  }, []);

  function navigate(id?: string, nextView: View = 'detail', showEmpty = false) {
    const query = new URLSearchParams();
    if (id) { query.set('invoice', id); if (nextView === 'progress') query.set('view', nextView); }
    if (showEmpty) query.set('data','empty');
    history.pushState(null,'','/' + (query.size ? '?' + query : ''));
    setSelected(id ?? null); setView(nextView); setEmpty(showEmpty);
    window.scrollTo(0,0);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('#main')?.focus());
  }
  function open(next: Modal) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setModal(next);
  }
  function update(item: Invoice) { setData(items => items.map(previous => previous.id === item.id ? item : previous)); }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const target = parseAtomic(String(form.get('amount')));
    const name = String(form.get('recipient')).trim();
    const wallet = String(form.get('wallet')).trim();
    const invalid = !name ? 'recipient' : !target ? 'amount' : !/^0x[0-9a-fA-F]{40}$/.test(wallet) ? 'wallet' : null;
    if (invalid || !target) {
      setError(invalid === 'recipient' ? 'Enter the recipient name.' : invalid === 'amount' ? 'Enter a positive cNGN amount with up to six decimal places.' : 'Enter a valid 0x recipient address.');
      event.currentTarget.querySelector<HTMLInputElement>('[name="' + invalid + '"]')?.focus();
      return;
    }
    const item: Invoice = { id:'INV-'+String(43+data.length-6).padStart(4,'0'), recipient:name, payer:'Demo approver', wallet, target,cap:105000000n,allowance:0n,consent:false,flow:'setup' };
    setData(items=>[...items,item]); setModal(null); navigate(item.id);
  }
  function simulate() {
    if (!invoice || !invoice.consent) return;
    const quote = invoice.quote;
    if (modal === 'allowance' && invoice.flow === 'setup') update({...invoice,allowance:invoice.cap});
    if (modal === 'conversion' && invoice.flow === 'setup' && quote && quote.expires > Date.now() && quote.pay <= invoice.cap && invoice.allowance >= invoice.cap) {
      update({...invoice,flow:'converted'}); navigate(invoice.id,'progress');
    }
    if (modal === 'payout' && invoice.flow === 'converted') {
      update({...invoice,flow:'submitted'}); navigate(invoice.id,'progress');
    }
    setModal(null);
  }
  const walletButton = modal === 'allowance' ? 'Simulate allowance approval' : modal === 'conversion' ? 'Simulate conversion approval' : 'Simulate payout submission';
  const safeQuote = invoice && invoice.quote && invoice.quote.expires > now && invoice.quote.pay <= invoice.cap && invoice.allowance >= invoice.cap;

  return <>
    <a className="skip" href="#main">Skip to content</a>
    <div className="app-shell">
      <aside className="sidebar">
        <a className="wordmark" href="/" onClick={event=>{event.preventDefault();navigate();}}><PlumbMark /> daidai</a>
        <nav aria-label="Main navigation" className="nav">
          <a className="nav-link" aria-current="page" href="/" onClick={event=>{event.preventDefault();navigate();}}><FileText size={19} /> Invoices</a>
          <a className="nav-link" href="/?data=empty" onClick={event=>{event.preventDefault();navigate(undefined,'detail',!empty);}}><CircleHelp size={19} /> {empty ? 'Demo invoices' : 'Empty preview'}</a>
        </nav>
        <div className="workspace"><div className="avatar" aria-hidden="true">D</div><div><strong>Daidai workspace</strong><small>Operator preview</small></div></div>
      </aside>
      <div className="shell-body">
        <header className="topbar">
          <a className="wordmark mobile-brand" href="/" onClick={event=>{event.preventDefault();navigate();}}><PlumbMark /> daidai</a>
          <span className="top-context">Workspace <span aria-hidden="true">/</span> Invoices</span>
          <span className="demo"><span aria-hidden="true">◇</span> DEMO DATA</span>
        </header>
        <main id="main" tabIndex={-1} className="main">
          {invoice ? <>
            <div className="detail-nav">
              <a className="button ghost" href="/" onClick={e=>{e.preventDefault();navigate();}}><ArrowLeft size={18}/> Invoices</a>
              <span className="mono">{invoice.id}</span>
              <a className="button ghost" href={'/?invoice='+invoice.id+(view==='detail'?'&view=progress':'')} onClick={e=>{e.preventDefault();navigate(invoice.id,view==='detail'?'progress':'detail');}}>{view==='detail'?'View progress':'Invoice details'}<ArrowUpRight size={16}/></a>
            </div>
            {view==='detail' ? <Detail key={invoice.id} invoice={invoice} now={now} update={update} openReview={open}/> :
              <Progress key={invoice.id} invoice={invoice} now={now} update={update} openReview={open}/>}
          </> : <>
            <div className="dash-head">
              <div><h1>Invoices</h1><p className="muted">Exact-amount settlement in cNGN.</p></div>
              <button className="button primary" onClick={()=>open('new')}><Plus size={18}/> New invoice</button>
            </div>
            {!empty ? <div className="overview"><span><PlumbMark /> Invoice overview</span><span className="mono">{data.length} invoices</span></div> : null}
            {empty ? <section className="empty panel">
              <PlumbMark/><h2>No invoices yet</h2><p>Create one for the exact cNGN amount you’re owed. Daidai marks it settled only after the cNGN reaches your wallet.</p>
              <button className="button primary" onClick={()=>open('new')}><Plus size={18}/> New invoice</button>
            </section> : <div className="groups">{groups.map(group=>{
              const rows=data.filter(item=>phase(item)===group);
              return <section className="group" key={group} aria-label={group}>
                <h2><span className={'group-icon '+(group==='Needs reconciliation'?'hatched':'')} aria-hidden="true">{symbols[group]}</span>{group}<span className="count">{rows.length}</span></h2>
                {rows.length ? <div>{rows.map(item=>{
                  const progress=item.flow!=='setup';
                  return <a className="invoice-row" key={item.id} href={'/?invoice='+item.id+(progress?'&view=progress':'')}
                    onClick={event=>{event.preventDefault();navigate(item.id,progress?'progress':'detail');}}>
                    <span className="row-name"><span className="mono">{item.id}</span><strong>{item.payer}</strong><small>Recipient · {item.recipient}</small></span>
                    <span className="row-action muted">{item.flow==='converted'?'Review recipient payout':groupDescriptions[group]}</span>
                    <span className="row-amount" translate="no">{amount(item.target,'cNGN')}</span><ArrowDownRight className="row-arrow" size={18} aria-hidden="true" />
                  </a>;
                })}</div> : null}
              </section>;
            })}</div>}
          </>}
        </main>
      </div>
    </div>
    <Dialog.Root open={modal!==null} onOpenChange={value=>{if(!value)setModal(null);}}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" onCloseAutoFocus={event=>{
          event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus();
        }}>
          <Dialog.Close className="icon-button" aria-label="Close dialog"><X size={19}/></Dialog.Close>
          <Dialog.Title>{modal==='new'?'New invoice':'Review '+modal}</Dialog.Title>
          <Dialog.Description>Demo data · this action never opens a wallet or moves funds.</Dialog.Description>
          {modal==='new' ? <form className="form stack" onSubmit={create} noValidate>
            <label>Recipient name<input name="recipient" maxLength={80} autoComplete="off" /></label>
            <label>Exact cNGN amount<input name="amount" inputMode="decimal" /></label>
            <label>Recipient wallet address<input name="wallet" spellCheck={false} translate="no" /></label>
            {error ? <p role="alert" className="error">{error}</p> : null}
            <button className="button primary" type="submit">Save demo invoice</button>
          </form> : invoice ? <>
            <dl className="review-facts">
              <dt>Operation</dt><dd>{modal==='allowance' ? 'Authorize an allowance. No USDt moves.' : modal==='conversion' ? 'Debit USDt and deliver cNGN to the Daidai taker wallet first.' : 'Send cNGN to the invoice recipient.'}</dd>
              <dt>Amount</dt><dd translate="no">{modal==='allowance' ? amount(invoice.cap,'USDt') : modal==='conversion'&&invoice.quote ? amount(invoice.quote.pay,'USDt') : amount(invoice.target,'cNGN')}</dd>
              {modal === 'payout' ? <><dt>Recipient wallet</dt><dd className="mono" translate="no">{invoice.wallet}</dd></> : null}
              {modal === 'allowance' ? <><dt>Allowance spender</dt><dd className="mono" translate="no">{demoSpender}</dd></> : null}
              {modal === 'conversion' ? <><dt>Fixed conversion output</dt><dd translate="no">{amount(invoice.target,'cNGN')}</dd></> : null}
              <dt>Signer</dt><dd>Daidai operator’s dedicated MetaMask EOA</dd>
              <dt>Sample network fee</dt><dd translate="no">0.004 CELO</dd>
            </dl>
            {modal==='conversion'&&!safeQuote ? <p role="alert">The demo quote no longer meets the invoice conditions.</p> : null}
            <button className="button primary" disabled={modal==='conversion'&&!safeQuote} onClick={simulate}>{walletButton}</button>
          </> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
