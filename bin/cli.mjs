#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--status') args[0] = 'status';
if (args[0] === '--stop') args[0] = 'stop';
const command = args[0]?.startsWith('-') || !args.length ? 'start' : args[0];
const options = command === args[0] ? args.slice(1) : args;
const home = path.resolve(process.env.MOKIDOWN_SYNC_HOME || path.join(homedir(), '.mokidown-sync'));
const statePath = path.join(home, 'service.json');
const logPath = path.join(home, 'service.log');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readState = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; } };
function removeState(expected) {
  if (readState()?.secret === expected?.secret) { try { unlinkSync(statePath); } catch {} }
}
async function control(state, action = 'status') {
  if (!state || !Number.isInteger(state.controlPort)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, { method: action === 'stop' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.secret}` }, signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}
function describe(status) {
  console.log(`MokiDown sync: ${status.phase} (PID ${status.pid})`);
  if (status.endpoint) console.log(`Endpoint: ${status.endpoint}`);
  if (status.localEndpoint) console.log(`Local: ${status.localEndpoint}`);
  console.log(`Log: ${logPath}`);
}
async function worker() {
  let phase = 'starting', ready = {};
  const secret = randomBytes(32).toString('hex');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/status' && req.method === 'GET') { res.end(JSON.stringify({ phase, pid: process.pid, ...ready })); return; }
    if (req.url === '/stop' && req.method === 'POST') { phase = 'stopping'; res.end(JSON.stringify({ phase })); setImmediate(() => process.emit('mokidown-stop')); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const state = { pid: process.pid, controlPort: server.address().port, secret };
  try { writeFileSync(statePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
  catch (error) { server.close(); throw error; }
  process.once('exit', () => removeState(state));
  process.on('mokidown-ready', info => { ready = info; phase = 'running'; });
  // The foreground supervisor owns all child processes and handles shutdown.
  process.argv = [process.execPath, fileURLToPath(new URL('./foreground.mjs', import.meta.url)), ...options];
  await import('./foreground.mjs');
}
async function main() {
  if (args.includes('--help') || command === 'help') {
    console.log('mokidown-sync [start|stop|status|run] [--port 4319] [--proxy-port 4320] [--host 127.0.0.1] [--no-tunnel]\nstart: detached service; stop: shut down service + proxy + tunnel; status: service status; run: foreground for containers\nData, credentials and logs: ~/.mokidown-sync (or MOKIDOWN_SYNC_HOME).');
    return;
  }
  if (command === '__server') { await import('../server/index.mjs'); return; }
  if (command === '__proxy') { await import('../server/proxy.mjs'); return; }
  mkdirSync(home, { recursive: true });
  if (command === '__run') return worker();
  if (command === 'run') { process.argv = [process.execPath, fileURLToPath(new URL('./foreground.mjs', import.meta.url)), ...options]; await import('./foreground.mjs'); return; }
  if (!['start', 'stop', 'status'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const state = readState();
  const current = await control(state);
  if (!current && state?.pid) {
    let alive = false;
    try { process.kill(state.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    if (alive) throw new Error(`Service process exists but its control endpoint is unreachable; inspect ${logPath}`);
  }
  if (command === 'status') { if (current) describe(current); else { console.log('MokiDown sync: stopped'); process.exitCode = 3; } return; }
  if (command === 'stop') {
    if (!current) { removeState(state); console.log('MokiDown sync: stopped'); return; }
    if (!await control(state, 'stop')) throw new Error('Stop request failed');
    for (let i = 0; i < 100; i++) { if (!await control(state)) { removeState(state); console.log('MokiDown sync: stopped'); return; } await pause(100); }
    throw new Error(`Service is still stopping; inspect ${logPath}`);
  }
  if (current) { describe(current); return; }
  removeState(state);
  const log = openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__run', ...options], { env: { ...process.env, MOKIDOWN_SYNC_HOME: home }, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  let spawnError; child.on('error', error => { spawnError = error; }); child.unref(); closeSync(log);
  console.log('Starting MokiDown sync in background…');
  for (let i = 0; i < 600; i++) {
    if (spawnError) throw spawnError;
    const started = readState();
    const status = await control(started);
    if (status?.phase === 'running') {
      describe(status);
      const token = readFileSync(path.join(home, 'token'), 'utf8').trim();
      console.log(`Credential: ${token}\nUse mokidown-sync stop to shut down.`);
      return;
    }
    if (child.exitCode !== null && child.exitCode !== undefined) throw new Error(`Service failed to start; inspect ${logPath}`);
    await pause(100);
  }
  // Do not leave a partly started supervisor behind after a timeout.
  await control(readState(), 'stop');
  throw new Error(`Startup timed out; inspect ${logPath}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
