'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  groupShort, groupSlugs, groups, nextAction, opensProgress, OPERATOR, parseAtomic, phase, quoteState, scenarios,
  type Group, type Invoice,
} from './model';
import type { FixtureWorkspace } from './invoice-workspace';
import { Detail, Progress } from './settlement';
import { DemoStrip, PlumbBob, returnFocus, StatusGlyph, StatusMark, TokenAmount, Wordmark, countdown, type Mark } from './ui';

type View = 'detail' | 'progress';
const demoTools = process.env.NEXT_PUBLIC_DAIDAI_DEMO_TOOLS === '1';
const groupMark: Record<Group, Mark> = {
  'Needs you': 'needs-you', 'Needs reconciliation': 'recon', 'In progress': 'submitted', 'Waiting for signatures': 'waiting', 'Settled': 'settled',
};
const slugGroup = Object.fromEntries(Object.entries(groupSlugs).map(([g, s]) => [s, g])) as Record<string, Group>;
const isDesktop = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

export default function Prototype({ workspace }: { workspace: FixtureWorkspace }) {
  const [data, setData] = useState<Invoice[]>(() => [...workspace.invoices]);
  const [route, setRoute] = useState<{ invoice: string | null; view: View; filter: Group | null; selected: string | null }>({ invoice: null, view: 'detail', filter: null, selected: null });
  const [dataset, setDataset] = useState<'normal' | 'empty' | 'loading'>('normal');
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(workspace.observedAtMs);
  const [newOpen, setNewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [live, setLive] = useState('');
  const announce = useCallback((message: string) => { setLive(''); requestAnimationFrame(() => setLive(message)); }, []);

  useEffect(() => {
    function read() {
      const q = new URLSearchParams(location.search);
      const f = q.get('filter');
      setRoute({ invoice: q.get('invoice'), view: q.get('view') === 'progress' ? 'progress' : 'detail', filter: f && slugGroup[f] ? slugGroup[f] : null, selected: q.get('selected') });
      const d = q.get('data');
      setDataset(demoTools && (d === 'empty' || d === 'loading') ? d : 'normal');
    }
    const clock = Date.now();
    const q = new URLSearchParams(location.search);
    const scenario = demoTools ? scenarios[q.get('demo') ?? ''] : undefined;
    let items = [...workspace.invoices];
    if (scenario) {
      items = items.map(i => i.id === scenario.id ? scenario.patch(i, clock) : i);
      if (!q.get('invoice')) history.replaceState(null, '', '/demo?invoice=' + scenario.id + (scenario.view === 'progress' ? '&view=progress' : '') + '&demo=' + q.get('demo'));
    }
    setData(items); read(); setNow(clock); setReady(true);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener('popstate', read);
    return () => { clearInterval(timer); window.removeEventListener('popstate', read); };
  }, [workspace.invoices]);

  const invoice = route.invoice ? data.find(i => i.id === route.invoice) : undefined;
  useEffect(() => {
    document.title = invoice ? invoice.id + ' — Daidai (demo)' : 'Invoices — Daidai (demo)';
  }, [invoice]);

  const go = useCallback((id?: string, view: View = 'detail', params: Record<string, string> = {}) => {
    const q = new URLSearchParams();
    if (id) { q.set('invoice', id); if (view === 'progress') q.set('view', 'progress'); }
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const keep = new URLSearchParams(location.search).get('data');
    if (keep && demoTools && !id) q.set('data', keep);
    history.pushState(null, '', '/demo' + (q.size ? '?' + q : ''));
    setRoute({ invoice: id ?? null, view, filter: params.filter ? slugGroup[params.filter] ?? null : null, selected: params.selected ?? null });
    window.scrollTo(0, 0);
    requestAnimationFrame(() => (document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('#main'))?.focus());
  }, []);
  const update = useCallback((item: Invoice) => setData(items => items.map(p => p.id === item.id ? item : p)), []);

  const shown = dataset === 'normal' ? data : [];
  const counts = Object.fromEntries(groups.map(g => [g, shown.filter(i => phase(i) === g).length])) as Record<Group, number>;
  const home = (e: MouseEvent) => { e.preventDefault(); go(); };

  return <>
    <a className="skip" href="#main">Skip to content</a>
    <div className="shell">
      <aside className="rail" aria-label="Sidebar">
        <div className="rail-inner">
          <a className="rail-brand" href="/demo" onClick={home}><Wordmark /></a>
          <nav aria-label="Invoices">
            <a className="rail-link" href="/demo" aria-current={!invoice && !route.filter ? 'page' : undefined} onClick={home}>Invoices</a>
            <ul className="rail-filters">
              {groups.map(g => <li key={g}>
                <a href={'/demo?filter=' + groupSlugs[g]} aria-current={!invoice && route.filter === g ? 'page' : undefined}
                  onClick={e => { e.preventDefault(); go(undefined, 'detail', { filter: groupSlugs[g] }); }}>
                  <StatusGlyph mark={groupMark[g]} /><span>{g}</span><span className="count">{counts[g]}</span>
                </a>
              </li>)}
            </ul>
          </nav>
          <div className="rail-foot">
            <span className="avatar" aria-hidden="true">D</span>
            <span><strong>Demo workspace</strong><span className="meta">{OPERATOR}, Daidai operator</span></span>
          </div>
        </div>
      </aside>
      <div className="column">
        <header className="topbar">
          {invoice ? <a className="back" href="/demo" onClick={home}><span aria-hidden="true">←</span> Invoices</a>
            : <a className="top-brand" href="/demo" onClick={home}><Wordmark /></a>}
          <span className="top-right">
            <span className="demo-flag" data-source={workspace.source} data-execution={workspace.execution}><StatusGlyph mark="demo" /> Demo</span>
            {!invoice ? <button type="button" className="btn secondary compact" onClick={() => setNewOpen(true)}><span aria-hidden="true">+</span> New</button> : null}
            <button type="button" className="avatar-btn" aria-label="Workspace menu" onClick={() => setMenuOpen(true)}><span aria-hidden="true">D</span></button>
          </span>
        </header>
        <DemoStrip />
        <main id="main" tabIndex={-1} className={'main' + (invoice ? ' has-bar' : '')}>
          <div className="route" key={(invoice?.id ?? 'list') + route.view}>
            {!ready ? <Skeleton /> : invoice ? (route.view === 'detail'
              ? <Detail key={invoice.id} invoice={invoice} now={now} update={update} go={(id, v) => go(id, v)} announce={announce} />
              : <Progress key={invoice.id} invoice={invoice} now={now} update={update} go={(id, v) => go(id, v)} announce={announce} />)
              : route.invoice ? <NotFound id={route.invoice} onBack={() => go()} />
                : <Dashboard data={shown} dataset={dataset} now={now} filter={route.filter} selectedId={route.selected} counts={counts} go={go} onNew={() => setNewOpen(true)} />}
          </div>
        </main>
      </div>
    </div>
    <p className="sr-only" aria-live="polite">{live}</p>
    <NewInvoice open={newOpen} onOpenChange={setNewOpen} nextId={'INV-' + String(43 + Math.max(0, data.length - 6)).padStart(4, '0')}
      onCreate={item => { setData(items => [...items, item]); setNewOpen(false); go(item.id); announce('Demo invoice ' + item.id + ' saved. Waiting for signatures.'); }} />
    <Dialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog sheet" {...returnFocus}>
          <span className="sheet-handle" aria-hidden="true" />
          <Dialog.Title className="dialog-title">Demo workspace</Dialog.Title>
          <Dialog.Description className="meta">You’re signed in to a demo. Nothing here happened onchain.</Dialog.Description>
          <dl className="kv"><dt>You</dt><dd>{OPERATOR}</dd><dt>Role</dt><dd>Daidai operator: controls the Daidai taker wallet and signs each onchain step</dd></dl>
          <div className="dialog-foot"><Dialog.Close className="btn secondary">Close</Dialog.Close></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

function Skeleton() {
  return <div className="dash"><p className="sr-only" aria-live="polite">Loading invoices…</p>
    <div className="dash-head"><h1 className="title">Invoices</h1></div>
    <div className="skeleton" aria-hidden="true">{[0, 1, 2, 3, 4].map(n => <div key={n} className="skeleton-row" />)}</div></div>;
}

function NotFound({ id, onBack }: { id: string; onBack: () => void }) {
  return <div className="empty"><PlumbBob size={48} /><h1 className="title">No invoice {id}</h1><p>It isn’t in this demo workspace.</p>
    <button className="btn primary" onClick={onBack}>Back to invoices</button></div>;
}

function Dashboard({ data, dataset, now, filter, selectedId, counts, go, onNew }: {
  data: Invoice[]; dataset: 'normal' | 'empty' | 'loading'; now: number; filter: Group | null; selectedId: string | null; counts: Record<Group, number>;
  go: (id?: string, view?: View, params?: Record<string, string>) => void; onNew: () => void;
}) {
  const visible = groups.filter(g => !filter || g === filter);
  const ordered = visible.flatMap(g => data.filter(i => phase(i) === g));
  const selected = ordered.find(i => i.id === selectedId) ?? ordered[0];
  const rowRefs = useRef<Record<string, HTMLAnchorElement | null>>({});

  function select(i: Invoice, focus = false) {
    const q = new URLSearchParams(location.search); q.set('selected', i.id);
    history.replaceState(null, '', '/demo?' + q);
    setSel(i.id);
    if (focus) rowRefs.current[i.id]?.focus();
  }
  const [sel, setSel] = useState<string | null>(null);
  const current = ordered.find(i => i.id === (sel ?? selectedId)) ?? selected;

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const n = ordered.findIndex(i => i.id === current?.id);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? ordered.length - 1 : Math.max(0, Math.min(ordered.length - 1, n + (e.key === 'ArrowDown' ? 1 : -1)));
    if (ordered[next]) select(ordered[next], true);
  }
  function open(i: Invoice) { go(i.id, opensProgress(i) ? 'progress' : 'detail'); }

  if (dataset === 'loading') return <Skeleton />;
  return <div className="dash">
    <div className="dash-head">
      <h1 className="title">Invoices</h1>
      <button type="button" className="btn primary desktop-only" onClick={onNew}><span aria-hidden="true">+</span> New invoice</button>
    </div>
    {data.length === 0 ? <section className="empty">
      <PlumbBob size={48} />
      <h2 className="title">No invoices yet</h2>
      <p>Create an invoice for the exact cNGN amount you’re owed. Daidai marks it settled only after the cNGN reaches the recipient’s wallet.</p>
      <button type="button" className="btn primary" onClick={onNew}>New invoice</button>
    </section> : <>
      <div className="chips" role="group" aria-label="Filter invoices">
        {groups.map(g => <button key={g} type="button" className="chip" aria-pressed={filter === g}
          onClick={() => go(undefined, 'detail', filter === g ? {} : { filter: groupSlugs[g] })}>
          <StatusGlyph mark={groupMark[g]} />{groupShort[g]} <span className="count">{counts[g]}</span></button>)}
      </div>
      <div className="dash-grid">
        <div className="list" onKeyDown={onKey}>
          {visible.map(g => {
            const rows = data.filter(i => phase(i) === g);
            if (!rows.length) return <p key={g} className="group-empty">{g}: none yet</p>;
            return <section key={g} className="group" aria-labelledby={'g-' + groupSlugs[g]}>
              <h2 id={'g-' + groupSlugs[g]} className="group-h">{g}<span className="count">, {rows.length}</span></h2>
              <ul>{rows.map(i => <li key={i.id}>
                <a ref={el => { rowRefs.current[i.id] = el; }} className={'row' + (current?.id === i.id ? ' selected' : '')}
                  href={'/demo?invoice=' + i.id + (opensProgress(i) ? '&view=progress' : '')}
                  tabIndex={current?.id === i.id ? 0 : -1} aria-current={current?.id === i.id ? 'true' : undefined}
                  onFocus={() => { if (current?.id !== i.id) select(i); }}
                  onClick={e => {
                    e.preventDefault();
                    if (e.detail === 0 || !isDesktop()) open(i); else select(i);
                  }}
                  onDoubleClick={() => open(i)}>
                  <span className="row-1"><span className="row-name">{i.approver}</span><span className="meta row-id">{i.id} for {i.recipient}</span>
                    <TokenAmount value={i.target} unit="cNGN" tabular className="row-amount" /></span>
                  <span className="row-2"><StatusMark mark={groupMark[g]}>{nextAction(i, now)}</StatusMark></span>
                </a>
              </li>)}</ul>
            </section>;
          })}
          <p className="meta list-hint desktop-only">Use the arrow keys to move, Enter to open.</p>
        </div>
        {current ? <FocusPane invoice={current} now={now} onOpen={() => open(current)} /> : null}
      </div>
    </>}
  </div>;
}

function FocusPane({ invoice, now, onOpen }: { invoice: Invoice; now: number; onOpen: () => void }) {
  const g = phase(invoice);
  const qs = quoteState(invoice, now);
  const q = invoice.quote;
  return <aside className="focus" aria-label={'Selected invoice ' + invoice.id}>
    <p className="focus-top"><span className="meta">{invoice.id}</span><span className="badge" data-tone={groupMark[g]}><StatusMark mark={groupMark[g]}>{g}</StatusMark></span></p>
    <div className="mini-slab">
      <PlumbBob size={18} onInk />
      <p>{invoice.recipient} receives exactly <TokenAmount value={invoice.target} unit="cNGN" /></p>
    </div>
    <p className="focus-next"><strong>Next:</strong> {nextAction(invoice, now)}.</p>
    {q && invoice.flow === 'setup' && !q.invalid ? <p className="meta">Quote <TokenAmount value={q.pay} unit="USDt" /> all-in, limit <TokenAmount value={invoice.cap} unit="USDt" />.
      {qs === 'held' ? <> Quote expires in <span className="tnum">{countdown(q.expires - now)}</span>.</> : qs === 'expired' ? ' Expired.' : ''}</p>
      : <p className="meta">Limit <TokenAmount value={invoice.cap} unit="USDt" /> all-in.</p>}
    <button type="button" className="btn primary block" onClick={onOpen}>Open invoice</button>
    <dl className="focus-roles">
      <dt>Recipient</dt><dd>{invoice.recipient}, {invoice.recipientRole.toLowerCase()}</dd>
      <dt>Approver</dt><dd>{invoice.approver}</dd>
      <dt>Operator</dt><dd>{invoice.operator} (you)</dd>
    </dl>
  </aside>;
}

function NewInvoice({ open, onOpenChange, onCreate, nextId }: { open: boolean; onOpenChange: (v: boolean) => void; onCreate: (i: Invoice) => void; nextId: string }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => { if (open) setErrors({}); }, [open]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const recipient = String(form.get('recipient')).trim();
    const approver = String(form.get('approver')).trim();
    const target = parseAtomic(String(form.get('amount')).trim().replaceAll(',', ''));
    const wallet = String(form.get('wallet')).trim();
    const next: Record<string, string> = {};
    if (!recipient) next.recipient = 'Enter the recipient’s name.';
    if (!approver) next.approver = 'Enter the invoice approver’s name.';
    else if (approver.toLowerCase() === recipient.toLowerCase()) next.approver = 'The approver must be a different person from the recipient.';
    if (!target) next.amount = 'Enter a positive cNGN amount with up to six decimal places.';
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) next.wallet = 'Enter the recipient’s 0x wallet address (42 characters).';
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) { event.currentTarget.querySelector<HTMLInputElement>('[name="' + first + '"]')?.focus(); return; }
    onCreate({ id: nextId, recipient, recipientRole: 'Recipient', recipientCity: 'Nigeria', approver, operator: OPERATOR, wallet, target: target!,
      cap: 105_000_000n, allowance: 0n, auth: {}, flow: 'setup' });
  }
  const field = (name: string, label: string, props: Record<string, unknown>, help?: string, suffix?: string) =>
    <div className="field">
      <label className="label" htmlFor={'f-' + name}>{label}</label>
      <div className={'input-wrap' + (errors[name] ? ' invalid' : '')}>
        <input id={'f-' + name} name={name} autoComplete="off" aria-invalid={Boolean(errors[name])}
          aria-describedby={[help ? 'h-' + name : '', errors[name] ? 'e-' + name : ''].filter(Boolean).join(' ') || undefined} {...props} />
        {suffix ? <span className="suffix" aria-hidden="true">{suffix}</span> : null}
      </div>
      {help ? <p id={'h-' + name} className="meta">{help}</p> : null}
      {errors[name] ? <p id={'e-' + name} className="field-error"><StatusGlyph mark="failed" /> {errors[name]}</p> : null}
    </div>;
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="overlay" />
      <Dialog.Content className="dialog sheet" {...returnFocus}>
        <span className="sheet-handle" aria-hidden="true" />
        <Dialog.Title className="dialog-title">New invoice (demo)</Dialog.Title>
        <Dialog.Description className="meta">Saved in this browser tab only. Nothing is signed or sent.</Dialog.Description>
        <form className="form" onSubmit={submit} noValidate>
          {field('recipient', 'Recipient name', { maxLength: 80 }, 'The person who receives the cNGN.')}
          {field('approver', 'Invoice approver', { maxLength: 80 }, 'Authorizes the spend. Must differ from the recipient.')}
          {field('amount', 'Exact amount', { inputMode: 'decimal' }, 'The recipient receives exactly this amount.', 'cNGN')}
          {field('wallet', 'Recipient wallet address', { spellCheck: false, translate: 'no', className: 'mono' })}
          {Object.keys(errors).length ? <p className="sr-only" role="alert">{Object.values(errors)[0]}</p> : null}
          <div className="dialog-foot"><Dialog.Close className="btn secondary" type="button">Cancel</Dialog.Close><button className="btn primary" type="submit">Save demo invoice</button></div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
