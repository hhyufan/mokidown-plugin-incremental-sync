import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { openStorage } from '../src/storage.mjs';
import { createPluginServer } from '../src/server.mjs';

let storage, server, url;
const key = 'a'.repeat(64);
const other = 'b'.repeat(64);
const config = { plugins: ['cloud-sync'], accessKeys: [{ key, namespace: 'primary' }, { key: other, namespace: 'other' }], corsOrigins: ['tauri://localhost'], instanceId: 'test-instance', basePath: '/api' };
const snapshot = (content = 'hello', baseRev = 0, mutationId = randomUUID()) => ({ content, compressed: false, size: Buffer.byteLength(content), checksum: createHash('sha256').update(content).digest('hex'), baseRev, mutationId, fileName: 'notes/test.md' });
async function request(path, method = 'GET', body, token = key, headers = {}) {
  const response = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.status === 204 ? null : await response.json(), headers: response.headers };
}
beforeEach(async () => {
  storage = await openStorage({ type: 'sqlite', filename: ':memory:' });
  server = createPluginServer(config, storage);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async () => { await new Promise((resolve) => server.close(resolve)); await storage.close(); });

test('requires an access key, isolates namespaces and has no account endpoints', async () => {
  assert.equal((await request('/healthz', 'GET', undefined, '')).status, 200);
  assert.equal((await request('/capabilities', 'GET', undefined, '')).status, 401);
  const capability = await request('/capabilities');
  assert.equal(capability.data.authentication, 'access-key');
  assert.equal(capability.data.registration, false);
  assert.equal((await request('/auth/login', 'POST', {})).status, 404);
  await request('/sync/file/a', 'PUT', snapshot());
  assert.equal((await request('/sync/file/a', 'GET', undefined, other)).status, 404);
  assert.deepEqual((await request('/sync/changes', 'GET', undefined, other)).data.changes, []);
});

test('replays immutable operations once and detects concurrent writers', async () => {
  const body = snapshot();
  const first = await request('/sync/file/a', 'PUT', body);
  const second = await request('/sync/file/a', 'PUT', body);
  assert.deepEqual(first.data, second.data);
  assert.equal(first.data.rev, 1);
  const conflict = await request('/sync/file/a', 'PUT', snapshot('stale'));
  assert.equal(conflict.status, 409); assert.equal(conflict.data.current.content, 'hello');
  const writes = await Promise.all(['one', 'two'].map((content) => request('/sync/file/a', 'PUT', snapshot(content, 1))));
  assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await request('/sync/file/a')).data.rev, 2);
  assert.equal((await request('/sync/file/a', 'PUT', { ...body, content: 'other', size: 5, checksum: snapshot('other').checksum })).data.code, 'MUTATION_REUSED');
});

test('seek pagination retains deletion tombstones and explicit restores', async () => {
  for (const id of ['a', 'b', 'c']) await request(`/sync/file/${id}`, 'PUT', snapshot(id));
  const page1 = (await request('/sync/changes?cursor=&limit=2')).data;
  assert.equal(page1.hasMore, true); assert.equal(page1.changes.length, 2);
  const page2 = (await request(`/sync/changes?cursor=${page1.nextCursor}&limit=2`)).data;
  assert.equal(page2.hasMore, false); assert.equal(page2.changes[0].fileId, 'c');
  assert.equal((await request('/sync/file/a', 'DELETE', { baseRev: 1, mutationId: randomUUID() })).data.rev, 2);
  const deleted = (await request(`/sync/changes?cursor=${page2.nextCursor}`)).data.changes[0];
  assert.equal(deleted.deleted, true);
  assert.equal((await request('/sync/file/a', 'PUT', snapshot('restored', 0))).status, 409);
  assert.equal((await request('/sync/file/a', 'PUT', snapshot('restored', 2))).data.rev, 3);
  assert.equal((await request('/sync/changes?cursor=9999')).status, 400);
});

test('checks gzip, UTF-8, checksums and bounds before committing', async () => {
  assert.equal((await request('/sync/file/a', 'PUT', { ...snapshot(), checksum: 'wrong' })).status, 400);
  const body = snapshot('你好'.repeat(10000));
  body.content = gzipSync(Buffer.from(body.content)).toString('base64'); body.compressed = true;
  assert.equal((await request('/sync/file/a', 'PUT', body)).status, 200);
  assert.equal((await request('/sync/file/b', 'PUT', { ...snapshot(), compressed: true, content: 'broken' })).status, 400);
  assert.equal((await request('/sync/file/__proto__', 'PUT', snapshot())).status, 400);
  assert.equal((await request('/sync/changes?limit=0')).status, 400);
  assert.equal((await request('/sync/file/too-big', 'PUT', snapshot('x'.repeat(4 * 1024 * 1024)))).status, 413);
});

test('config timestamps do not regress and never store connection credentials', async () => {
  await request('/sync/config', 'PUT', { updatedAt: 100, fontSize: 18, accessKey: 'secret', serverUrl: 'private', workspacePath: '/private' });
  await request('/sync/config', 'PUT', { updatedAt: 50, fontSize: 12 });
  const result = (await request('/sync/config')).data;
  assert.equal(result.fontSize, 18); assert.equal(result.accessKey, undefined); assert.equal(result.workspacePath, undefined);
});

test('device path bindings do not modify content revisions or lose data', async () => {
  await request('/sync/file/a', 'PUT', snapshot());
  await request('/sync/bindings/a', 'POST', { deviceId: 'device-a', devicePath: '/notes/test.md', mutationId: randomUUID() });
  const doc = (await request('/sync/file/a')).data;
  assert.equal(doc.rev, 1); assert.equal(doc.deviceBindings['device-a'], '/notes/test.md'); assert.equal(doc.content, 'hello');
});

test('CORS is explicit and sync responses cannot be cached', async () => {
  assert.equal((await request('/capabilities', 'GET', undefined, key, { Origin: 'https://untrusted.test' })).status, 403);
  const result = await request('/sync/config', 'GET', undefined, key, { Origin: 'tauri://localhost' });
  assert.equal(result.headers.get('access-control-allow-origin'), 'tauri://localhost');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('disabling the plugin removes its routes', async () => {
  const disabled = createPluginServer({ ...config, plugins: [] }, storage);
  await new Promise((resolve) => disabled.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${disabled.address().port}/api/sync/config`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 404);
  } finally { await new Promise((resolve) => disabled.close(resolve)); }
});

test('quota failures do not partially advance revisions or cursors', async () => {
  storage.maxBytes = 700;
  const result = await request('/sync/file/a', 'PUT', snapshot('x'.repeat(1000)));
  assert.equal(result.status, 413);
  assert.equal((await request('/sync/file/a')).status, 404);
  assert.deepEqual((await request('/sync/changes')).data, { changes: [], nextCursor: '0', hasMore: false });
});
