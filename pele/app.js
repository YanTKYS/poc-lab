// Pele と Mermaid.js に同じ Mermaid 記法を渡し、描画結果と所要時間を並べて比較する。
// 片方のエンジンが読込・描画に失敗しても、もう片方と画面全体は動き続けるようにする。
(function () {
  'use strict';

  // 図に使うフォント。Pele は未インストールのフォント名が多いほど初回の文字幅計測が遅くなるため切り替えて比較できるようにする
  const FONTS = {
    ja: '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic UI", "Meiryo", "Noto Sans CJK JP", sans-serif',
    windows: '"Yu Gothic UI", "Meiryo", sans-serif',
    generic: 'sans-serif',
  };
  let font = FONTS.ja;
  const versions = window.VENDOR_VERSIONS || {};
  const $ = (sel) => document.querySelector(sel);

  let mermaidSeq = 0;

  const engines = {
    pele: {
      name: 'Pele',
      src: 'vendor/pele.global.js',
      ready: false,
      mounted: null,
      init() {
        return null; // 初期化APIなし（読込時に全図種別が登録される）
      },
      renderSvg(text) {
        return window.pele.render(text, { fontFamily: font }).svg;
      },
      display(frame, text) {
        this.mounted?.destroy();
        this.mounted = null;
        frame.textContent = '';
        let error;
        const mounted = window.pele.mount(frame, text, { onError: (e) => { error = e; } });
        if (error || mounted.error) {
          mounted.destroy();
          frame.textContent = '';
          throw error || mounted.error;
        }
        this.mounted = mounted;
        const r = mounted.result;
        return { type: r ? r.mermaidType : '（未描画: 表示領域の幅が0）', bytes: r ? r.svg.length : 0 };
      },
    },
    mermaid: {
      name: 'Mermaid.js',
      src: 'vendor/mermaid.min.js',
      ready: false,
      init() {
        window.mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          fontFamily: font,
          themeVariables: { fontFamily: font },
        });
      },
      async render(text) {
        const id = `mmd-${++mermaidSeq}`;
        try {
          return await window.mermaid.render(id, text);
        } finally {
          // 失敗時に一時要素が残らないようにする
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
        }
      },
      async renderSvg(text) {
        return (await this.render(text)).svg;
      },
      async display(frame, text) {
        frame.textContent = '';
        const { svg, diagramType, bindFunctions } = await this.render(text);
        frame.innerHTML = svg;
        bindFunctions?.(frame);
        return { type: diagramType, bytes: svg.length };
      },
    },
  };

  const panes = {};
  for (const key of Object.keys(engines)) {
    const root = document.getElementById(`pane-${key}`);
    const fields = {};
    root.querySelectorAll('[data-field]').forEach((el) => { fields[el.dataset.field] = el; });
    fields.version.textContent = versions[key] ? `v${versions[key]}` : '';
    panes[key] = { root, fields, first: null };
  }

  const fmt = (ms) => `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;

  function setStatus(key, status, label) {
    const badge = panes[key].fields.status;
    badge.dataset.status = status;
    badge.textContent = label;
  }

  function showError(key, err) {
    const el = panes[key].fields.error;
    el.hidden = false;
    el.textContent = describeError(err);
  }

  function clearError(key) {
    const el = panes[key].fields.error;
    el.hidden = true;
    el.textContent = '';
  }

  function describeError(err) {
    if (!err) return '不明なエラー';
    const lines = [`${err.name || 'Error'}: ${err.message || String(err)}`];
    if (err.code) lines.push(`code: ${err.code}`);
    if (err.line) lines.push(`位置: ${err.line}行目 ${err.column || ''}列`.trim());
    if (err.snippet && !String(err.message).includes(err.snippet)) lines.push(err.snippet);
    return lines.join('\n');
  }

  function svgSize(frame) {
    const svg = frame.querySelector(':scope > svg'); // Pele のズームボタン内の svg は除く
    const vb = svg?.viewBox?.baseVal;
    return vb && vb.width ? `${Math.round(vb.width)}×${Math.round(vb.height)}` : '—';
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`スクリプトを読み込めませんでした: ${src}`));
      document.head.appendChild(s);
    });
  }

  async function loadEngine(key) {
    const engine = engines[key];
    const { fields } = panes[key];
    setStatus(key, 'busy', '読込中');
    try {
      const t0 = performance.now();
      await loadScript(engine.src);
      const t1 = performance.now();
      if (!window[key]) throw new Error(`${engine.src} を読み込みましたが、グローバル変数 ${key} が定義されていません`);
      fields.load.textContent = fmt(t1 - t0);
      const hasInit = key === 'mermaid';
      engine.init();
      const t2 = performance.now();
      fields.init.textContent = hasInit ? fmt(t2 - t1) : '不要（読込時に登録済み）';
      engine.ready = true;
      setStatus(key, 'idle', '待機中');
    } catch (err) {
      setStatus(key, 'error', '読込失敗');
      showError(key, err);
    }
  }

  // 描画と計測は同時に走らないよう直列化する
  // body[data-busy] は描画待ち・描画中・計測中を示す（自動テストの待ち合わせにも使う）
  let queue = Promise.resolve();
  let pending = 0;
  const setBusy = (busy) => { document.body.dataset.busy = String(busy); };
  const enqueue = (task) => {
    pending++;
    setBusy(true);
    queue = queue.then(task, task).finally(() => {
      if (--pending === 0 && !timer) setBusy(false);
    });
    return queue;
  };

  const source = $('#source');
  let latestText = '';
  let timer = 0;

  async function displayAll(text) {
    if (text !== latestText) return; // より新しい入力がある
    for (const key of Object.keys(engines)) {
      const engine = engines[key];
      const { fields } = panes[key];
      if (!engine.ready) continue;
      setStatus(key, 'busy', '描画中');
      fields.median.textContent = '—';
      fields.range.textContent = '—';
      try {
        const t0 = performance.now();
        const info = await engine.display(fields.frame, text);
        const ms = performance.now() - t0;
        if (panes[key].first === null) {
          panes[key].first = ms;
          fields.first.textContent = fmt(ms);
        }
        fields.last.textContent = fmt(ms);
        fields.type.textContent = info.type || '—';
        fields.svg.textContent = `${svgSize(fields.frame)} / ${(info.bytes / 1024).toFixed(1)} KB`;
        clearError(key);
        setStatus(key, 'ok', 'OK');
      } catch (err) {
        fields.frame.textContent = '';
        fields.last.textContent = '—';
        fields.type.textContent = '—';
        fields.svg.textContent = '—';
        showError(key, err);
        setStatus(key, 'error', 'エラー');
      }
    }
    $('#summary').textContent = '';
  }

  function requestDisplay() {
    latestText = source.value;
    const text = latestText;
    enqueue(() => displayAll(text));
  }

  source.addEventListener('input', () => {
    clearTimeout(timer);
    setBusy(true);
    timer = setTimeout(() => { timer = 0; requestDisplay(); }, 400);
  });

  // サンプル切替
  const select = $('#sample');
  for (const s of window.SAMPLES) select.add(new Option(s.label, s.key));
  const params = new URLSearchParams(location.search);
  if (window.SAMPLES.some((s) => s.key === params.get('sample'))) select.value = params.get('sample');
  function applySample() {
    source.value = window.SAMPLES.find((s) => s.key === select.value).code;
    const url = new URL(location.href);
    url.searchParams.set('sample', select.value);
    history.replaceState(null, '', url);
    requestDisplay();
  }
  select.addEventListener('change', applySample);

  // 表示幅（狭い画面での見え方を比較する）
  const frameWidth = $('#frame-width');
  frameWidth.addEventListener('change', () => {
    for (const { fields } of Object.values(panes)) {
      fields.frame.style.width = frameWidth.value ? `${frameWidth.value}px` : '';
    }
  });

  // フォント切替（両エンジンに同じフォントを指定する）
  const fontSelect = $('#font');
  function applyFont() {
    font = FONTS[fontSelect.value];
    for (const { fields } of Object.values(panes)) {
      fields.frame.style.fontFamily = font;
      fields.frame.style.setProperty('--pele-font', font);
    }
  }
  fontSelect.addEventListener('change', () => {
    applyFont();
    if (engines.mermaid.ready) engines.mermaid.init();
    requestDisplay();
  });
  applyFont();

  // 描画時間の計測（ウォームアップ後の値のみ集計）
  const benchButton = $('#bench');
  const benchStatus = $('#bench-status');
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function bench() {
    const text = source.value;
    const warmup = Math.max(0, Math.min(50, Number($('#warmup').value) || 0));
    const runs = Math.max(1, Math.min(200, Number($('#runs').value) || 1));
    const coldText = $('#cold-text').checked;
    const medians = {};
    for (const key of Object.keys(engines)) {
      const engine = engines[key];
      const { fields } = panes[key];
      if (!engine.ready) continue;
      benchStatus.textContent = `${engine.name} を計測中…`;
      try {
        for (let i = 0; i < warmup; i++) {
          await engine.renderSvg(text);
          await tick();
        }
        const times = [];
        for (let i = 0; i < runs; i++) {
          if (coldText && key === 'pele') window.pele.forgetTextWidths();
          const t0 = performance.now();
          await engine.renderSvg(text);
          times.push(performance.now() - t0);
          await tick();
        }
        times.sort((a, b) => a - b);
        const mid = times.length >> 1;
        const median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
        medians[key] = median;
        const note = coldText && key === 'pele' ? '、文字幅キャッシュ破棄' : '';
        fields.median.textContent = `${fmt(median)}（${warmup}回捨てて${runs}回${note}）`;
        fields.range.textContent = `${fmt(times[0])} / ${fmt(times[times.length - 1])}`;
      } catch (err) {
        fields.median.textContent = '計測失敗';
        fields.range.textContent = '—';
        showError(key, err);
        setStatus(key, 'error', 'エラー');
      }
    }
    benchStatus.textContent = '';
    const { pele: p, mermaid: m } = medians;
    let summary = '';
    if (p !== undefined && m !== undefined) {
      const faster = p <= m ? `Pele が約 ${(m / p).toFixed(1)} 倍速い` : `Mermaid.js が約 ${(p / m).toFixed(1)} 倍速い`;
      const cond = coldText ? '、Pele は文字幅キャッシュ破棄' : '';
      summary = `ウォームアップ後の中央値: Pele ${fmt(p)} / Mermaid.js ${fmt(m)}（${faster}${cond}）`;
    }
    $('#summary').textContent = summary;
  }

  benchButton.addEventListener('click', () => {
    benchButton.disabled = true;
    clearTimeout(timer);
    timer = 0;
    latestText = source.value;
    enqueue(bench).finally(() => { benchButton.disabled = false; });
  });

  // 起動: Pele → Mermaid の順に逐次読込（並列読込による計測値の干渉を避ける）
  const v = Object.entries(versions).map(([k, ver]) => `${k} ${ver}`).join(' / ');
  $('#versions').textContent = v ? `使用バージョン: ${v}（同梱ファイルを使用、外部CDN不使用）` : 'バージョン情報を取得できませんでした（vendor/versions.js）';
  select.disabled = true;
  benchButton.disabled = true;
  source.value = window.SAMPLES.find((s) => s.key === select.value).code;
  setBusy(true);
  (async () => {
    await loadEngine('pele');
    await loadEngine('mermaid');
    select.disabled = false;
    benchButton.disabled = false;
    document.body.dataset.ready = 'true';
    applySample();
  })();
})();
