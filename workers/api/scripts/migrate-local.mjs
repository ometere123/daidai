import { existsSync } from 'node:fs';
import { startWorker } from '../test/fixtures.ts';
import { applyProductSchema } from '../src/product-schema.ts';
import { persistDir } from './local-paths.mjs';

if (!existsSync(persistDir)) throw Error('Disposable Worker D1 must be seeded first');
const runtime = await startWorker({ keys: {}, persist: persistDir });
try {
  await applyProductSchema(runtime.db);
  const row = await runtime.db.prepare('SELECT MAX(version) AS version FROM product_schema').first();
  console.log('Local product schema version ' + row.version);
} finally { await runtime.mf.dispose(); }
