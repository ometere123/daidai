import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw Error('Run through npm run demo:p12');
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
};
const mode = process.argv[2] ?? 'product';
if (mode === 'chain') {
  run(['--experimental-strip-types', 'scripts/p12-celo-observe.mjs']);
} else if (mode === 'product') {
  run([npm, '--prefix', 'apps/web', 'run', 'build']);
  run([npm, '--prefix', 'workers/api', 'run', 'seed']);
  run([npm, '--prefix', 'workers/api', 'run', 'migrate:local']);
  run(['workers/api/scripts/e2e-auth-flow.mjs', '--product', ...(process.argv.includes('--headed') ? ['--headed'] : [])]);
} else { throw Error('Use product or chain'); }
