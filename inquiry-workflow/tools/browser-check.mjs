// 方式Bがブラウザ内（静的ファイルのみ・外部通信なし）で動くかを確かめる。
//
//   node tools/browser-check.mjs
//
// このフォルダを一時的なローカルサーバーで配信し、ヘッドレスChromiumで
// src/ のコードをそのまま読み込んで62セルを書き戻す。画面（UI）は作らない。
// Playwright はリポジトリ直下の devDependencies（npm ci 済み）を使う。
// 結果は results/browser-check.json に書く。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { patch } from '../src/xlsx-patch.mjs';
import { fflateZip as zip } from '../src/zip-fflate.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('@playwright/test')); } catch { ({ chromium } = require('playwright')); }

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAGE = `<!doctype html><meta charset="utf-8"><title>inquiry-workflow browser check</title>
<script type="importmap">{"imports":{"fflate":"./vendor/fflate.js"}}</script>
<script type="module">
import { patch } from './src/xlsx-patch.mjs';
import { verifyWriteBack } from './src/xlsx-verify.mjs';
import { fflateZip } from './src/zip-fflate.mjs';
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
window.run = async (fixture) => {
  const orig = new Uint8Array(await (await fetch('./fixtures/' + fixture + '.xlsx')).arrayBuffer());
  const answers = await (await fetch('./fixtures/answers.json')).json();
  const t0 = performance.now();
  const r = patch(orig, answers, fflateZip);
  const ms = performance.now() - t0;
  const v = verifyWriteBack(orig, r.bytes, answers, fflateZip);
  // 利用者に渡すときは Blob にしてダウンロードさせる（ここでは作れることだけ確認）
  const blob = new Blob([r.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return { ok: r.ok, verifyOk: v.ok, problems: v.problems, ms, size: blob.size, sha256: hex(await crypto.subtle.digest('SHA-256', r.bytes)) };
};
window.ready = true;
</script>`;
const TYPES = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.xlsx': 'application/octet-stream' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
    const file = url.pathname === '/vendor/fflate.js'
      ? path.join(root, 'node_modules/fflate/esm/browser.js') // 静的PoCでは vendor/ に同梱する想定
      : path.join(root, path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) throw new Error('forbidden');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const external = [];
const errors = [];
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(origin)) return route.continue();
  external.push(u);
  return route.abort();
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${origin}/`);
await page.waitForFunction('window.ready === true', null, { timeout: 15000 });

const answers = JSON.parse(await readFile(path.join(root, 'fixtures/answers.json'), 'utf8'));
const results = { generatedBy: 'tools/browser-check.mjs', chromium: browser.version(), externalRequests: external, pageErrors: errors, fixtures: {} };
for (const id of (await readdir(path.join(root, 'fixtures'))).filter((f) => /^genpyo.*\.xlsx$/.test(f)).sort().map((f) => f.slice(0, -5))) {
  const inBrowser = await page.evaluate((f) => window.run(f), id);
  const inNode = patch(new Uint8Array(await readFile(path.join(root, `fixtures/${id}.xlsx`))), answers, zip).bytes;
  const nodeSha = createHash('sha256').update(inNode).digest('hex');
  results.fixtures[id] = { ...inBrowser, ms: Math.round(inBrowser.ms * 10) / 10, sameBytesAsNode: inBrowser.sha256 === nodeSha };
}
await browser.close();
server.close();
await writeFile(path.join(root, 'results/browser-check.json'), `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results, null, 1));
const allOk = !external.length && !errors.length && Object.values(results.fixtures).every((f) => f.ok && f.verifyOk && f.sameBytesAsNode);
process.exit(allOk ? 0 : 1);
