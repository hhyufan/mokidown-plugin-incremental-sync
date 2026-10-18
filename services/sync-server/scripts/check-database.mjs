import { randomUUID } from 'node:crypto';
import { readConfig } from '../src/config.mjs';
import { openStorage } from '../src/storage.mjs';

let storage;
try {
  const config = await readConfig();
  storage = await openStorage(config.database);
  // A dedicated probe row verifies write permissions and CAS, not only TCP.
  const probe = randomUUID();
  await storage.mutate('system:database-check', {}, (state) => { state.probe = probe; });
  if ((await storage.get('system:database-check'))?.probe !== probe) throw new Error('Read/write verification failed');
  console.log(`Database ready (${config.database.type}); schema, read, write and compare-and-swap verified.`);
} catch (error) {
  console.error(`Database check failed (${error.code || error.name}). Check type, address, credentials, TLS, database existence and table creation permissions.`);
  process.exitCode = 1;
} finally { await storage?.close(); }
