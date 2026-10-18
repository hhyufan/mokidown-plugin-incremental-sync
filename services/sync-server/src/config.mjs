import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export async function readConfig(env = process.env) {
  const path = resolve(env.MOKIDOWN_CONFIG || 'config.json');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Cannot read config.json. Run npm run setup first, or set MOKIDOWN_CONFIG.'); }
  config.host = env.HOST || config.host || '127.0.0.1';
  config.port = Number(env.PORT || config.port || 8787);
  config.basePath = config.basePath || '';
  config.plugins ??= ['cloud-sync'];
  config.corsOrigins ??= ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
  config.database ??= { type: 'sqlite', filename: 'data/sync.sqlite' };
  if (env.DATABASE_TYPE) config.database.type = env.DATABASE_TYPE;
  if (env.DATABASE_URL) { config.database.url = env.DATABASE_URL; delete config.database.connection; }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid port');
  if (config.basePath && !/^\/[\w/-]*[\w-]$/.test(config.basePath)) throw new Error('basePath must start with / and have no trailing slash');
  if (!Array.isArray(config.plugins) || config.plugins.some((id) => !/^[a-z][a-z0-9.-]*$/.test(id))) throw new Error('Invalid plugin list');
  if (!Array.isArray(config.corsOrigins) || config.corsOrigins.includes('*')) throw new Error('Configure explicit CORS origins');
  if (config.database.maxStateBytes !== undefined && (!Number.isSafeInteger(config.database.maxStateBytes) || config.database.maxStateBytes < 1024 || (config.database.type === 'mongodb' && config.database.maxStateBytes > 12 * 1024 * 1024))) throw new Error('Invalid database maxStateBytes (MongoDB maximum is 12 MiB)');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(config.instanceId || '')) throw new Error('Configure a stable instanceId using npm run setup');
  if (!Array.isArray(config.accessKeys) || !config.accessKeys.length) throw new Error('Configure accessKeys using npm run setup');
  const seen = new Set();
  for (const entry of config.accessKeys) {
    if (typeof entry.key !== 'string' || entry.key.length < 32 || seen.has(entry.key) || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.namespace || '')) throw new Error('Each access key needs 32+ characters and a valid namespace');
    seen.add(entry.key);
  }
  if (config.database.type === 'sqlite' && config.database.filename !== ':memory:') config.database.filename = resolve(dirname(path), config.database.filename || 'data/sync.sqlite');
  return config;
}
