// P10.4: API contract (A2) and service authentication (C1) unit tests. Runtime-generated keys only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorBody, health, parseRequest, parseResponse, responseHeaders, VIEWER_HEADER } from '../src/api-contract.ts';
import { NonceWindow, SERVICE_HEADERS, signRequest, verifyRequest } from '../src/service-auth.ts';

const token = 'tok_' + 'a'.repeat(40);
const h = (extra: Record<string, string> = {}) => new Headers({ [VIEWER_HEADER]: token, ...extra });
const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

test('A2: request parsing accepts exactly the two read-only routes', () => {
  assert.deepEqual(parseRequest('GET', 'https://api.local/v1/health', new Headers()), { route: 'health' });
  assert.deepEqual(parseRequest('GET', 'https://api.local/v1/invoices/invoice-a/authoritative', h()), { route: 'invoice', invoiceId: 'invoice-a', viewerToken: token });
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) assert.equal(parseRequest(m, 'https://api.local/v1/health', new Headers()), 'method-not-allowed');
  for (const url of ['https://api.local/v1/invoices/invoice-a/authoritative?x=1', 'https://api.local/v1/invoices/invoice-a/authoritative#f',
    'https://api.local/v1/invoices/a/b/authoritative', 'https://api.local/v1/invoices/%2e%2e%2fsecret/authoritative', 'https://api.local/v2/health',
    'https://api.local/v1/invoices//authoritative', 'https://u:p@api.local/v1/health', 'https://api.local/v1/invoices/' + 'x'.repeat(200) + '/authoritative',
    'https://api.local/v1/invoices/%E0%A4%A/authoritative']) {
    assert.equal(parseRequest('GET', url, h()), 'invalid-request', url);
  }
  // Missing or malformed viewer tokens are indistinguishable from "not found".
  for (const t of ['', 'short', 'x'.repeat(300), 'has space ' + 'a'.repeat(40)]) {
    assert.equal(parseRequest('GET', 'https://api.local/v1/invoices/invoice-a/authoritative', new Headers({ [VIEWER_HEADER]: t })), 'not-found-or-forbidden');
  }
});

test('A2: responses are validated strictly; extra or missing fields are rejected', () => {
  assert(parseResponse(health()));
  assert(parseResponse(errorBody('not-found-or-forbidden')));
  assert.equal(parseResponse({ ...health(), extra: 1 }), null);
  assert.equal(parseResponse({ ...errorBody('unavailable'), error: 'stack trace here' }), null);
  assert.equal(parseResponse({ apiVersion: 'v1', kind: 'authoritative-invoice', invoice: { schemaVersion: 2, source: 'fixture' } }), null);
  assert.equal(parseResponse({ apiVersion: 'v2', kind: 'health', status: 'ok', readOnly: true, execution: 'disabled' }), null);
  assert.equal(parseResponse({ ...health(), execution: 'enabled' }), null);
  assert.match(responseHeaders['cache-control'], /no-store/);
  assert(!Object.keys(responseHeaders).some(k => k.startsWith('access-control')));
});

test('C1: service signatures verify once, and every tampering, skew, replay or wrong key fails', async () => {
  const secret = randomSecret();
  const keys = { 'vercel-1': secret };
  const now = 1_800_000_000_000;
  const path = '/v1/invoices/invoice-a/authoritative';
  const sign = (o: Partial<Parameters<typeof signRequest>[0]> = {}) => signRequest({ keyId: 'vercel-1', secret, method: 'GET', path, viewerToken: token,
    nowMs: now, nonce: 'n-' + crypto.randomUUID(), ...o });
  const verify = async (headers: Record<string, string>, o: Partial<Parameters<typeof verifyRequest>[0]> = {}) =>
    verifyRequest({ keys, headers: new Headers(headers), method: 'GET', path, body: '', viewerToken: token, nowMs: now, nonces: new NonceWindow(), ...o });

  const good = await sign();
  const nonces = new NonceWindow();
  assert.equal(await verify(good, { nonces }), true);
  assert.equal(await verify(good, { nonces }), false, 'replay');
  assert.equal(await verify(await sign({ secret: randomSecret() })), false, 'wrong key');
  assert.equal(await verify(await sign({ keyId: 'other' }), { keys: { ...keys } }), false, 'unknown key id');
  assert.equal(await verify(await sign(), { path: '/v1/invoices/invoice-b/authoritative' }), false, 'path tamper');
  assert.equal(await verify(await sign(), { viewerToken: 'tok_' + 'b'.repeat(40) }), false, 'viewer token swap');
  assert.equal(await verify(await sign(), { body: 'x' }), false, 'body tamper');
  assert.equal(await verify(await sign(), { method: 'POST' }), false, 'method tamper');
  assert.equal(await verify(await sign({ nowMs: now - 60_001 })), false, 'skew past');
  assert.equal(await verify(await sign({ nowMs: now + 60_001 })), false, 'skew future');
  assert.equal(await verify(await sign({ nowMs: now - 59_000 })), true, 'within skew');
  for (const k of Object.values(SERVICE_HEADERS)) {
    const missing = { ...good }; delete missing[k];
    assert.equal(await verify(missing), false, 'missing ' + k);
  }
  assert.equal(await verify({ ...good, [SERVICE_HEADERS.signature]: good[SERVICE_HEADERS.signature].toUpperCase() }), false, 'non-canonical hex');
  // An invalid signature never consumes the nonce (no replay-window exhaustion by unauthenticated callers).
  const n = 'shared-nonce-' + 'x'.repeat(8);
  const window = new NonceWindow();
  assert.equal(await verify(await sign({ nonce: n, secret: randomSecret() }), { nonces: window }), false);
  assert.equal(await verify(await sign({ nonce: n }), { nonces: window }), true);
  await assert.rejects(signRequest({ keyId: 'k', secret: 'short', method: 'GET', path, nowMs: now, nonce: 'n'.repeat(16) }), /too short/);
});
