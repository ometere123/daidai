import assert from 'node:assert/strict';
import test from 'node:test';
import { currentStage, fixtures, phase, quoteState, settled, signaturesValid } from '../app/model.ts';

const now = 1_800_000_000_000;
const invoice = (flow) => fixtures(now).find((item) => item.flow === flow);

test('expired consent returns fixture presentation to the authorization stage', () => {
  const item = invoice('setup');
  const expired = {
    ...item,
    auth: { ...item.auth, consent: { ...item.auth.consent, expiresAtMs: now } },
  };
  assert.equal(signaturesValid(expired, now), false);
  assert.equal(currentStage(expired, now), 0);
});

test('fixture quote expires at its deadline and detects a debit one atom over cap', () => {
  const item = invoice('setup');
  assert.equal(quoteState(item, item.quote.expires - 1), 'held');
  assert.equal(quoteState(item, item.quote.expires), 'expired');
  assert.equal(quoteState({ ...item, quote: { ...item.quote, pay: item.cap + 1n } }, now), 'over');
});

test('missing approval or mismatched payout data cannot render as settled', () => {
  const item = invoice('verified');
  assert.equal(settled(item), true, 'the matching fixture establishes the positive control');
  const invalid = [
    { ...item, auth: { consent: item.auth.consent } },
    { ...item, evidence: { ...item.evidence, recipient: '0xDEMO_OTHER' } },
    { ...item, evidence: { ...item.evidence, amount: item.target - 1n } },
    { ...item, evidence: { ...item.evidence, debit: item.cap + 1n } },
  ];
  for (const candidate of invalid) {
    assert.equal(settled(candidate), false);
    assert.equal(phase(candidate), 'Needs reconciliation');
  }
});

test('the same fixture evidence cannot promote non-final progress to settled', () => {
  const item = invoice('verified');
  for (const flow of ['conversion-confirmed', 'converted', 'payout-declined', 'payout-submitted', 'uncertain']) {
    const candidate = { ...item, flow };
    assert.equal(settled(candidate), false);
    assert.notEqual(phase(candidate), 'Settled');
  }
  assert.equal(phase({ ...item, flow: 'uncertain' }), 'Needs reconciliation');
});
