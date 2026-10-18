import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStorage } from '../src/storage.mjs';

test('SQLite persists committed cursors, revisions and receipts after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mokidown-storage-'));
  const config = { type: 'sqlite', filename: join(directory, 'state.sqlite') };
  try {
    let storage = await openStorage(config);
    await storage.mutate('account', { seq: 0 }, (state) => { state.seq = 3; state.receipt = 'op-1'; });
    await storage.close(); storage = await openStorage(config);
    assert.deepEqual(await storage.get('account'), { seq: 3, receipt: 'op-1' });
    await storage.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('database adapter commits concurrent CAS writes without dropping updates', async () => {
  const config = process.env.TEST_DATABASE_CONFIG ? JSON.parse(process.env.TEST_DATABASE_CONFIG) : { type: 'sqlite', filename: ':memory:' };
  const storage = await openStorage(config);
  const key = `adapter:${randomUUID()}`;
  try {
    await Promise.all(Array.from({ length: 8 }, () => storage.mutate(key, { value: 0 }, (state) => ++state.value)));
    assert.equal((await storage.get(key)).value, 8);
    await assert.rejects(() => storage.mutate(key, {}, () => { throw new Error('rollback'); }), /rollback/);
    assert.equal((await storage.get(key)).value, 8);
  } finally { await storage.close(); }
});
