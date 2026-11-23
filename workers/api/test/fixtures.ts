// Test/seed fixtures for the local D1 prototype. Every key and token is generated at runtime and never written to
// tracked files. Nothing here talks to a network.
import type { Readable } from 'node:stream';
import { Miniflare } from 'miniflare';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { fileURLToPath } from 'node:url';
import { authorizationMessage } from '../../../src/authorization.ts';
import { cngn, commit, usdt, type Invoice } from '../../../src/invoice-core.ts';
import { sha256Hex, signRequest } from '../../../src/service-auth.ts';
import { VIEWER_HEADER } from '../../../src/api-contract.ts';
import { applySchema, type D1Like } from '../src/d1-schema.ts';
import { D1LineageWriter } from '../src/d1-lineage.ts';

export const AUDIENCE = 'http://127.0.0.1:3000';
export const WORKER = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
export const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
export const randomNonce = () => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');

export function serviceKey() { return { keyId: 'local-' + hex(4), secret: hex(32) }; }

/** Runtime stdout/stderr are captured (not printed) so tests can assert log redaction. */
export async function startWorker(o: { keys: Record<string, string>; persist?: string; audience?: string; product?: boolean; logs?: string[] }) {
  const logs = o.logs ?? [];
  const mf = new Miniflare({
    handleRuntimeStdio(stdout: Readable, stderr: Readable) {
      for (const stream of [stdout, stderr]) stream.on('data', (chunk: Buffer) => logs.push(...String(chunk).split('\n').filter(Boolean)));
    },
    modules: true, scriptPath: WORKER, compatibilityDate: '2024-11-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'daidai-local' }, d1Persist: o.persist ?? false,
    bindings: { DAIDAI_LAUNCH_MODE: 'isolated-local', ...(o.product ? { DAIDAI_LOCAL_PRODUCT: 'isolated-miniflare' } : {}), DAIDAI_SERVICE_KEYS: JSON.stringify(o.keys), DAIDAI_AUDIENCE: o.audience ?? AUDIENCE },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB') as unknown as D1Like;
  return { mf, db, logs };
}

export async function signedHeaders(o: { keyId: string; secret: string; path: string; viewerToken?: string; nowMs?: number; nonce?: string }) {
  const h = await signRequest({ keyId: o.keyId, secret: o.secret, method: 'GET', path: o.path, viewerToken: o.viewerToken ?? '',
    nowMs: o.nowMs ?? Date.now(), nonce: o.nonce ?? randomNonce() });
  return o.viewerToken === undefined ? h : { ...h, [VIEWER_HEADER]: o.viewerToken };
}

export type Party = { key: `0x${string}`; address: string };
const party = (): Party => { const key = generatePrivateKey(); return { key, address: privateKeyToAccount(key).address.toLowerCase() }; };

export async function signedInvoice(id: string, nowMs: number) {
  const approver = party(), recipient = party(), taker = party();
  const raw: Invoice = {
    id, version: 1, source: 'daidai-local-seed', nonce: hex(16), chain: 42220, sell: usdt, sellDecimals: 6, buy: cngn, buyDecimals: 6,
    buyAmount: '1500000000', recipient: recipient.address, maxSell: '1000000', approver: approver.address, taker: taker.address,
    expires: nowMs + 7 * 24 * 3600_000,
  };
  const { invoice, digest } = commit(raw);
  const sign = (p: Party, role: 'invoice approval' | 'recipient consent') =>
    privateKeyToAccount(p.key).signTypedData(authorizationMessage(invoice, digest, role, AUDIENCE));
  return { invoice, digest, approval: await sign(approver, 'invoice approval'), consent: await sign(recipient, 'recipient consent'),
    approver, recipient, taker };
}

export type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * tenant-a: demo-viewer may read inv-a1 (no attempts) and inv-a2 (hashless, outcome-unknown payout); inv-a3 has a legacy
 *           unresolved attempt and is readable too; inv-a4 exists but demo-viewer has no permission.
 * tenant-b: viewer-b (no permissions on tenant-a invoices) owns inv-b1.
 */
export async function seed(db: D1Like, nowMs = Date.now()) {
  await applySchema(db);
  const invoices = {
    'inv-a1': await signedInvoice('inv-a1', nowMs), 'inv-a2': await signedInvoice('inv-a2', nowMs),
    'inv-a3': await signedInvoice('inv-a3', nowMs), 'inv-a4': await signedInvoice('inv-a4', nowMs),
    'inv-b1': await signedInvoice('inv-b1', nowMs),
  };
  const tenantOf = (id: string) => id.startsWith('inv-a') ? 'tenant-a' : 'tenant-b';
  const stmts = [];
  for (const [id, s] of Object.entries(invoices)) {
    const t = tenantOf(id);
    stmts.push(db.prepare('INSERT INTO invoices (tenant_id, invoice_id, body, digest, revision) VALUES (?, ?, ?, ?, ?)').bind(t, id, JSON.stringify(s.invoice), s.digest, 1));
    stmts.push(db.prepare('INSERT INTO tenant_directory (invoice_id, tenant_id) VALUES (?, ?)').bind(id, t));
    stmts.push(db.prepare('INSERT INTO signatures (tenant_id, invoice_id, digest, approval, consent) VALUES (?, ?, ?, ?, ?)').bind(t, id, s.digest, s.approval, s.consent));
  }
  const tokens = { demo: randomToken(), viewerB: randomToken(), expired: randomToken(), noPermission: randomToken() };
  const session = async (token: string, viewer: string, tenant: string, expires: number) =>
    db.prepare('INSERT INTO viewer_sessions (token_sha256, viewer_id, tenant_id, authenticated_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?)').bind(await sha256Hex(token), viewer, tenant, nowMs - 1000, expires);
  stmts.push(await session(tokens.demo, 'demo-viewer', 'tenant-a', nowMs + 8 * 3600_000));
  stmts.push(await session(tokens.viewerB, 'viewer-b', 'tenant-b', nowMs + 8 * 3600_000));
  stmts.push(await session(tokens.expired, 'demo-viewer', 'tenant-a', nowMs - 1));
  stmts.push(await session(tokens.noPermission, 'viewer-a-none', 'tenant-a', nowMs + 8 * 3600_000));
  for (const id of ['inv-a1', 'inv-a2', 'inv-a3']) {
    stmts.push(db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-a', 'demo-viewer', ?, 'invoice:read')").bind(id));
  }
  stmts.push(db.prepare("INSERT INTO invoice_permissions VALUES ('tenant-b', 'viewer-b', 'inv-b1', 'invoice:read')"));
  await db.batch(stmts);

  const w = new D1LineageWriter(db);
  const a2 = invoices['inv-a2'];
  await w.recordAttempt({
    attemptId: 'att-a2-payout', tenantId: 'tenant-a', invoiceId: 'inv-a2', digest: a2.digest, recordedRevision: 1, operation: 'payout',
    createdAtMs: nowMs - 500, authorization: { digest: a2.digest, approvalSigner: a2.approver.address, consentSigner: a2.recipient.address, expiresAtMs: a2.invoice.expires },
    envelope: { chainId: 42220, to: cngn, dataSha256: 'ab'.repeat(32), value: '0' },
  });
  await w.recordOutcomeUnknown('att-a2-payout', nowMs - 400, 'local seed: dispatch outcome unknown, no hash');
  await w.importLegacy('tenant-a', { digest: invoices['inv-a3'].digest, invoiceId: 'inv-a3', payoutId: 'legacy-a3-payout' }, nowMs - 300);
  return { invoices, tokens };
}
