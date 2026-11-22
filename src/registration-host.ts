import { WalletAdapter } from './wallet.ts';
import { code, registrationIntent, sender } from './registration.ts';
import { Spike } from './invoice.ts';
import { startWalletHost } from './wallet-host.ts';
import type { CeloReader, FeeCeilings } from './celo.ts';

type Options = {
  file: string; reader: CeloReader; ceilings: FeeCeilings; nonce: number; expires: number;
  refresh: () => Promise<number>; approved?: (intent: ReturnType<typeof registrationIntent>['review']) => boolean;
  timeoutMs?: number; port?: number;
};

export async function registrationSession(options: Options) {
  const spike = new Spike(options.file, undefined, code);
  const key = JSON.stringify(['register', sender]);
  let adapter: WalletAdapter | undefined;
  const adapterOptions = { sender, spike, reader: options.reader, fees: options.ceilings, timeoutMs: options.timeoutMs };
  const disabledProvider = { async request(): Promise<never> { throw Error('preview cannot access a wallet'); },
    on() {}, removeListener() {} };
  try {
    adapter = new WalletAdapter({ ...adapterOptions, provider: disabledProvider, origin: 'http://127.0.0.1' });
    const { review } = registrationIntent(adapter, options.expires, options.nonce, options.ceilings);
    const existing = adapter.attempt(key);
    adapter.dispose();
    adapter = undefined;
    if (existing || !options.approved) {
      spike.db.close();
      return { review, existing };
    }
    if (!options.approved(review)) throw Error('review fingerprint changed');
    let resolve!: (value: { status: string; hash?: string }) => void;
    const result = new Promise<{ status: string; hash?: string }>(done => { resolve = done; });
    let inFlight: Promise<void> | undefined;
    const host = await startWalletHost(sender, { review, port: options.port ?? 0, start: () => {
      inFlight = (async () => {
        try {
          const active = adapter!;
          const prepared = registrationIntent(active, options.expires, options.nonce, options.ceilings).prepared;
          if (await options.refresh() !== options.nonce) throw Error('reviewed nonce changed');
          resolve(await active.submit(prepared, review.transaction));
        } catch { resolve({ status: 'blocked_before_wallet_dispatch' }); }
      })();
    } });
    adapter = new WalletAdapter({ ...adapterOptions, provider: host.provider, origin: host.origin });
    return { review, host, result, async close() {
      adapter?.dispose();
      await host.close();
      await inFlight;
      spike.db.close();
    } };
  } catch (error) {
    adapter?.dispose();
    spike.db.close();
    throw error;
  }
}
