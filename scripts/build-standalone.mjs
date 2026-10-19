import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
for (const file of ['errors.mjs', 'legacy.mjs', 'server.mjs', 'storage.mjs', 'plugins/cloud-sync.mjs']) await copyFile(resolve(root, 'services/sync-server/src', file), resolve(root, 'server/runtime', file));
await build({ entryPoints: [resolve(root, 'bin/cli.mjs')], outfile: resolve(root, 'standalone.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', define: { MOKIDOWN_STANDALONE: 'true' }, banner: { js: '// Generated from bin/cli.mjs and the shared protocol v3 runtime. Run npm run build:standalone to regenerate.' } });
