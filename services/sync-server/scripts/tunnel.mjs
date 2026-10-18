import { spawn } from 'node:child_process';
import { readConfig } from '../src/config.mjs';

const config = await readConfig();
// Keep the same API and key for local, LAN and remote access. cloudflared is
// optional: users can instead point their own reverse proxy at this port.
const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
const target = `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
const child = spawn(process.env.CLOUDFLARED_PATH || 'cloudflared', ['tunnel', '--url', target], { stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('cloudflared is unavailable. Install it or set CLOUDFLARED_PATH; alternatively use your own reverse proxy.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
