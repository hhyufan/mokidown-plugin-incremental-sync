/**
 * End-to-end smoke test: sync server + reverse proxy + plugin protocol.
 *
 * Spawns the server and the proxy with a random token, then runs the exact
 * calls the incremental-sync plugin makes: capabilities, upload, changes,
 * download, unauthorised access.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';

const TOKEN = crypto.randomBytes(24).toString('hex');
const PORT = 4319;
const PROXY_PORT = 4320;
const DATA_DIR = '.data-test';
const env = { ...process.env, SYNC_TOKEN: TOKEN, PORT: String(PORT), PROXY_PORT: String(PROXY_PORT), DATA_DIR, PROXY_RATE_LIMIT: '5', PROXY_RATE_WINDOW_MS: '60000' };

const server = spawn(process.execPath, ['server/index.mjs'], { env, stdio: 'inherit' });
const proxy = spawn(process.execPath, ['server/proxy.mjs'], { env, stdio: 'inherit' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, attempts = 40, token) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(100);
  }
  return false;
}

async function request(method, path, body, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

try {
  const ready = await waitFor(`http://127.0.0.1:${PROXY_PORT}/capabilities`, 40, TOKEN);
  if (!ready) throw new Error('proxy/server did not become ready');

  const content = '# 全链路测试\n\n经反向代理上传，再由服务器读回。\n';
  const checksum = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  const fileId = 'e2e-doc';
  const capabilities = await request('GET', '/capabilities');
  const put = await request('PUT', `/sync/file/${fileId}`, {
    fileName: 'e2e.md', originalPath: 'notes/e2e.md', source: 'smoke-test',
    content, compressed: false, size: Buffer.byteLength(content, 'utf8'), encoding: 'utf8', lineEnding: 'LF',
    checksum, baseRev: 0, mutationId: crypto.randomUUID(),
  });
  const changes = await request('GET', '/sync/changes?cursor=0&limit=25');
  const pulled = await request('GET', `/sync/file/${fileId}`);
  const direct = await fetch(`http://127.0.0.1:${PORT}/sync/file/${fileId}`);
  const roundTrip = pulled.data?.content === content;

  // Rate limiting: this run allows only 5 requests per window, and any path
  // outside /capabilities + /sync/ must be rejected by the proxy.
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const burst = await Promise.all(
    Array.from({ length: 12 }, () => fetch(`http://127.0.0.1:${PROXY_PORT}/capabilities`, { headers: auth })),
  );
  const throttled = burst.filter((response) => response.status === 429).length;
  const blockedPath = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/secrets`, { headers: auth });
  const proxyWithoutToken = await fetch(`http://127.0.0.1:${PROXY_PORT}/sync/manifest`);

  console.log(JSON.stringify({
    tokenLength: TOKEN.length,
    capabilities: capabilities.status,
    put: put.status,
    changes: changes.status,
    changeCount: changes.data?.changes?.length,
    download: pulled.status,
    roundTrip,
    directWithoutToken: direct.status,
    throttled,
    blockedPath: blockedPath.status,
    proxyWithoutToken: proxyWithoutToken.status,
  }, null, 2));
  if (!roundTrip || put.status !== 200 || pulled.status !== 200 || direct.status !== 401 || throttled === 0 || blockedPath.status !== 404 || proxyWithoutToken.status !== 401) {
    process.exitCode = 1;
  }
} finally {
  server.kill();
  proxy.kill();
  await sleep(200);
  rmSync(DATA_DIR, { recursive: true, force: true });
}
