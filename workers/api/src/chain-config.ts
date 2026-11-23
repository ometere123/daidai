/**
 * Optional read-only chain reader hook (P10.5 decision 4). UNSET BY DEFAULT: without DAIDAI_CHAIN_RPC_URL the Worker has
 * no chain reader, every operation stays unknown and nothing settles.
 *
 * When DAIDAI_CHAIN_RPC_URL is set it must be https:// (or http://127.0.0.1[:port] for local tests), and
 * DAIDAI_ATTRIBUTION_CODE must be set too; otherwise the hook stays off (fail closed: no reader, never a half-configured
 * one). The transport is src/celo-rpc.ts (read methods only, timeouts, size limits).
 */
import { createCeloRpc } from '../../../src/celo-rpc.ts';
import type { Rpc } from '../../../src/chain-evidence.ts';

export type ChainEnv = Readonly<{ DAIDAI_CHAIN_RPC_URL?: string; DAIDAI_ATTRIBUTION_CODE?: string }>;
export type ChainConfig = Readonly<{ rpc: Rpc; attributionCode: string }>;

export function chainRpcUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return undefined;
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.username || u.password || u.hash) return undefined;
  if (u.protocol === 'https:') return u.href;
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1') return u.href;
  return undefined;
}

export function chainFromEnv(env: ChainEnv, factory: typeof createCeloRpc = createCeloRpc): ChainConfig | undefined {
  const url = chainRpcUrl(env.DAIDAI_CHAIN_RPC_URL);
  const attributionCode = env.DAIDAI_ATTRIBUTION_CODE;
  if (!url || typeof attributionCode !== 'string' || attributionCode.length === 0) return undefined;
  return Object.freeze({ rpc: factory({ url }), attributionCode });
}
