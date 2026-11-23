/**
 * Request-time guard for every private page (P10.5 decision 2): environment gate, then a session cookie, then
 * Worker validation of that session (expiry, idle timeout, revocation) on every request. Server components only.
 */
import { notFound, redirect } from 'next/navigation';
import { connection } from 'next/server';
import { appEnabled } from './app-gate';
import { listInvoices } from './daidai-api';
import { readSessionToken } from './session';
import type { InvoiceSummary } from '../../../src/api-contract.ts';

if (typeof window !== 'undefined') throw new Error('private is server-only');

export type PrivateContext = Readonly<{ token: string; invoices: readonly InvoiceSummary[] | null }>;

export async function requirePrivate(): Promise<PrivateContext> {
  await connection();
  if (!appEnabled()) notFound();
  const token = await readSessionToken();
  if (!token) redirect('/login');
  const list = await listInvoices(token);
  // Worker says the session is gone: a route handler clears the cookie (server components cannot) and sends to /login.
  if (list.kind === 'not-found-or-forbidden') redirect('/api/session/expired');
  return { token, invoices: list.kind === 'invoice-list' ? list.invoices : null };
}
