import type { Decision } from '../../../src/review-decisions';

export function DecisionRecords({ rows }: { rows: readonly Decision[] }) {
  return <ul className="product-evidence">{rows.map(r => <li className="panel" key={r.rule}>
    <strong>{r.rule} · {r.outcome}</strong><p>{r.reason}</p><p className="meta">{r.input} · {r.provenance}</p>
    <p className="meta"><time dateTime={new Date(r.observedAt).toISOString()}>{new Date(r.observedAt).toISOString()}</time> · {r.correlation}</p>
  </li>)}</ul>;
}
