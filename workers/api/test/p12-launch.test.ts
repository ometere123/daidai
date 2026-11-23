import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { startWorker } from './fixtures.ts';
import { applySchema } from '../src/d1-schema.ts';
import { takeLaunchRate } from '../src/launch-rate.ts';

test('Worker defaults closed before opening D1', async () => {
  const unbound = { get DB(): never { throw Error('D1 opened'); }, DAIDAI_AUDIENCE: '' };
  for (const mode of [undefined, 'closed', 'production']) {
    const result = await worker.fetch(new Request('https://worker.invalid/v1/health'), Object.defineProperty(Object.create(unbound), 'DAIDAI_LAUNCH_MODE', { value: mode }));
    assert.equal(result.status, 503, mode);
  }
});
test('atomic shared D1 quota survives concurrency, rejects stale clocks and resets forward', async () => {
  const { db, mf } = await startWorker({ keys: {} });
  try {
    await applySchema(db);
    const time = 60_000;
    const claims = await Promise.all(Array.from({ length: 25 }, () => takeLaunchRate(db, 'invitation', time)));
    assert.equal(claims.filter(Boolean).length, 20);
    assert.equal(await takeLaunchRate(db, 'service', time), true);
    assert.equal(await takeLaunchRate(db, 'invitation', time - 1), false);
    assert.equal(await takeLaunchRate(db, 'invitation', time + 60_000), true);
    await db.prepare('DROP TABLE launch_rate').run();
    await assert.rejects(takeLaunchRate(db, 'service', time));
  } finally { await mf.dispose(); }
});
