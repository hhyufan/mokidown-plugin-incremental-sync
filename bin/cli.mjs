#!/usr/bin/env node
/**
 * One-command sync server for the MokiDown incremental-sync plugin.
 *
 *   npx github:hhyufan/mokidown-plugin-incremental-sync
 *
 * What it does:
 *   1. reuses/generates an access token (~/.mokidown-sync/token);
 *   2. starts the sync server (loopback) and the built-in proxy;
 *   3. downloads cloudflared if needed and opens a quick tunnel;
 *   4. prints the public endpoint + token to paste into the plugin.
 *
 * Flags: --port <n>, --proxy-port <n>, --token <hex>, --no-tunnel.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const has = (name) => args.includes(name);

const PORT = Number(flag('--port', '4319'));
const PROXY_PORT = Number(flag('--proxy-port', '4320'));
const USE_TUNNEL = !has('--no-tunnel');
const HOME = path.join(os.homedir(), '.mokidown-sync');
const TOKEN_FILE = path.join(HOME, 'token');
const DATA_DIR = path.join(HOME, 'data');
const TOOLS_DIR = path.join(HOME, 'tools');
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(TOOLS_DIR, { recursive: true });

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloudflaredAsset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`, name: 'cloudflared.exe' };
  if (process.platform === 'darwin') return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`, name: 'cloudflared.tgz', tgz: true };
  return { url: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`, name: 'cloudflared', binary: true };
}

async function download(url, destination) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(destination);
    const body = res.body;
    if (!body) return reject(new Error('empty response'));
    body.pipeTo(new WritableStream({
      write(chunk) { stream.write(Buffer.from(chunk)); },
      close() { stream.end(resolve); },
      abort(error) { stream.destroy(); reject(error); },
    }));
  });
}

async function ensureCloudflared() {
  const asset = cloudflaredAsset();
  const target = path.join(TOOLS_DIR, asset.name);
  if (existsSync(target) && !asset.tgz) return target;
  process.stdout.write(`\n[1/3] downloading cloudflared…\n`);
  await download(asset.url, target);
  if (asset.binary) chmodSync(target, 0o755);
  if (asset.tgz) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('tar', ['-xzf', target, '-C', TOOLS_DIR], { stdio: 'inherit' });
    chmodSync(path.join(TOOLS_DIR, 'cloudflared'), 0o755);
    return path.join(TOOLS_DIR, 'cloudflared');
  }
  return target;
}

function start(processPath, label, env) {
  const child = spawn(process.execPath, [processPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => process.stdout.write(`[${label}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${label}] ${data}`));
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[${label}] exited with code ${code}`);
  });
  return child;
}

async function main() {
  const token = accessToken();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..');
  const serverPath = path.join(root, 'server', 'index.mjs');
  const proxyPath = path.join(root, 'server', 'proxy.mjs');

  process.stdout.write(`[2/3] starting sync server + proxy…\n`);
  const children = [];
  children.push(start(serverPath, 'server', { SYNC_TOKEN: token, PORT: String(PORT), PROXY_PORT: String(PROXY_PORT), DATA_DIR }));
  children.push(start(proxyPath, 'proxy', { SYNC_TOKEN: token, PORT: String(PORT), PROXY_PORT: String(PROXY_PORT), DATA_DIR, TARGET: `http://127.0.0.1:${PORT}` }));
  await sleep(800);

  let endpoint = `http://127.0.0.1:${PROXY_PORT}`;
  let tunnel = null;
  if (USE_TUNNEL) {
    process.stdout.write(`[3/3] opening public tunnel…\n`);
    const cloudflared = await ensureCloudflared();
    tunnel = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${PROXY_PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(tunnel);
    endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tunnel timeout')), 45000);
      const onData = (data) => {
        const match = String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      tunnel.stdout.on('data', onData);
      tunnel.stderr.on('data', onData);
    });
  }

  const line = '─'.repeat(56);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`MokiDown sync server is running\n`);
  process.stdout.write(`  Endpoint : ${endpoint}\n`);
  process.stdout.write(`  Token    : ${token}\n`);
  process.stdout.write(`\nFill these in Settings → Plugins → Incremental Sync:\n`);
  process.stdout.write(`  endpoint  = ${endpoint}\n`);
  process.stdout.write(`  credential= ${token}\n`);
  process.stdout.write(`${line}\nCtrl+C to stop.\n`);

  const shutdown = () => {
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`\nFailed to start: ${error.message}`);
  process.exit(1);
});
