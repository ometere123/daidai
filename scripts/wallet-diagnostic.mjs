import { copyLocalSessionUrl } from './local-session-clipboard.mjs';
import { startWalletDiagnostic } from '../src/wallet-diagnostic.ts';
import { sender } from '../src/registration.ts';

const durationMs = 300_000;
const diagnostic = await startWalletDiagnostic(sender, { port: 51529, durationMs });

let timer;
try {
  copyLocalSessionUrl(diagnostic.bootstrapUrl);
  console.log('The one-use address is on the local clipboard. Paste it into your Chrome address bar and click Run read-only check.');
  await new Promise(resolve => {
    timer = setTimeout(resolve, durationMs);
    process.once('SIGINT', resolve);
  });
} finally {
  clearTimeout(timer);
  await diagnostic.close();
}
