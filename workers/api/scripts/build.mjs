// Bundles the read-only Worker for Miniflare/workerd. Local only; never deploys.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('..', import.meta.url));
await build({
  entryPoints: [here + 'src/index.ts'], outfile: here + 'dist/worker.js', bundle: true, format: 'esm',
  platform: 'browser', conditions: ['worker', 'browser'], external: ['node:*'], target: 'es2022',
  // Shared src/ resolves viem etc. from the root node_modules first, then from this package's own install.
  nodePaths: [here + 'node_modules'], logLevel: 'warning', legalComments: 'none',
});
