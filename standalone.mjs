#!/usr/bin/env node
/**
 * MokiDown sync server — single-file edition (no git / npm install needed).
 *
 *   irm https://raw.githubusercontent.com/hhyufan/mokidown-plugin-incremental-sync/main/standalone.mjs -OutFile "$env:TEMP\mokidown-sync.mjs"; node "$env:TEMP\mokidown-sync.mjs"
 *
 * Starts: sync server (loopback) + built-in proxy (token, allow-list, throttle)
 * + a cloudflared quick tunnel, then prints the endpoint and token.
 *
 * Flags: --port 4319 --proxy-port 4320 --token <hex> --no-tunnel
 *        --status (print the last running instance) · --stop (kill local instances)
 */
import http from 'node:http';
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', '4319'));
const PROXY_PORT = Number(flag('--proxy-port', '4320'));
const USE_TUNNEL = !has('--no-tunnel');
const HOME = path.join(os.homedir(), '.mokidown-sync');
const DATA_DIR = path.join(HOME, 'data');
const TOOLS_DIR = path.join(HOME, 'tools');
const TOKEN_FILE = path.join(HOME, 'token');
const STATUS_FILE = path.join(HOME, 'current.json');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(TOOLS_DIR, { recursive: true });

/** Kill listeners left behind by earlier runs (Windows: taskkill by PID). */
function stopLocalInstances() {
  if (process.platform !== 'win32') {
    console.log('stop the foreground window with Ctrl+C (or: pkill -f mokidown-sync.mjs)');
    return;
  }
  let output = '';
  try {
    output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (!match) continue;
    const port = Number(match[1]);
    if (![4319, 4320, 4339, 4340, PORT, PROXY_PORT].includes(port)) continue;
    pids.add(Number(match[2]));
  }
  if (!pids.size) {
    console.log('no local mokidown-sync listener found');
    return;
  }
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
      console.log(`stopped pid ${pid}`);
    } catch (error) {
      console.log(`pid ${pid}: ${error.message}`);
    }
  }
}

if (has('--stop')) {
  stopLocalInstances();
  process.exit(0);
}
if (has('--status')) {
  console.log(existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, 'utf8') : 'no running mokidown-sync recorded');
  process.exit(0);
}

function accessToken() {
  const provided = flag('--token', '');
  if (provided) return provided;
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  }
  const token = crypto.randomBytes(32).toString('hex');
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}


function freePort(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
const TOKEN = accessToken();
const DB_FILE = path.join(DATA_DIR, 'documents.json');
const db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : { rev: 0, files: {} };
const save = () => writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const syncServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > 4 * 1024 * 1024) {
      aborted = true;
      json(res, 413, { message: 'Request body exceeds 4 MiB' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    let body = null;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try { body = JSON.parse(raw); } catch { return json(res, 400, { message: 'Invalid JSON' }); }
    }
    if (url.pathname === '/capabilities') {
      return json(res, 200, {
        service: 'mokidown-plugin-server',
        instanceId: 'mokidown-sync-local',
        namespace: 'default',
        name: 'mokidown-sync',
        version: '1.0.0',
        plugins: [
          { id: 'cloud-sync', protocolVersion: 3 },
          { id: 'mokidown.incremental-sync', protocolVersion: 1 },
        ],
        capabilities: ['incremental-sync', 'cloud-sync-v3'],
      });
    }
    const auth = (req.headers.authorization || '') === `Bearer ${TOKEN}`;
    if (!auth) return json(res, 401, { message: 'Unauthorized' });

    const match = url.pathname.match(/^\/sync\/file\/(.+)$/);
    if (match) {
      const fileId = decodeURIComponent(match[1]);
      if (req.method === 'PUT') {
        if (!body || typeof body.content !== 'string') return json(res, 400, { message: 'Missing content' });
        db.rev += 1;
        db.files[fileId] = { ...body, fileId, rev: db.rev, updatedAt: Date.now() };
        save();
        return json(res, 200, { fileId, rev: db.rev });
      }
      if (req.method === 'GET') {
        const entry = db.files[fileId];
        return entry ? json(res, 200, entry) : json(res, 404, { message: 'Not found' });
      }
      if (req.method === 'DELETE') {
        delete db.files[fileId];
        save();
        return json(res, 200, { fileId, deleted: true });
      }
    }
    if (url.pathname === '/sync/changes' && req.method === 'GET') {
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), 200);
      const changes = Object.values(db.files)
        .filter((entry) => entry.rev > cursor)
        .sort((a, b) => a.rev - b.rev)
        .slice(0, limit)
        .map((entry) => ({ fileId: entry.fileId, path: entry.originalPath || entry.fileName, rev: entry.rev, deleted: false }));
      return json(res, 200, { changes, nextCursor: String(db.rev), hasMore: false, cursor: db.rev });
    }
    json(res, 404, { message: 'Not found' });
  });
});

