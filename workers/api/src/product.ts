import { cngn, chain, commit, usdt } from '../../../src/invoice-core.ts';
import { parseProduct, parseProductReply, parseRevision, type Revision } from '../../../src/product-contract.ts';
import type { AuthenticatedViewer } from '../../../src/viewer-access.ts';
import { sha256Hex } from '../../../src/service-auth.ts';
import type { D1Like } from './d1-schema.ts';

type Row = { body: string; revision: number; id: string };
const taker = '0xe4f6b961e91b1c5c17ff34a33cbb5a998589e49e';
const retention = 24 * 60 * 60 * 1000;

function digest(r: Revision) {
  return commit({ id: r.id, version: r.revision, source: 'Daidai P11', nonce: r.id, chain, sell: usdt, sellDecimals: 6,
    buy: cngn, buyDecimals: 6, buyAmount: r.target, maxSell: r.cap, recipient: r.recipient, approver: r.approver,
    taker, expires: r.expiry }).digest;
}
function decode(row: Row): Revision {
  const r = parseRevision(JSON.parse(row.body));
  if (!r || r.revision !== row.revision || r.id !== row.id || r.state === 'committed' && r.digest !== digest(r)) throw Error('revision invalid');
  return r;
}

export async function product(db: D1Like, viewer: AuthenticatedViewer, raw: string, now: number) {
  const { tenantId: tenant, viewerId: owner } = viewer;
  let request;
  try { request = parseProduct(JSON.parse(raw)); } catch { /* invalid wire */ }
  const reply = (kind: string, revisions: Revision[] = [], merchant = false) => {
    const wire = { version: 'p11.v1', kind, merchant, revisions };
    if (!parseProductReply(wire)) throw Error('invalid product response');
    return wire;
  };
  if (!request) return reply('invalid');
  if (request.kind === 'redeem') {
    const row = await db.prepare(`SELECT r.body,r.id,r.revision FROM product_shares s
      JOIN product_revisions r ON r.tenant=s.tenant AND r.id=s.id AND r.revision=s.revision
      WHERE capability_hash=? AND revoked_at IS NULL AND expires_at>? AND NOT EXISTS (
        SELECT 1 FROM product_revisions n WHERE n.tenant=r.tenant AND n.id=r.id AND n.revision>r.revision)`)
      .bind(await sha256Hex(request.code), now).first<Row>();
    const r = row && decode(row);
    return r?.state === 'committed' && r.expiry > now ? reply('revision', [r]) : reply('denied');
  }
  const merchant = !!await db.prepare('SELECT 1 FROM product_merchants WHERE tenant=? AND viewer=?').bind(tenant, owner).first();
  if (!merchant) return request.kind === 'list' ? reply('list') : reply('denied');
  if (request.kind === 'list') {
    const result = await db.prepare(`SELECT r.body,r.id,r.revision FROM product_revisions r
      WHERE r.tenant=? AND r.owner=? AND NOT EXISTS (SELECT 1 FROM product_revisions n
        WHERE n.tenant=r.tenant AND n.id=r.id AND n.revision>r.revision) ORDER BY r.rowid DESC LIMIT 100`)
      .bind(tenant, owner).all<Row>();
    if (!result.success) throw Error('list unavailable');
    return reply('list', result.results.map(decode), true);
  }
  const { id } = request;
  const latest = async () => {
    const row = await db.prepare('SELECT body,id,revision FROM product_revisions WHERE tenant=? AND owner=? AND id=? ORDER BY revision DESC LIMIT 1')
      .bind(tenant, owner, id).first<Row>();
    return row ? decode(row) : null;
  };
  if (request.kind === 'detail') {
    const result = await db.prepare('SELECT body,id,revision FROM product_revisions WHERE tenant=? AND owner=? AND id=? ORDER BY revision DESC LIMIT 100')
      .bind(tenant, owner, id).all<Row>();
    if (!result.success) throw Error('history unavailable');
    return result.results.length ? reply('history', result.results.map(decode), true) : reply('denied');
  }
  const current = await latest();
  if (request.kind === 'share' || request.kind === 'revoke') {
    if (!current) return reply('denied');
    if (request.kind === 'revoke') {
      const result = await db.prepare('UPDATE product_shares SET revoked_at=? WHERE tenant=? AND id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM product_merchants WHERE tenant=? AND viewer=?)')
        .bind(now, tenant, id, tenant, owner).run();
      if (!result.success) throw Error('revocation unavailable');
      return reply('revoked', [], true);
    }
    if (current.state !== 'committed' || current.expiry <= now) return reply('conflict');
    const hash = await sha256Hex(request.code);
    const result = await db.prepare(`INSERT INTO product_shares
      SELECT ?,?,?,?, ?,NULL WHERE ?=(SELECT MAX(revision) FROM product_revisions WHERE tenant=? AND id=?)
      AND EXISTS (SELECT 1 FROM product_merchants WHERE tenant=? AND viewer=?)
      ON CONFLICT DO NOTHING`).bind(hash, tenant, id, current.revision, Math.min(now + retention, current.expiry), current.revision, tenant, id, tenant, owner).run();
    if (!result.success) throw Error('sharing unavailable');
    const share = await db.prepare('SELECT 1 FROM product_shares WHERE capability_hash=? AND tenant=? AND id=? AND revision=? AND revoked_at IS NULL AND expires_at>?')
      .bind(hash, tenant, id, current.revision, now).first();
    return share ? reply('shared', [], true) : reply('conflict');
  }
  if (!('expected' in request)) return reply('invalid');
  const { expected, key } = request;
  const hash = await sha256Hex(JSON.stringify(request));
  const replay = async () => {
    const row = await db.prepare('SELECT body,id,revision,request_hash FROM product_revisions WHERE tenant=? AND owner=? AND operation_key=?')
      .bind(tenant, owner, key).first<Row & { request_hash: string }>();
    return row ? row.request_hash === hash ? reply('revision', [decode(row)], true) : reply('conflict') : null;
  };
  const existing = await replay();
  if (existing) return existing;
  if (expected > 0 && !current) return reply('denied');
  if ((current?.revision ?? 0) !== expected || current?.state === 'cancelled' || current?.state === 'committed' && request.kind !== 'cancel') return reply('conflict');
  const terms = request.kind === 'save' ? request.draft : current;
  if (!terms || request.kind !== 'cancel' && (terms.expiry <= now || terms.expiry > now + 90 * retention)) return reply('invalid');
  const revision: Revision = { id, target: terms.target, cap: terms.cap, recipient: terms.recipient, approver: terms.approver,
    expiry: terms.expiry, at: now, revision: expected + 1,
    state: request.kind === 'save' ? 'draft' : request.kind === 'commit' ? 'committed' : 'cancelled', digest: current?.digest ?? null };
  if (revision.state === 'committed') revision.digest = digest(revision);
  const result = await db.prepare(`INSERT INTO product_revisions
    SELECT ?,?,?,?,?,?,? WHERE ?=COALESCE((SELECT MAX(revision) FROM product_revisions WHERE tenant=? AND id=?),0)
    AND EXISTS (SELECT 1 FROM product_merchants WHERE tenant=? AND viewer=?) ON CONFLICT DO NOTHING`)
    .bind(tenant, owner, id, revision.revision, key, hash, JSON.stringify(revision), expected, tenant, id, tenant, owner).run();
  if (!result.success) throw Error('revision unavailable');
  return await replay() ?? reply('conflict');
}
