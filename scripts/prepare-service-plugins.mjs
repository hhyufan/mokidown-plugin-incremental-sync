import { mkdir, writeFile } from 'node:fs/promises';
import { packagePlugin } from './lib/package-plugin.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareServicePlugins() {
  const root = resolve(import.meta.dirname, '..');
  const { manifest, text: pkg, filename, digest } = await packagePlugin(resolve(root, 'plugins/cloud-sync'));
  const repository = process.env.GITHUB_REPOSITORY || 'hhyufan/mokidown';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GITHUB_REPOSITORY');
  const remote = { id: manifest.id, name: manifest.name, version: manifest.version, url: `https://github.com/${repository}/releases/download/service-plugins-v${manifest.version}/${filename}`, sha256: digest, checksumMode: 'canonical-json-v1' };
  const descriptor = {
    ...remote, permissions: manifest.permissions, fileExtensions: manifest.fileExtensions,
    bundledUrl: `service-plugins/${filename}`,
    description: 'Keep your saved documents in sync with your own server and database. No account required.',
    descriptionZh: '将已保存的文档增量同步到自己的服务器和数据库，无需注册登录。',
    updateCatalog: `https://github.com/${repository}/releases/download/service-plugin-catalog/catalog.json`,
  };
  await mkdir(resolve(root, 'public/service-plugins'), { recursive: true });
  await writeFile(resolve(root, 'public/service-plugins', filename), pkg);
  await writeFile(resolve(root, 'src/configs/service-plugins.json'), `${JSON.stringify([descriptor], null, 2)}\n`);
  return { root, manifest, pkg, filename, catalog: [remote] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareServicePlugins();
  console.log('Official service plugin resources prepared; implementation stays outside the application modules.');
}
