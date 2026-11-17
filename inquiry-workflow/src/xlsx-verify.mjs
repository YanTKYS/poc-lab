// 出力直後の自動照合。原票と出力を突き合わせ、
// 「書くと決めたセルだけが、決めた値・型で変わり、ほかは何も変わっていない」ことを確かめる。
// Node・ブラウザ共通。
//
// ここで保証できるのはファイルの中身（XML）の範囲まで。
// Excelがどう表示・再計算するかは保証しない（READMEの「自動照合で保証できること」参照）。

import { toText, attr, parseRef, readWorkbook, scanSheet, readSharedStrings, cellValue, dateToSerial } from './ooxml.mjs';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** ZIP内の部品ごとに、同一・変更・追加・削除を分類する（展開後のバイトで比較）。 */
export function compareParts(origFiles, outFiles) {
  const r = { same: [], changed: [], added: [], removed: [] };
  const isDir = (n) => n.endsWith('/'); // フォルダだけの項目は部品ではないので数えない
  for (const n of Object.keys(origFiles)) {
    if (isDir(n)) continue;
    if (!(n in outFiles)) r.removed.push(n);
    else (same(origFiles[n], outFiles[n]) ? r.same : r.changed).push(n);
  }
  for (const n of Object.keys(outFiles)) if (!isDir(n) && !(n in origFiles)) r.added.push(n);
  return r;
}

/**
 * <sheetData> の「セル以外」を行ごとに取り出す（行の開始タグ＝高さ・非表示などの属性、行の中のセル以外の内容、行どうしの間）。
 * spans（行にあるセルの列の範囲を示す目安の属性）は、セルを足すと変わってよいので比較から外す
 * （代わりに、セルを覆っていることを別に確かめる）。
 */
function rowLayout(xml, scan) {
  const norm = (tag) => tag.replace(/\s*\/>$/, '>').replace(/\sspans\s*=\s*"[^"]*"/, '');
  const rows = new Map();
  const order = [];
  let gaps = '';
  let p = scan.sheetData.tagEnd + 1;
  for (const row of scan.rows) {
    gaps += xml.slice(p, row.start);
    let inner = '';
    if (!row.selfClosing) {
      let q = row.tagEnd + 1;
      for (const c of row.cells) { inner += xml.slice(q, c.start); q = c.end; }
      inner += xml.slice(q, row.innerEnd);
    }
    const raw = xml.slice(row.start, row.tagEnd + 1);
    rows.set(row.r, { open: norm(raw), inner, spans: /\sspans\s*=\s*"(\d+):(\d+)"/.exec(raw), cells: row.cells.map((c) => c.ref) });
    order.push(row.r);
    p = row.end;
  }
  gaps += xml.slice(p, scan.sheetData.innerEnd ?? p);
  return { sdOpen: xml.slice(scan.sheetData.start, scan.sheetData.tagEnd + 1), rows, order, gaps };
}

/** シート1枚の全セルを {ref → {raw, s, ...value}} にする。 */
function sheetCells(xml, shared) {
  const scan = scanSheet(xml);
  const map = new Map();
  for (const [ref, c] of scan.cells) map.set(ref, { raw: xml.slice(c.start, c.end), s: c.s, attrs: c.attrs, inner: c.inner, ...cellValue(c, shared) });
  return { scan, map };
}

/** 原票の全シートを読み、{シート名 → Map(番地 → 値)} を返す（照合や一覧表示用）。 */
export function readAllCells(files) {
  const wb = readWorkbook(files);
  const shared = files['xl/sharedStrings.xml'] ? readSharedStrings(toText(files['xl/sharedStrings.xml'])) : [];
  const out = {};
  for (const sh of wb.sheets) if (sh.isWorksheet && files[sh.path]) out[sh.name] = sheetCells(toText(files[sh.path]), shared).map;
  return out;
}

/**
 * @param {Uint8Array} origBytes 原票
 * @param {Uint8Array} outBytes 出力
 * @param {object[]} writes patch() に渡したものと同じ
 * @returns {{ok:boolean, problems:string[], summary:object}}
 */
