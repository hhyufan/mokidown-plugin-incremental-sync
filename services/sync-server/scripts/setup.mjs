import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';

const path = resolve(process.env.MOKIDOWN_CONFIG || 'config.json');
let previous = {};
try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { /* First install. */ }
const defaults = process.argv.includes('--defaults');
const prompt = defaults ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask = async (question, fallback) => defaults ? fallback : (await prompt.question(`${question} [${fallback}]: `)).trim() || fallback;
try {
  const type = await ask('Database: sqlite / postgres / mysql / mariadb / mongodb / mssql', previous.database?.type || 'sqlite');
  if (!['sqlite', 'postgres', 'mysql', 'mariadb', 'mongodb', 'mssql'].includes(type)) throw new Error('Unsupported database');
  const database = { type };
  if (type === 'sqlite') database.filename = await ask('SQLite file (relative to configuration)', previous.database?.filename || 'data/sync.sqlite');
  else database.url = await ask('Database connection URL (mssql accepts an ADO connection string)', previous.database?.url || '');
  if (type !== 'sqlite' && !database.url) throw new Error('Database URL is required');
  const config = {
    host: await ask('Listen host (127.0.0.1 local / 0.0.0.0 LAN)', process.argv.includes('--lan') ? '0.0.0.0' : previous.host || '127.0.0.1'),
    port: Number(await ask('Listen port', String(previous.port || 8787))),
    basePath: await ask('API base path (empty for root)', previous.basePath || ''),
    instanceId: previous.instanceId || randomUUID(),
    plugins: previous.plugins || ['cloud-sync'],
    accessKeys: previous.accessKeys || [{ key: randomBytes(32).toString('hex'), namespace: 'default' }],
    corsOrigins: previous.corsOrigins || ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'],
    database: { ...(previous.database?.type === type ? previous.database : {}), ...database },
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid port');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Configuration saved: ${path}`);
  console.log(`Access key (copy into MokiDown settings): ${config.accessKeys[0].key}`);
  console.log('No account registration or login is needed. Next: npm run check:database, then npm start.');
} finally { prompt?.close(); }
