import { randomBytes } from 'node:crypto';
import type { Revision } from '../../../../src/product-contract';

export const amount = (value: string) => {
  const n = BigInt(value);
  const fractional = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (n / 1_000_000n).toString() + (fractional ? '.' + fractional : '');
};

export function ProductError({ result }: { result?: string }) {
  if (!result) return null;
  const message = result === 'conflict' ? 'This invoice changed. Review the latest revision before submitting again.' :
    result === 'invalid' ? 'Check the wallet addresses, amounts and invoice expiry.' : 'The request could not be completed. Check the invoice before trying another change.';
  return <p role="alert">{message}</p>;
}

export function DraftForm({ id, revision }: { id: string; revision?: Revision }) {
  const expiry = revision?.expiry && revision.expiry > Date.now() ? revision.expiry : Date.now() + 7 * 86400000;
  return <form action="/api/product" method="post" style={{ display: 'grid', gap: 12 }}>
    <input type="hidden" name="kind" value="save" />
    <input type="hidden" name="id" value={id} />
    <input type="hidden" name="expected" value={revision?.revision ?? 0} />
    <input type="hidden" name="key" value={randomBytes(16).toString('hex')} />
    <label>Exact recipient amount (cNGN)<br /><input name="target" inputMode="decimal" required maxLength={25} defaultValue={revision ? amount(revision.target) : ''} /></label>
    <label>Maximum all-in debit (USDt)<br /><input name="cap" inputMode="decimal" required maxLength={25} defaultValue={revision ? amount(revision.cap) : ''} /></label>
    <label>Recipient wallet<br /><input name="recipient" required minLength={42} maxLength={42} defaultValue={revision?.recipient} className="mono" /></label>
    <label>Invoice approver wallet<br /><input name="approver" required minLength={42} maxLength={42} defaultValue={revision?.approver} className="mono" /></label>
    <label>Invoice expiry (UTC)<br /><select name="expiry" defaultValue={String(expiry)}>
      <option value={expiry}>{new Date(expiry).toISOString()}</option>
      <option value={Date.now() + 86400000}>24 hours from opening this page</option>
      <option value={Date.now() + 30 * 86400000}>30 days from opening this page</option>
    </select></label>
    <div><button className="btn" type="submit">{revision ? 'Save new revision' : 'Create draft'}</button></div>
  </form>;
}

export function MutationButton({ revision, kind, label }: { revision: Revision; kind: 'commit'|'cancel'|'share'|'revoke'; label: string }) {
  return <form action="/api/product" method="post">
    <input type="hidden" name="id" value={revision.id} />
    <input type="hidden" name="kind" value={kind} />
    <input type="hidden" name="expected" value={revision.revision} />
    <input type="hidden" name="key" value={randomBytes(16).toString('hex')} />
    <button className="btn" type="submit">{label}</button>
  </form>;
}

export function Terms({ revision: r }: { revision: Revision }) {
  return <dl className="meta" style={{ overflowWrap: 'anywhere' }}>
    <dt>Exact recipient amount</dt><dd className="mono">{amount(r.target)} cNGN</dd>
    <dt>Maximum all-in debit</dt><dd className="mono">{amount(r.cap)} USDt</dd>
    <dt>Recipient wallet</dt><dd className="mono">{r.recipient}</dd>
    <dt>Invoice approver</dt><dd className="mono">{r.approver}</dd>
    <dt>Expiry (UTC)</dt><dd>{new Date(r.expiry).toISOString()}</dd>
    {r.digest && <><dt>Commitment digest</dt><dd className="mono">{r.digest}</dd></>}
  </dl>;
}