export function verifyWriteBack(origBytes, outBytes, writes, zip) {
  const problems = [];
  const orig = zip.unzip(origBytes);
  const out = zip.unzip(outBytes);
  const wb = readWorkbook(orig);
  const parts = compareParts(orig, out);
  if (parts.added.length) problems.push(`部品が増えています: ${parts.added.join(', ')}`);
  if (parts.removed.length) problems.push(`部品が消えています: ${parts.removed.join(', ')}`);

  // 変わってよい部品は、ワークシート・共有文字列・workbook.xml だけ。
  // ワークシートの中身は、下でセル単位に「対象セルと数式の計算結果以外は同じ」ことを確かめる
  const sheetPaths = new Set(wb.sheets.map((s) => s.path));
  const ssPath = 'xl/sharedStrings.xml';
  for (const n of parts.changed) {
    if (!sheetPaths.has(n) && n !== ssPath && n !== wb.workbookPath) problems.push(`対象外の部品が変わっています: ${n}`);
  }

  // workbook.xml は「開いたときに再計算」の指定以外は同じであること
  if (parts.changed.includes(wb.workbookPath)) {
    const strip = (x) => x.replace(/<calcPr fullCalcOnLoad="1"\/>/, '').replace(/\sfullCalcOnLoad\s*=\s*"[^"]*"/, '');
    if (strip(toText(orig[wb.workbookPath])) !== strip(toText(out[wb.workbookPath]))) problems.push('workbook.xml が再計算の指定以外でも変わっています');
  }

  // 共有文字列は、元の内容がそのまま残り、末尾への追加だけであること
  const sharedOrig = orig[ssPath] ? readSharedStrings(toText(orig[ssPath])) : [];
  const sharedOut = out[ssPath] ? readSharedStrings(toText(out[ssPath])) : [];
  if (parts.changed.includes(ssPath)) {
    const a = toText(orig[ssPath]).replace(/<sst\b[^>]*>/, '').replace(/<\/sst>\s*$/, '');
    const b = toText(out[ssPath]).replace(/<sst\b[^>]*>/, '');
    if (!b.startsWith(a)) problems.push('共有文字列の既存部分が変わっています');
  }

  let checkedCells = 0;
  let untouchedCells = 0;
  let formulaCells = 0;
  let formulaResultsCleared = 0;
  let sharedRefsOrig = 0;
  let sharedRefsOut = 0;
  let rowsChecked = 0;
  // 数式セルは「数式（<f>）と書式が同じで、計算結果（<v>）だけが消えている」変化だけを認める
  const fOf = (c) => /<f\b[^>]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(c.inner)?.[0];
  const noT = (attrs) => attrs.replace(/\s+t\s*=\s*"[^"]*"/, '').trim();
  const onlyResultCleared = (a, b) => a.hasFormula && b.hasFormula && fOf(a) === fOf(b) && noT(a.attrs) === noT(b.attrs) && !/<v[\s>/]/.test(b.inner) && b.inner === fOf(b);
  for (const sh of wb.sheets) {
    if (!sh.isWorksheet || !orig[sh.path] || !out[sh.path]) continue;
    const ox = toText(orig[sh.path]);
    const nx = toText(out[sh.path]);
    const o = sheetCells(ox, sharedOrig);
    const n = sheetCells(nx, sharedOut);

    // セル以外（結合・入力規則・保護・条件付き書式・列幅・図形への参照など）は1バイトも変わらないこと
    const outside = (x, sc) => x.slice(0, sc.sheetData.start) + x.slice(sc.sheetData.end);
    if (outside(ox, o.scan) !== outside(nx, n.scan)) problems.push(`${sh.name}: セル以外の部分が変わっています`);

    const targets = new Map(writes.filter((w) => w.sheet === sh.name).map((w) => [w.cell, w]));

    // <sheetData> の中のセル以外（行の高さ・非表示・書式などの行属性）も同じであること。
    // 増えてよいのは、書き込みのために追加した行（<row r="N"> にセルだけが入ったもの）だけ
    const lo = rowLayout(ox, o.scan);
    const ln = rowLayout(nx, n.scan);
    if (lo.sdOpen !== ln.sdOpen || lo.gaps !== ln.gaps) problems.push(`${sh.name}: 行と行のあいだの内容が変わっています`);
    const targetRows = new Set([...targets.keys()].map((ref) => parseRef(ref)?.row));
    for (const [r, a] of lo.rows) {
      const b = ln.rows.get(r);
      if (!b) problems.push(`${sh.name}: 行${r}が消えています`);
      else if (a.open !== b.open) problems.push(`${sh.name}: 行${r}の属性が変わっています（旧 ${a.open} → 新 ${b.open}）`);
      else if (a.inner !== b.inner) problems.push(`${sh.name}: 行${r}のセル以外の内容が変わっています`);
    }
    for (const [r, b] of ln.rows) {
      if (lo.rows.has(r)) continue;
      if (!targetRows.has(r) || b.open !== `<row r="${r}">` || b.inner !== '') problems.push(`${sh.name}: 書き込み対象ではない行${r}が追加されています`);
    }
    if (ln.order.some((r, i) => i > 0 && r <= ln.order[i - 1])) problems.push(`${sh.name}: 行の順序が昇順ではありません`);
    for (const [r, b] of ln.rows) {
      const cols = b.cells.map((ref) => parseRef(ref));
      if (cols.some((c) => !c || c.row !== r)) problems.push(`${sh.name}: 行${r}に、別の行のセルが入っています`);
      else if (cols.some((c, i) => i > 0 && c.col <= cols[i - 1].col)) problems.push(`${sh.name}: 行${r}のセルが列の昇順ではありません`);
      else if (b.spans && cols.some((c) => c.col < Number(b.spans[1]) || c.col > Number(b.spans[2]))) problems.push(`${sh.name}: 行${r}の spans が、行にあるセルを含んでいません`);
    }
    rowsChecked += lo.rows.size;
    sharedRefsOrig += [...o.scan.cells.values()].filter((c) => c.t === 's').length;
    sharedRefsOut += [...n.scan.cells.values()].filter((c) => c.t === 's').length;

    for (const ref of new Set([...o.map.keys(), ...n.map.keys()])) {
      const a = o.map.get(ref);
      const b = n.map.get(ref);
      const w = targets.get(ref);
      if (!w) {
        // 書き換え対象外：要素の文字列が完全に同じであること（値・数式・書式番号を含む）
        if (a && b && a.raw === b.raw) untouchedCells++;
        else if (a && b && onlyResultCleared(a, b)) formulaResultsCleared++;
        else problems.push(`${sh.name}!${ref}: 対象外のセルが変わっています`);
        if (a?.hasFormula) formulaCells++;
        continue;
      }
      checkedCells++;
      if (b?.hasFormula) problems.push(`${sh.name}!${ref}: 数式が入っています`);
      if (a && (a.s ?? null) !== (b?.s ?? null)) problems.push(`${sh.name}!${ref}: 書式番号が変わっています (${a.s} → ${b?.s})`);
      const got = b ?? { kind: 'empty', value: null };
      const want = expected(w, wb.date1904);
      if (got.kind !== want.kind || got.value !== want.value) {
        problems.push(`${sh.name}!${ref}: 値が違います（期待 ${want.kind}:${JSON.stringify(want.value)} / 実際 ${got.kind}:${JSON.stringify(got.value)}）`);
      }
    }
    for (const [ref, b] of n.map) if (b.kind === 'string' && b.value === undefined) problems.push(`${sh.name}!${ref}: 共有文字列の番号が表の範囲外です`);
    for (const [ref] of targets) if (!o.map.has(ref) && !n.map.has(ref) && targets.get(ref).type !== 'blank') problems.push(`${sh.name}!${ref}: 書かれていません`);
  }
  // 共有文字列の count（文字列セルの参照の総数）と uniqueCount（項目数）が、実際の増減と合っていること
  if (orig[ssPath] && out[ssPath]) {
    const head = (bytes) => {
      const tag = /<sst\b[^>]*>/.exec(toText(bytes))?.[0] ?? '';
      return { count: attr(tag, 'count'), unique: attr(tag, 'uniqueCount') };
    };
    const ho = head(orig[ssPath]);
    const hn = head(out[ssPath]);
    const want = { count: sharedRefsOut - sharedRefsOrig, unique: sharedOut.length - sharedOrig.length };
    for (const [key, label] of [['count', 'count（参照の総数）'], ['unique', 'uniqueCount（項目数）']]) {
      if (ho[key] != null && Number(hn[key]) !== Math.max(0, Number(ho[key]) + want[key])) {
        problems.push(`共有文字列の${label}が実際の増減と合っていません（元 ${ho[key]}、増減 ${want[key]}、出力 ${hn[key]}）`);
      }
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: { rowsChecked, parts: { same: parts.same.length, changed: parts.changed, added: parts.added, removed: parts.removed }, checkedCells, untouchedCells, formulaCells, formulaResultsCleared },
  };
}

function expected(w, date1904) {
  if (w.type === 'blank') return { kind: 'empty', value: null };
  if (w.type === 'number') return { kind: 'number', value: w.value };
  if (w.type === 'date') return { kind: 'number', value: dateToSerial(w.value, date1904) };
  return { kind: 'string', value: w.value.replace(/\r\n?/g, '\n') };
}