const RATE_LIMIT = Number(process.env.PROXY_RATE_LIMIT || 60);
const RATE_WINDOW = Number(process.env.PROXY_RATE_WINDOW_MS || 60000);
const ALLOW = ['/capabilities', '/sync/'];
const buckets = new Map();
function takeToken(client) {
  const now = Date.now();
  const bucket = buckets.get(client) || { tokens: RATE_LIMIT, updated: now };
  bucket.tokens = Math.min(RATE_LIMIT, bucket.tokens + ((now - bucket.updated) / RATE_WINDOW) * RATE_LIMIT);
  bucket.updated = now;
  if (bucket.tokens < 1) { buckets.set(client, bucket); return false; }
  bucket.tokens -= 1;
  buckets.set(client, bucket);
  return true;
}

const proxyServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (provided !== TOKEN) return json(res, 401, { message: 'Unauthorized' });
  if (!ALLOW.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix))) {
    return json(res, 404, { message: 'Not found' });
  }
  if (!takeToken(req.socket.remoteAddress || 'unknown')) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(RATE_WINDOW / 1000)) });
    res.end(JSON.stringify({ message: 'Too many requests' }));
    return;
  }
  const headers = { ...req.headers, host: `127.0.0.1:${PORT}` };
  const request = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  request.on('error', () => json(res, 502, { message: 'Upstream error' }));
  req.pipe(request);
});

function cloudflaredAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') {
    return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`, name: 'cloudflared.exe' };
  }
  return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`, name: 'cloudflared', binary: true };
}

async function ensureCloudflared() {
  const asset = cloudflaredAsset();
  const target = path.join(TOOLS_DIR, asset.name);
  if (existsSync(target)) return target;
  process.stdout.write('\n[2/3] downloading cloudflared…\n');
  const res = await fetch(asset.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(target);
    res.body.pipeTo(new WritableStream({
      write(chunk) { stream.write(Buffer.from(chunk)); },
      close() { stream.end(resolve); },
      abort(error) { stream.destroy(); reject(error); },
    }));
  });
  if (asset.binary) chmodSync(target, 0o755);
  return target;
}

async function main() {
  if (!(await freePort(PORT))) {
    console.error(`\nPort ${PORT} is already in use — another mokidown-sync is probably running.`);
    console.error('Run `node mokidown-sync.mjs --stop`, or start with --port / --proxy-port.');
    process.exit(1);
  }
  if (!(await freePort(PROXY_PORT))) {
    console.error(`\nPort ${PROXY_PORT} is already in use — another mokidown-sync is probably running.`);
    console.error('Run `node mokidown-sync.mjs --stop`, or start with --port / --proxy-port.');
    process.exit(1);
  }

  await new Promise((resolve) => syncServer.listen(PORT, '127.0.0.1', resolve));
  await new Promise((resolve) => proxyServer.listen(PROXY_PORT, '127.0.0.1', resolve));
  process.stdout.write(`[1/3] sync server :${PORT}, proxy :${PROXY_PORT}\n`);

  let endpoint = `http://127.0.0.1:${PROXY_PORT}`;
  let tunnel = null;
  if (USE_TUNNEL) {
    const cloudflared = await ensureCloudflared();
    process.stdout.write('[3/3] opening public tunnel…\n');
    tunnel = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${PROXY_PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tunnel timeout')), 45000);
      const onData = (data) => {
        const match = String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      tunnel.stdout.on('data', onData);
      tunnel.stderr.on('data', onData);
    });
  }

  const line = '─'.repeat(56);
  process.stdout.write(`\n${line}\nMokiDown sync server is running\n`);
  process.stdout.write(`  Endpoint : ${endpoint}\n  Token    : ${TOKEN}\n\n`);
  process.stdout.write('Fill these in Settings → Plugins → Incremental Sync:\n');
  process.stdout.write(`  endpoint  = ${endpoint}\n  credential= ${TOKEN}\n`);
  process.stdout.write(`${line}\nCtrl+C to stop.\n`);
  // Remember the running instance so `--status` can recover its endpoint.
  writeFileSync(STATUS_FILE, JSON.stringify({
    endpoint,
    token: TOKEN,
    port: PORT,
    proxyPort: PROXY_PORT,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2));

  const shutdown = () => {
    try { tunnel?.kill(); } catch { /* ignore */ }
    try { unlinkSync(STATUS_FILE); } catch { /* ignore */ }
    syncServer.close();
    proxyServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`Failed to start: ${error.message}`);
  process.exit(1);
});
