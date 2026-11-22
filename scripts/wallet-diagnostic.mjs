import { startWalletDiagnostic } from '../src/wallet-diagnostic.ts';
import { sender } from '../src/registration.ts';

const durationMs = 300_000;
const diagnostic = await startWalletDiagnostic(sender, { port: 51529, durationMs });
console.log('Open the read-only diagnostic and click Run read-only check: ' + diagnostic.origin);
let timer;
try {
  await new Promise(resolve => {
    timer = setTimeout(resolve, durationMs);
    process.once('SIGINT', resolve);
  });
} finally {
  clearTimeout(timer);
  await diagnostic.close();
}
