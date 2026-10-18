/**
 * Package the incremental-sync plugin: bundle client/src/main.mjs into the
 * single `script` string embedded in the .mokiplugin.json package.
 *
 * Usage: node scripts/pack.mjs
 */
import { build } from 'file:///C:/Code/React/mokidown/node_modules/esbuild/lib/main.js';
import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'client/manifest.json'), 'utf8'));
const output = path.join(root, 'releases/service-plugins');
mkdirSync(output, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'client', manifest.entry)],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  alias: { '@mokidown/sdk': path.join(root, 'sdk/index.mjs') },
});
const script = result.outputFiles[0].text;
const pkg = {
  format: 'mokidown-extension-v1',
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  permissions: manifest.permissions,
  fileExtensions: manifest.fileExtensions,
  script,
};
const filename = `${manifest.id}-${manifest.version}.mokiplugin.json`;
const body = `${JSON.stringify(pkg, null, 2)}\n`;
writeFileSync(path.join(output, filename), body);
const sha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
const catalog = [{
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  url: `https://github.com/hhyufan/mokidown-plugin-incremental-sync/releases/download/v${manifest.version}/${filename}`,
  sha256,
  permissions: manifest.permissions,
  fileExtensions: manifest.fileExtensions,
  description: 'Keep your saved documents in sync with your own server and database.',
  descriptionZh: '将已保存的文档增量同步到自己的服务器和数据库，无需注册登录。',
}];
writeFileSync(path.join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(path.join(output, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
copyFileSync(path.join(output, 'catalog.json'), path.join(root, 'catalog.json'));
console.log(`packed ${filename} (${body.length} bytes)\nsha256 ${sha256}`);
