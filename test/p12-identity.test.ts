import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchIdentity, type IdentityPorts } from '../src/launch-identity.ts';

const policy = { issuer: 'issuer', audience: 'daidai', now: 1_000_000 };
const input = { assertion: 'synthetic', tenant: 'a', purpose: 'operator-review' as const };
const claims = { issuer: 'issuer', audience: 'daidai', subject: 'user', expiresAt: policy.now + 1, confirmedAt: policy.now, mfa: true };
const ports: IdentityPorts = {
  verify: async () => claims,
  findGrant: async (_issuer, _subject, tenant) => ({ tenant, active: true, operatorReview: true }),
};
test('hosted provider is explicitly unconfigured and assertion outages remain unavailable', async () => {
  assert.deepEqual(await launchIdentity(input, policy), { kind: 'unconfigured' });
  assert.deepEqual(await launchIdentity(input, policy, { ...ports, verify: async () => { throw Error('private error'); } }), { kind: 'unavailable' });
});
test('issuer, audience, expiration, recent MFA and tenant operator grant must match separately', async () => {
  assert.equal((await launchIdentity(input, policy, ports)).kind, 'permitted');
  for (const change of [{ issuer: 'other' }, { audience: 'other' }, { expiresAt: policy.now }, { confirmedAt: policy.now - 300_000 }, { mfa: false }]) {
    assert.equal((await launchIdentity(input, policy, { ...ports, verify: async () => ({ ...claims, ...change }) })).kind, 'denied');
  }
  for (const grant of [{ tenant: 'b', active: true, operatorReview: true }, { tenant: 'a', active: true, operatorReview: false }, { tenant: 'a', active: false, operatorReview: true }]) {
    assert.equal((await launchIdentity(input, policy, { ...ports, findGrant: async () => grant })).kind, 'denied');
  }
});
