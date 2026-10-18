import { readConfig } from './config.mjs';
import { openStorage } from './storage.mjs';
import { createPluginServer } from './server.mjs';

try {
  const config = await readConfig();
  const storage = await openStorage(config.database);
  const server = createPluginServer(config, storage);
  server.on('error', async () => { console.error('Server failed to listen; check host and port.'); await storage.close(); process.exitCode = 1; });
  server.listen(config.port, config.host, () => console.log(`MokiDown plugin server listening on ${config.host}:${config.port}${config.basePath}`));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => { await storage.close(); clearTimeout(timeout); });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  // Driver messages can contain connection strings. Do not log credentials.
  console.error(error.message?.startsWith('Cannot read') ? error.message : 'Startup failed. Check configuration and database connection with npm run check:database.');
  process.exitCode = 1;
}
