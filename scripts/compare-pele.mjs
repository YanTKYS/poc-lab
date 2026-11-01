// One-off, offline evidence capture. See pele/README.md for provenance and limits.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv[2];
if (!baseline) throw new Error('Usage: node scripts/compare-pele.mjs /path/to/pele-1.8.0.global.js [chromium-path]');
const out = path.join(root, 'evidence/pele-1.13.0');
await mkdir(out, { recursive: true });
const font = '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans CJK JP", sans-serif';
const hash = (s) => createHash('sha256').update(s).digest('hex');
if (hash(await readFile(baseline)) !== '9bf34b3a9a19351dc69d0d238e365560331a8ae392c41656df7f5090653253d0') {
  throw new Error('Baseline must be the verified npm pele@1.8.0 dist/pele.global.js');
}
const browser = await chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
const results = { viewport: { width: 1400, height: 1000 }, browser: browser.version(), font, samples_sha256: hash(await readFile(path.join(root, 'pele/samples.js'))), libraries: {}, cases: [], other_samples: [] };
try {
  for (const [engine, version, file] of [
    ['pele', '1.8.0', path.resolve(baseline)],
    ['pele', '1.13.0', path.join(root, 'node_modules/pele/dist/pele.global.js')],
    ['mermaid', '12.1.0', path.join(root, 'node_modules/mermaid/dist/mermaid.min.js')],
  ]) {
    results.libraries[`${engine}-${version}`] = { sha256: hash(await readFile(file)) };
    for (const width of [null, 660, 360]) {
      const page = await browser.newPage({ viewport: results.viewport, locale: 'ja-JP', deviceScaleFactor: 1 });
      const external = [];
      await page.route('**/*', (route) => { external.push(route.request().url()); return route.abort(); });
      await page.setContent('<!doctype html><html lang="ja"><body style="margin:0;background:white"><div id="diagram"></div></body></html>');
      await page.addStyleTag({ path: path.join(root, 'pele/style.css') });
      await page.addScriptTag({ path: path.join(root, 'pele/samples.js') });
      await page.addScriptTag({ path: file });
      const record = await page.evaluate(async ({ engine, width, font }) => {
        const host = document.querySelector('#diagram');
        host.style.fontFamily = font; host.style.setProperty('--pele-font', font);
        host.style.width = width ? `${width}px` : 'max-content';
        const code = window.SAMPLES.find((s) => s.key === 'flowchart-complex').code;
        await document.fonts.ready;
        if (engine === 'pele') {
          if (width) {
            const mounted = window.pele.mount(host, code);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            if (mounted.error) throw mounted.error;
          } else host.innerHTML = window.pele.render(code, { fontFamily: font }).svg;
        } else {
          window.mermaid.initialize({ startOnLoad: false, suppressErrorRendering: true, fontFamily: font, themeVariables: { fontFamily: font } });
          host.innerHTML = (await window.mermaid.render('evidence', code)).svg;
        }
        const svg = host.querySelector(':scope > svg');
        if (!width) { svg.style.maxWidth = 'none'; svg.style.width = svg.viewBox.baseVal.width + 'px'; }
        const box = (node) => {
          const b = node.getBBox(), m = node.getCTM();
          const a = new DOMPoint(b.x, b.y).matrixTransform(m), z = new DOMPoint(b.x+b.width, b.y+b.height).matrixTransform(m);
          return { x: a.x, y: a.y, width: z.x-a.x, height: z.y-a.y };
        };
        const nodes = Object.fromEntries(['W','M','K','GW'].map((id) => {
          const node = engine === 'pele' ? svg.querySelector(`.pele-node[data-id="${id}"]`) : svg.querySelector(`.node[id*="-flowchart-${id}-"]`);
          if (!node) throw new Error(`Missing node ${id}`);
          return [id, { label: node.textContent, transform: node.getAttribute('transform'), box: box(node) }];
        }));
        const edges = ['W','M','K'].map((id) => {
          const p = engine === 'pele' ? svg.querySelector(`.pele-edge[data-id="L_${id}_GW_0"] > path:not(.pele-marker)`) : svg.querySelector(`path[data-id="L_${id}_GW_0"]`);
          if (!p) throw new Error(`Missing edge ${id}`);
          const start=p.getPointAtLength(0), end=p.getPointAtLength(p.getTotalLength());
          return { from:id, to:'GW', d:p.getAttribute('d'), start:{x:start.x,y:start.y}, end:{x:end.x,y:end.y} };
        });
        return { svg: svg.outerHTML, viewBox: svg.getAttribute('viewBox'), displayed: { width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height }, nodes, edges };
      }, { engine, width, font });
      const name = `${engine}-${version}-${width ?? 'default'}`;
      await writeFile(path.join(out, `${name}.svg`), record.svg);
      // Full diagram, at the same CSS pixel scale for each condition.
      await page.locator('#diagram').screenshot({ path: path.join(out, `${name}.png`) });
      // Crop the entrance-to-gateway region in default LR at native scale.
      if (!width) {
        const crop = await page.evaluate(({engine}) => {
          const svg=document.querySelector('#diagram > svg');
          const boxes=['W','M','K','GW'].map(id => (engine==='pele' ? svg.querySelector(`.pele-node[data-id="${id}"]`) : svg.querySelector(`.node[id*="-flowchart-${id}-"]`)).getBoundingClientRect());
          const x=Math.max(0,Math.min(...boxes.map(b=>b.x))-24), y=Math.max(0,Math.min(...boxes.map(b=>b.y))-32);
          return {x,y,width:Math.max(...boxes.map(b=>b.right))+24-x,height:Math.max(...boxes.map(b=>b.bottom))+32-y};
        },{engine});
        await page.screenshot({ path:path.join(out,`${engine}-${version}-entrances.png`),clip:crop });
      }
      if (external.length) throw new Error(`Unexpected external requests: ${external.length}`);
      const { svg, ...data } = record;
      results.cases.push({ engine, version, width, ...data, svg_sha256: hash(svg), external_requests: external.length });
      // render() regression and optional timing: same 3 warmups + 10 runs, default width.
      if (engine === 'pele' && width === null) {
        results.other_samples.push(...await page.evaluate(({version,font}) => window.SAMPLES.map(s=>{
          const r=window.pele.render(s.code,{fontFamily:font});
          const warmup=3,runs=10;
          for(let i=0;i<warmup;i++) window.pele.render(s.code,{fontFamily:font});
          const measure=(cold)=>{const times=[];for(let i=0;i<runs;i++){if(cold)window.pele.forgetTextWidths();const start=performance.now();window.pele.render(s.code,{fontFamily:font});times.push(performance.now()-start);}times.sort((a,b)=>a-b);return {median_ms:(times[4]+times[5])/2,min_ms:times[0],max_ms:times[9]};};
          return {version,sample:s.key,type:r.mermaidType,bytes:r.svg.length,svg:r.svg,warmup,runs,cached:measure(false),forget_text_widths:measure(true)};
        }),{version,font}));
      }
      await page.close();
    }
  }
  for (const record of results.other_samples) { record.svg_sha256=hash(record.svg); delete record.svg; }
  // Also capture the actual comparison UI, with baseline JS replaced locally.
  // Never connect to a CDN or a provider during browser capture.
  const origin = 'http://127.0.0.1:4189';
  const server = spawn(process.execPath, [path.join(root, 'scripts/serve.mjs'), '4189'], { cwd: root, stdio: 'ignore', env: { ...process.env, PORT: '4189' } });
  results.ui = [];
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) throw new Error('Evidence server could not start (port 4189 must be free)');
      try { ready = (await fetch(origin + '/poc-lab/')).ok; } catch {}
      if (ready) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!ready || server.exitCode !== null) throw new Error('Evidence server not ready');
    for (const version of ['1.8.0', '1.13.0']) {
      const page = await browser.newPage({ viewport: results.viewport, locale: 'ja-JP', deviceScaleFactor: 1 });
      const external = [], failures = [], errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.status() >= 400) failures.push(r.url()); });
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(url.href); return route.abort(); }
        if (version === '1.8.0' && url.pathname.endsWith('/vendor/pele.global.js')) return route.fulfill({ path: path.resolve(baseline), contentType: 'text/javascript' });
        if (version === '1.8.0' && url.pathname.endsWith('/vendor/versions.js')) return route.fulfill({ body: 'window.VENDOR_VERSIONS={pele:"1.8.0",mermaid:"12.1.0"};', contentType: 'text/javascript' });
        return route.continue();
      });
      await page.goto(origin + '/poc-lab/pele/?sample=flowchart-complex');
      await page.waitForFunction(() => document.body.dataset.ready === 'true' && document.body.dataset.busy === 'false');
      await page.locator('#pane-pele [data-field="frame"] > svg').waitFor();
      for (const width of ['normal', '360']) {
        if (width === '360') {
          await page.selectOption('#frame-width', '360');
          await page.waitForFunction(() => { const s=document.querySelector('#pane-pele [data-field="frame"] > svg'); return s && s.viewBox.baseVal.height > s.viewBox.baseVal.width && s.getBoundingClientRect().width <= 360; });
        }
        const frames = await page.evaluate(() => Object.fromEntries(['pele','mermaid'].map(engine => {
          const frame=document.querySelector(`#pane-${engine} [data-field="frame"]`), svg=frame.querySelector(':scope > svg');
          return [engine,{ frame_width:frame.getBoundingClientRect().width,svg_width:svg.getBoundingClientRect().width,viewBox:svg.getAttribute('viewBox') }];
        })));
        await page.locator('.compare').screenshot({ path:path.join(out,`ui-pele-${version}-${width}.png`) });
        results.ui.push({ version, width, frames, external_requests:external.length, failed_requests:failures, page_errors:errors });
      }
      if (external.length || failures.length || errors.length) throw new Error('UI capture had unexpected requests or errors');
      await page.close();
    }
  } finally { server.kill('SIGTERM'); }
  await writeFile(path.join(out,'observations.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results.cases.map(c=>({engine:c.engine,version:c.version,width:c.width,viewBox:c.viewBox,displayed:c.displayed,entrance_positions:Object.fromEntries(Object.entries(c.nodes).map(([k,v])=>[k,v.transform])),edges:c.edges})),null,2));
} finally { await browser.close(); }
