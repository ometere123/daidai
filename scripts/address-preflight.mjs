import { startAddressHost } from '../src/address-host.ts';

const host = await startAddressHost(process.argv[2] ?? '');
console.log('Address-only page: ' + host.origin);
console.log('Open it manually only after approval. Stop the local server with Ctrl+C.');
process.once('SIGINT', async () => { await host.close(); });
