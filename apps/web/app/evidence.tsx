import { registration } from '../../../src/public-registration';
import { PlumbBob } from './ui';

/**
 * Recorded registration evidence. This is a dated record taken from the repository (P08B23-REGISTRATION-OUTCOME.md,
 * recorded 2026-11-22), shown beside, never instead of, the live two-provider check. It is history, not an observation.
 */
export const recorded = Object.freeze({
  recordedOn: '2026-11-22', source: 'P08B23-REGISTRATION-OUTCOME.md',
  receiptBlock: 83479621, finalizedHeadChecked: 83479917,
  blockHash: '0x1558a6120f0d99bab5b85806a854659407c96dd2ff16c51b79a75453fed5a72b',
  attribution: 'celo_597f1146c487', explorer: 'https://celoscan.io/tx/' + registration.hash,
});
const n = new Intl.NumberFormat('en-NG');
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => <><dt>{label}</dt><dd>{children}</dd></>;

export function RecordedRegistration() {
  return <section className="panel" aria-labelledby="recorded-title">
    <h2 id="recorded-title">Recorded evidence</h2>
    <p className="evidence-note">From the repository record of {recorded.recordedOn}. This is history, not a live observation.</p>
    <dl className="evidence-facts">
      <Row label="Agent ID">#{registration.agent} (ERC-8004)</Row>
      <Row label="Network">Celo Mainnet, chain {registration.chain}</Row>
      <Row label="Registry"><code>{registration.registry}</code></Row>
      <Row label="Owner and agent wallet"><code>{registration.wallet}</code></Row>
      <Row label="Transaction"><code>{registration.hash}</code><br /><a href={recorded.explorer}>View on Celoscan ↗</a></Row>
      <Row label="Receipt block">{n.format(recorded.receiptBlock)}</Row>
      <Row label="Canonical block hash"><code>{recorded.blockHash}</code></Row>
      <Row label="Independent check">Reached finalized head {n.format(recorded.finalizedHeadChecked)}, matched the block hash, and read the owner, token URI and agent wallet there.</Row>
      <Row label="Attribution">One <code>{recorded.attribution}</code> suffix in the registration calldata.</Row>
    </dl>
  </section>;
}

type Provider = { name: string; kind: string; height?: string; head?: string; blockHash?: string };
export function LiveCheck({ status, observedAt, providers }: { status: string; observedAt: number; providers: readonly Provider[] }) {
  return <section className="panel" aria-labelledby="live-title">
    <h2 id="live-title">Live check</h2>
    <p className="evidence-note">Read just now from two independent Celo providers. Both must agree on a finalized mint, otherwise the result stays unresolved.</p>
    <dl className="evidence-facts">
      <Row label="Result"><strong>{status}</strong></Row>
      <Row label="Observed"><time dateTime={new Date(observedAt).toISOString()}>{new Date(observedAt).toISOString()}</time></Row>
      {providers.map(p => <Row key={p.name} label={p.name}>{p.kind}
        {p.kind === 'finalized registration' && <><br />Successful receipt, ERC-721 mint to the registered wallet, block {p.height}, finalized head {p.head}.<br /><code>{p.blockHash}</code></>}</Row>)}
    </dl>
  </section>;
}

/** The verdict a reader sees first. It never states more than the live check supports. */
export function RegistrationVerdict({ corroborated }: { corroborated: boolean }) {
  return <section className="slab proof-verdict" aria-labelledby="verdict-title">
    <PlumbBob size={22} onInk className="slab-mark" />
    <div className="slab-body">
      <h2 id="verdict-title" className="slab-sentence">Agent #{registration.agent} is registered on Celo.</h2>
      <p className="slab-peg">Recorded evidence: receipt in block {n.format(recorded.receiptBlock)}, canonical hash recorded {recorded.recordedOn}. {corroborated
        ? 'The live check just now agrees across two independent providers.'
        : 'The live check just now is unresolved, which means a provider was unavailable or the two did not agree. It does not mean the registration failed.'}</p>
    </div>
  </section>;
}
