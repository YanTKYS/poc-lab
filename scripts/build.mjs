// GitHub Pages / IIS 向けの静的ファイル一式を dist/ に出力する。
// 依存ライブラリは node_modules からコピーし、実行時に外部CDNを参照しない。
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');

// 公開するPoCフォルダ。新しいPoCを追加したらここに追記する。
const POCS = ['pele'];

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

async function installedVersion(name) {
  const p = path.join(root, 'node_modules', name, 'package.json');
  const { version } = JSON.parse(await readFile(p, 'utf8'));
  const expected = pkg.devDependencies[name];
  if (version !== expected) {
    throw new Error(`${name}: package.json は ${expected} 固定ですが、${version} がインストールされています`);
  }
  return version;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(path.join(root, 'index.html'), path.join(dist, 'index.html'));
await writeFile(path.join(dist, '.nojekyll'), '');

for (const poc of POCS) {
  await cp(path.join(root, poc), path.join(dist, poc), {
    recursive: true,
    filter: (src) => !src.endsWith('.md'),
  });
}

// pele: 比較対象ライブラリを vendor/ に配置する
const vendor = path.join(dist, 'pele', 'vendor');
await mkdir(vendor, { recursive: true });
const modules = path.join(root, 'node_modules');
const versions = {
  pele: await installedVersion('pele'),
  mermaid: await installedVersion('mermaid'),
};
await cp(path.join(modules, 'pele/dist/pele.global.js'), path.join(vendor, 'pele.global.js'));
await cp(path.join(modules, 'pele/LICENSE'), path.join(vendor, 'LICENSE-pele.txt'));
await cp(path.join(modules, 'mermaid/dist/mermaid.min.js'), path.join(vendor, 'mermaid.min.js'));
await cp(path.join(modules, 'mermaid/LICENSE'), path.join(vendor, 'LICENSE-mermaid.txt'));
await writeFile(
  path.join(vendor, 'versions.js'),
  `window.VENDOR_VERSIONS = ${JSON.stringify(versions)};\n`,
);

console.log(`dist/ を出力しました (pele ${versions.pele}, mermaid ${versions.mermaid})`);
