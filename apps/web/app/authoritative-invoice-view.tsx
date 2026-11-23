import type { AuthoritativeInvoiceProjection } from '../../../src/authoritative-invoice';
import { StatusMark, TokenAmount } from './ui';

type Authorization = AuthoritativeInvoiceProjection['approval'];
type Operation = AuthoritativeInvoiceProjection['conversion'];

const operationLabels = {
  unverified: 'Unverified',
  stale: 'Observation stale',
  unknown: 'Outcome unknown',
  'reconciliation-required': 'Reconciliation required',
  verified: 'Finalized evidence verified',
} as const;

const reasons = {
  missing: 'Evidence is missing',
  mismatch: 'Evidence does not match the committed invoice or attempt',
  expired: 'Authorization expired',
  'observation-stale': 'Observation is outside the freshness window',
  'missing-hash': 'The attempt has no verified transaction hash',
  unavailable: 'Independent evidence is unavailable',
  'not-final': 'The transaction block is not finalized',
} as const;

const observedTime = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos', year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function ObservationTime({ ms }: { ms: number }) {
  return <time dateTime={new Date(ms).toISOString()}>{observedTime.format(ms)} WAT</time>;
}

function AuthorizationFacts({ title, summary }: { title: string; summary: Authorization }) {
  const evidence = summary.evidence;
  return <section className="panel">
    <h3>{title}</h3>
    <StatusMark mark={summary.state === 'verified' ? 'confirmed' : 'waiting'}>
      {summary.state === 'verified' ? 'Verified' : summary.state === 'stale' ? 'Observation stale' : 'Unverified'}
    </StatusMark>
    <dl className="kv">
      <dt>Purpose</dt><dd>{summary.purpose}</dd>
      {summary.reason ? <><dt>Reason</dt><dd>{reasons[summary.reason]}</dd></> : null}
      {evidence ? <>
        <dt>Signer</dt><dd className="mono">{evidence.signer}</dd>
        <dt>Audience</dt><dd>{evidence.audience}</dd>
        <dt>Commitment digest</dt><dd className="mono">{evidence.digest}</dd>
        <dt>Expires</dt><dd><ObservationTime ms={evidence.expiresAtMs} /></dd>
        <dt>Observed</dt><dd><ObservationTime ms={evidence.observedAtMs} /></dd>
        <dt>Source</dt><dd>{evidence.source}</dd>
      </> : null}
    </dl>
  </section>;
}

function OperationFacts({ title, operation }: { title: string; operation: Operation }) {
  const evidence = operation.evidence;
  return <section className="panel">
    <h3>{title}</h3>
    <StatusMark mark={operation.state === 'verified' ? 'confirmed' : operation.state === 'unverified' ? 'waiting' : 'recon'}>
      {operationLabels[operation.state]}
    </StatusMark>
    <dl className="kv">
      {operation.reason ? <><dt>Reason</dt><dd>{reasons[operation.reason]}</dd></> : null}
      {operation.attemptId ? <><dt>Attempt</dt><dd className="mono">{operation.attemptId}</dd></> : null}
      {evidence ? <>
        <dt>Transaction hash</dt><dd className="mono">{evidence.hash}</dd>
        <dt>Canonical block</dt><dd className="mono">{evidence.blockNumber} · {evidence.blockHash}</dd>
        <dt>Finalized head</dt><dd className="mono">{evidence.finalizedBlockNumber} · {evidence.finalizedBlockHash}</dd>
        <dt>cNGN amount</dt><dd><TokenAmount value={BigInt(evidence.amountAtomic)} unit="cNGN" tabular /></dd>
        <dt>USDt debit</dt><dd><TokenAmount value={BigInt(evidence.debitAtomic)} unit="USDt" tabular /></dd>
        <dt>Observed</dt><dd><ObservationTime ms={evidence.observedAtMs} /></dd>
        <dt>Canonical chain observed</dt><dd><ObservationTime ms={evidence.canonicalObservedAtMs} /></dd>
        <dt>Evidence source</dt><dd>{evidence.source}</dd>
        <dt>Canonical source</dt><dd>{evidence.canonicalSource}</dd>
      </> : null}
    </dl>
  </section>;
}

/** Internal presentation only. A future authenticated server route supplies the validated projection. */
export function AuthoritativeInvoiceView({ invoice }: { invoice: AuthoritativeInvoiceProjection }) {
  if (invoice.schemaVersion !== 1 || invoice.source !== 'authoritative' || invoice.execution !== 'disabled') {
    throw new Error('Expected a validated authoritative invoice projection');
  }
  const settled = invoice.settlement === 'settled';
  const needsReconciliation = invoice.settlement === 'reconciliation-required';
  return <article className="receipt" aria-label={'Authoritative invoice ' + invoice.id}>
    <header className="panel">
      <h2>Invoice {invoice.id}</h2>
      <p className="meta">Authoritative record · Read-only</p>
      <StatusMark mark={settled ? 'settled' : needsReconciliation ? 'recon' : 'waiting'}>
        {settled ? 'Settled' : needsReconciliation ? 'Reconciliation required' : 'Settlement unverified'}
      </StatusMark>
    </header>
    <div className="receipt-grid">
      <div className="receipt-main">
        <section className="panel">
          <h3>Invoice terms</h3>
          <dl className="kv">
            <dt>Commitment digest</dt><dd className="mono">{invoice.digest}</dd>
            <dt>Revision</dt><dd>{invoice.revision}</dd>
            <dt>Chain</dt><dd>Celo Mainnet ({invoice.chainId})</dd>
            <dt>Exact target</dt><dd><TokenAmount value={BigInt(invoice.targetAtomic)} unit="cNGN" tabular /></dd>
            <dt>Maximum all-in debit</dt><dd><TokenAmount value={BigInt(invoice.maxDebitAtomic)} unit="USDt" tabular /></dd>
            <dt>cNGN token</dt><dd className="mono">{invoice.tokens.buy.address}</dd>
            <dt>USDt token</dt><dd className="mono">{invoice.tokens.sell.address}</dd>
            <dt>Recipient</dt><dd className="mono">{invoice.recipient}</dd>
            <dt>Taker wallet</dt><dd className="mono">{invoice.taker}</dd>
            <dt>Observed</dt><dd><ObservationTime ms={invoice.observedAtMs} /></dd>
            <dt>Source</dt><dd>{invoice.provenance.invoice}</dd>
          </dl>
        </section>
        <OperationFacts title="Conversion" operation={invoice.conversion} />
        <OperationFacts title="Recipient payout" operation={invoice.payout} />
      </div>
      <div className="receipt-side">
        <AuthorizationFacts title="Invoice approval" summary={invoice.approval} />
        <AuthorizationFacts title="Recipient consent" summary={invoice.consent} />
      </div>
    </div>
  </article>;
}
