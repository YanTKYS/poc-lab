// dist/ を GitHub Pages と同じサブパス (/poc-lab/) で配信するローカル確認用サーバー。
// サブパス外へのアクセスは 404 になるため、絶対パス参照の混入を検出できる。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dist = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const base = '/poc-lab/';
const port = Number(process.env.PORT || process.argv[2] || 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(302, { Location: base }).end();
    return;
  }
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404).end('Not Found');
    return;
  }
  let file = path.join(dist, decodeURIComponent(url.pathname.slice(base.length)));
  if (!file.startsWith(dist)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname + '/' }).end();
        return;
      }
      file = path.join(file, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not Found');
  }
}).listen(port, () => {
  console.log(`http://localhost:${port}${base}`);
});
