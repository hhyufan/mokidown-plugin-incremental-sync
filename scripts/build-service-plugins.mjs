import { prepareServicePlugins } from './prepare-service-plugins.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, mkdtemp, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'releases/service-plugins');
await mkdir(output, { recursive: true });
const { pkg, filename, catalog } = await prepareServicePlugins();
await writeFile(resolve(output, filename), pkg);
await writeFile(resolve(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
await writeFile(resolve(root, 'plugins/catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
const serverVersion = JSON.parse(await readFile(resolve(root, 'services/sync-server/package.json'), 'utf8')).version;
const archive = `mokidown-plugin-server-${serverVersion}.tar.gz`;
const files = ['package.json', 'package-lock.json', 'src', 'scripts', 'test', 'README.md', 'docs', 'Dockerfile', '.dockerignore', 'compose.yaml', 'deploy.sh', 'deploy.ps1', 'deploy', 'config.example.json'];
const tar = spawnSync('tar', ['-czf', resolve(output, archive), '-C', resolve(root, 'services/sync-server'), ...files], { stdio: 'inherit' });
if (tar.status !== 0) throw new Error('Could not create the Linux deployment archive');
await copyFile(resolve(root, 'plugins/README.md'), resolve(output, 'README.md'));
await copyFile(resolve(root, 'plugins/SDK.md'), resolve(output, 'SDK.md'));
const sdkVersion = JSON.parse(await readFile(resolve(root, 'plugins/sdk/package.json'), 'utf8')).version;
const sdkArchive = `mokidown-plugin-sdk-${sdkVersion}.tar.gz`;
await mkdir(resolve(root, '.cache'), { recursive: true });
const staging = await mkdtemp(resolve(root, '.cache/plugin-sdk-'));
for (const file of ['plugins/sdk', 'plugins/examples', 'plugins/_template', 'plugins/cloud-sync/client', 'plugins/cloud-sync/manifest.json', 'plugins/SDK.md', 'shared', 'scripts/package-plugin.mjs', 'scripts/lib/package-plugin.mjs']) {
  await mkdir(resolve(staging, file, '..'), { recursive: true });
  await cp(resolve(root, file), resolve(staging, file), { recursive: true });
}
await writeFile(resolve(staging, 'package.json'), JSON.stringify({ name: 'mokidown-plugin-devkit', private: true, type: 'module', scripts: { 'plugin:pack': 'node scripts/package-plugin.mjs' }, dependencies: { esbuild: '^0.25.12' } }, null, 2));
await writeFile(resolve(staging, 'README.md'), 'Run npm install, then npm run plugin:pack -- plugins/examples/markdown-style dist. See plugins/SDK.md. Node.js 22+ required.\n');
const sdkTar = spawnSync('tar', ['-czf', resolve(output, sdkArchive), '-C', staging, '.'], { stdio: 'inherit' });
if (sdkTar.status !== 0) throw new Error('Could not create the plugin SDK archive');
const sums = [];
for (const file of [filename, archive, sdkArchive, 'catalog.json', 'SDK.md', 'README.md']) sums.push(`${createHash('sha256').update(await readFile(resolve(output, file))).digest('hex')}  ${file}`);
await writeFile(resolve(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
console.log(`Plugin package, GitHub catalog, Linux deployment archive and checksums: ${output}`);
