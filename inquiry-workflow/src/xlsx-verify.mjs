// 出力直後の自動照合。原票と出力を突き合わせ、
// 「書くと決めたセルだけが、決めた値・型で変わり、ほかは何も変わっていない」ことを確かめる。
// Node・ブラウザ共通。
//
// ここで保証できるのはファイルの中身（XML）の範囲まで。
// Excelがどう表示・再計算するかは保証しない（READMEの「自動照合で保証できること」参照）。

import { toText, readWorkbook, scanSheet, readSharedStrings, cellValue, dateToSerial } from './ooxml.mjs';

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
    for (const [ref] of targets) if (!o.map.has(ref) && !n.map.has(ref) && targets.get(ref).type !== 'blank') problems.push(`${sh.name}!${ref}: 書かれていません`);
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: { parts: { same: parts.same.length, changed: parts.changed, added: parts.added, removed: parts.removed }, checkedCells, untouchedCells, formulaCells, formulaResultsCleared },
  };
}

function expected(w, date1904) {
  if (w.type === 'blank') return { kind: 'empty', value: null };
  if (w.type === 'number') return { kind: 'number', value: w.value };
  if (w.type === 'date') return { kind: 'number', value: dateToSerial(w.value, date1904) };
  return { kind: 'string', value: w.value.replace(/\r\n?/g, '\n') };
}
