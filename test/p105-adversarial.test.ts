import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCeloRpc, CeloRpcError } from '../src/celo-rpc.ts';
import { MAX_SKEW_MS, NonceWindow, signRequest, SERVICE_HEADERS, verifyRequest } from '../src/service-auth.ts';

const nowMs = 1_900_000_000_000;
const secret = 'test-only-old-'.repeat(4);
const newSecret = 'test-only-new-'.repeat(4);
const original = { method: 'POST', path: '/v1/sessions', body: '{"invitation":"example"}', viewerToken: '', nowMs,
  nonce: 'test_nonce_fixed_01', keyId: 'old', secret };

function validate(headers: Headers, opts: { nowMs?: number; keys?: Record<string, string>; body?: string } = {}) {
  return verifyRequest({ ...original, keys: { old: secret, next: newSecret }, headers, nonces: new NonceWindow(), ...opts });
}

test('service accepts skew boundaries and refuses one millisecond past either edge', async () => {
  const headers = new Headers(await signRequest(original));
  for (const edge of [-MAX_SKEW_MS, MAX_SKEW_MS]) {
    assert.equal(await validate(headers, { nowMs: nowMs + edge }), true);
    assert.equal(await validate(headers, { nowMs: nowMs + edge + Math.sign(edge) }), false);
  }
});

test('key rotation overlap is explicit and relabelling a signed request cannot change its key', async () => {
  const old = new Headers(await signRequest(original));
  const next = new Headers(await signRequest({ ...original, keyId: 'next', secret: newSecret }));
  assert.equal(await validate(old), true);
  assert.equal(await validate(next), true);
  assert.equal(await validate(old, { keys: { next: newSecret } }), false);
  assert.equal(await validate(next, { keys: { next: newSecret } }), true);
  old.set(SERVICE_HEADERS.keyId, 'next');
  assert.equal(await validate(old), false);
  assert.equal(await validate(old, { keys: { old: secret, next: secret } }), false, 'the signed key ID namespaces the replay claim');
});

test('an invalid HMAC does not spend the replay nonce and an exact replay is rejected', async () => {
  const headers = new Headers(await signRequest(original));
  const changed = new Headers(headers);
  const signed = headers.get(SERVICE_HEADERS.signature)!;
  changed.set(SERVICE_HEADERS.signature, (signed[0] === '0' ? '1' : '0') + signed.slice(1));
  const opts = { ...original, keys: { old: secret }, nonces: new NonceWindow() };
  assert.equal(await verifyRequest({ ...opts, headers: changed }), false);
  assert.equal(await verifyRequest({ ...opts, headers }), true);
  assert.equal(await verifyRequest({ ...opts, headers }), false);
});

for (const [name, response] of [
  ['invalid JSON', '{'],
  ['batch envelope', '[{"jsonrpc":"2.0","id":1,"result":"0xa4ec"}]'],
  ['mismatched ID with valid result', '{"jsonrpc":"2.0","id":2,"result":"0xa4ec"}'],
]) {
  test('Celo reader rejects ' + name, async () => {
    let reads = 0;
    const rpc = createCeloRpc({ url: 'http://127.0.0.1:9', fetch: async (_, req) => {
      reads++;
      const request = JSON.parse(String(req?.body));
      assert.equal(request.method, 'eth_chainId');
      assert.equal(request.id, 1);
      return new Response(response);
    } });
    await assert.rejects(rpc('eth_chainId', []), (e: unknown) => e instanceof CeloRpcError && e.code === 'malformed');
    assert.equal(reads, 1);
  });
}
