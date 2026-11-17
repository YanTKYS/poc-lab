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

// inquiry-workflow: 静的Webアプリ（app/）と、#14 で検証した Excel 入出力コード（src/）を配置する。
// 検証用の道具・テスト・実測結果・node_modules は公開しない。
const iw = path.join(root, 'inquiry-workflow');
const iwDist = path.join(dist, 'inquiry-workflow');
await mkdir(path.join(iwDist, 'lib'), { recursive: true });
await mkdir(path.join(iwDist, 'vendor'), { recursive: true });
await mkdir(path.join(iwDist, 'fixtures'), { recursive: true });
for (const f of ['index.html', 'style.css']) await cp(path.join(iw, f), path.join(iwDist, f));
await cp(path.join(iw, 'app'), path.join(iwDist, 'app'), { recursive: true });
// src/*.mjs は Node のテストと共通のコード。拡張子だけ .js にそろえて配信する
for (const f of ['ooxml', 'xlsx-layout', 'xlsx-patch', 'xlsx-verify']) {
  const code = await readFile(path.join(iw, 'src', `${f}.mjs`), 'utf8');
  await writeFile(path.join(iwDist, 'lib', `${f}.js`), code.replace(/from '\.\/([\w-]+)\.mjs'/g, "from './$1.js'"));
}
// 架空の原票と回答例（デモ用）だけを置く
for (const f of ['genpyo.xlsx', 'answers.json']) await cp(path.join(iw, 'fixtures', f), path.join(iwDist, 'fixtures', f));
versions.fflate = await installedVersion('fflate');
await cp(path.join(modules, 'fflate/esm/browser.js'), path.join(iwDist, 'vendor', 'fflate.js'));
await cp(path.join(modules, 'fflate/LICENSE'), path.join(iwDist, 'vendor', 'LICENSE-fflate.txt'));

console.log(`dist/ を出力しました (pele ${versions.pele}, mermaid ${versions.mermaid}, fflate ${versions.fflate})`);
