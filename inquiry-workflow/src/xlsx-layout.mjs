// 原票（.xlsx）を画面に出すために読む。書き換えは一切しない。
//
// - シートごとのセルの値・数式の有無・結合・列幅
// - 入力セルの「候補」（ロック解除／入力規則あり／色付きの空欄）。候補であって確定ではない
// - 見出しの候補（同じ行の左側の文字列、同じ列の上側の文字列）と、型の候補
//
// Node・ブラウザ共通（依存なし）。

import {
  toText, attr, decodeXml, parseRef, parseRange, inRange, serialToDate,
  readWorkbook, readCellXfs, scanSheet, readSharedStrings, cellValue,
} from './ooxml.mjs';

export const colName = (n) => {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
export const refOf = (col, row) => `${colName(col)}${row}`;

/**
 * 原票のセルに元からある内容を、画面に出す文字列にする（空欄は ''）。「　年　月」のようなひな形文字や、記入例の数値など。
 * 参照用の表示であり、回答としては扱わない。日付は YYYY-MM-DD、％は 12.5% の形にする。
 */
export function originalDisplay(v, xf, date1904 = false) {
  if (v.kind === 'string') return v.value ?? '';
  if (v.kind === 'bool') return v.value ? 'TRUE' : 'FALSE';
  if (v.kind !== 'number') return '';
  if (xf?.isDate) return serialToDate(v.value, date1904);
  if (xf?.isPercent) return `${+(v.value * 100).toFixed(10)}%`;
  return String(v.value);
}

/** styles.xml の塗りつぶしを順に読み、単色なら '#RRGGBB'（色が特定できなければ 'solid'）、なければ null。 */
function readFills(stylesXml) {
  const block = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(stylesXml);
  if (!block) return [];
  return [...block[1].matchAll(/<fill\b[^>]*?(?:\/>|>([\s\S]*?)<\/fill>)/g)].map((m) => {
    const pat = /<patternFill\b[^>]*>/.exec(m[1] ?? '');
    if (!pat || attr(pat[0], 'patternType') !== 'solid') return null;
    const fg = /<fgColor\b[^>]*>/.exec(m[1]);
    const rgb = fg ? attr(fg[0], 'rgb') : null;
    return rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb) ? `#${rgb.slice(-6).toUpperCase()}` : 'solid';
  });
}

function readValidations(xml) {
  const out = [];
  for (const m of xml.matchAll(/<dataValidation\b[^>]*?(?:\/>|>([\s\S]*?)<\/dataValidation>)/g)) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    const f1 = /<formula1>([\s\S]*?)<\/formula1>/.exec(m[1] ?? '');
    out.push({
      ranges: (attr(tag, 'sqref') ?? '').split(/\s+/).map(parseRange).filter(Boolean),
      type: attr(tag, 'type'),
      operator: attr(tag, 'operator') ?? 'between',
      formula1: f1 ? decodeXml(f1[1]) : null,
    });
  }
  return out;
}

/**
 * @param {Record<string, Uint8Array>} files 展開済みの原票
 * @returns {{sheets: object[], hiddenSheets: {name:string, state:string}[], byName: Record<string, object>}}
 *   sheets＝表示されているシートだけ（回答項目の抽出・割当て画面の対象）。
 *   hiddenSheets＝非表示（hidden・veryHidden）のシート。対象にしないが、原票の複製にはそのまま残る。
 *   byName＝非表示シートも含む。他のシートの入力規則が、非表示シートのセル範囲を選択肢の参照元にしていることがあるため
 */
export function readLayout(files) {
  const wb = readWorkbook(files);
  const stylesXml = files['xl/styles.xml'] ? toText(files['xl/styles.xml']) : '';
  const xfs = readCellXfs(stylesXml);
  const fills = readFills(stylesXml);
  const shared = files['xl/sharedStrings.xml'] ? readSharedStrings(toText(files['xl/sharedStrings.xml'])) : [];
  const all = [];
  for (const sh of wb.sheets) {
    if (!sh.isWorksheet || !files[sh.path]) continue;
    const xml = toText(files[sh.path]);
    let scan;
    try {
      scan = scanSheet(xml);
    } catch (e) {
      if (sh.hidden) continue; // 非表示シートが読めなくても、表示シートの処理は続ける（選択肢の参照元に使えないだけ）
      throw e;
    }
    const cells = new Map();
    let maxCol = 0;
    let maxRow = 0;
    for (const [ref, c] of scan.cells) {
      const v = cellValue(c, shared);
      const xf = c.s != null ? xfs[Number(c.s)] : undefined;
      const pos = parseRef(ref);
      cells.set(ref, {
        ref, col: pos.col, row: pos.row,
        kind: v.kind, value: v.value, isFormula: c.hasFormula, isEmpty: c.isEmpty,
        locked: xf?.locked ?? true, fill: xf ? fills[xf.fillId] ?? null : null,
        isDate: !!xf?.isDate, isText: !!xf?.isText, isPercent: !!xf?.isPercent, isNumber: !!xf?.isNumber,
        display: c.hasFormula ? '' : originalDisplay(v, xf, wb.date1904), // 原票の元の内容（参照表示用。回答ではない）
      });
      maxCol = Math.max(maxCol, pos.col);
      maxRow = Math.max(maxRow, pos.row);
    }
    const covered = new Map(); // 結合セルの左上以外 → 左上の番地
    for (const m of scan.merges) {
      for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) {
        const ref = refOf(c, r);
        if (ref !== m.topLeft) covered.set(ref, m.topLeft);
      }
      maxCol = Math.max(maxCol, m.c2);
      maxRow = Math.max(maxRow, m.r2);
    }
    const colWidths = {};
    for (const m of xml.matchAll(/<col\b[^>]*>/g)) {
      const w = Number(attr(m[0], 'width'));
      for (let c = Number(attr(m[0], 'min')); c <= Math.min(Number(attr(m[0], 'max')), 200); c++) if (w) colWidths[c] = w;
    }
    all.push({
      name: sh.name, path: sh.path, state: sh.state, hidden: sh.hidden, isProtected: scan.isProtected,
      cells, merges: scan.merges, covered, colWidths, validations: readValidations(xml),
      maxCol: scan.dimension ? Math.max(maxCol, scan.dimension.c2) : maxCol,
      maxRow: scan.dimension ? Math.max(maxRow, scan.dimension.r2) : maxRow,
    });
  }
  const layout = {
    sheets: all.filter((s) => !s.hidden),
    hiddenSheets: all.filter((s) => s.hidden).map((s) => ({ name: s.name, state: s.state })),
    byName: Object.fromEntries(all.map((s) => [s.name, s])),
  };
  for (const s of all) s.candidates = s.hidden ? new Map() : findCandidates(s); // 非表示シートからは入力セル候補を作らない
  return layout;
}

/** 入力セルの候補（番地 → 根拠の一覧）。数式セルと、結合セルの左上以外は候補にしない。 */
function findCandidates(sheet) {
  const out = new Map();
  const add = (ref, why) => {
    const c = sheet.cells.get(ref);
    if (c?.isFormula || sheet.covered.has(ref)) return;
    if (!out.has(ref)) out.set(ref, []);
    if (!out.get(ref).includes(why)) out.get(ref).push(why);
  };
  for (const c of sheet.cells.values()) {
    if (!c.locked) add(c.ref, 'unlocked');
    if (c.isEmpty && c.fill) add(c.ref, 'fill');
  }
  for (const dv of sheet.validations) {
    for (const rg of dv.ranges) {
      for (let r = rg.r1; r <= Math.min(rg.r2, sheet.maxRow); r++) for (let c = rg.c1; c <= Math.min(rg.c2, sheet.maxCol); c++) add(refOf(c, r), 'validation');
    }
  }
  return out;
}

export const REASON_LABEL = { unlocked: 'ロック解除', validation: '入力規則あり', fill: '色付きの空欄' };

/** 入力規則のリストの選択肢を取り出す（"a,b,c" の直接指定と、セル範囲の参照に対応）。 */
function listOptions(layout, sheet, formula1) {
  if (!formula1) return null;
  const f = formula1.trim().replace(/^=/, '');
  if (f.startsWith('"') && f.endsWith('"')) return f.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
  const m = /^(?:'?([^'!]+)'?!)?(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)$/.exec(f);
  if (!m) return null; // 名前の定義や数式による指定は解釈しない
  const src = m[1] ? layout.byName[m[1]] : sheet;
  const rg = parseRange(m[2]);
  if (!src || !rg) return null;
  const out = [];
  for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
    const v = src.cells.get(refOf(c, r))?.value;
    if (v != null && v !== '') out.push(String(v));
  }
  return out.length ? out : null;
}

/**
 * セル1つについて、見出し・型・選択肢の候補を返す。
 * @param {(ref:string)=>boolean} isInput そのシートで入力セルとして扱っている番地か（見出し探しで読み飛ばす）
 */
export function describeCell(layout, sheetName, ref, isInput = () => false) {
  const sheet = layout.byName[sheetName];
  const pos = parseRef(ref);
  const text = (r) => {
    const c = sheet.cells.get(r);
    return c && !c.isFormula && c.kind === 'string' && !isInput(r) && String(c.value).trim() ? String(c.value).trim() : null;
  };
  // 行見出し：同じ行の左側にある文字列（左から順に並べる）
  const left = [];
  for (let c = 1; c < pos.col; c++) {
    const t = text(refOf(c, pos.row));
    if (t) left.push(t);
  }
  // 列見出し：同じ列の上側で最も近い文字列
  let top = null;
  for (let r = pos.row - 1; r >= 1 && !top; r--) top = text(refOf(pos.col, r));
  const rowLabel = left.join(' ');
  const cell = sheet.cells.get(ref);
  const dv = sheet.validations.find((v) => v.ranges.some((rg) => inRange(rg, pos)));
  let type = 'text';
  let options = null;
  if (dv?.type === 'list') {
    options = listOptions(layout, sheet, dv.formula1);
    type = options ? 'choice' : 'text';
  } else if (cell?.isDate || dv?.type === 'date') type = 'date';
  else if (cell?.isText) type = 'text';
  else if (cell?.isPercent) type = 'percent';
  else if (cell?.isNumber || dv?.type === 'whole' || dv?.type === 'decimal') type = 'number';
  const rule = dv && (dv.type === 'whole' || dv.type === 'decimal') && dv.formula1 != null && Number.isFinite(Number(dv.formula1))
    ? { integer: dv.type === 'whole', operator: dv.operator, bound: Number(dv.formula1) }
    : null;
  return {
    sheet: sheetName, cell: ref, col: pos.col, row: pos.row,
    rowLabel, colLabel: top ?? '', label: [rowLabel, top].filter(Boolean).join(' ／ ') || `${sheetName} ${ref}`,
    type, options, rule,
  };
}

/** 入力セル候補すべてについて、見出し・型の候補と根拠をまとめて返す（原票登録時に項目の初期値として使う）。 */
export function describeCandidates(layout) {
  const out = [];
  for (const s of layout.sheets) {
    const isInput = (ref) => s.candidates.has(ref);
    for (const [ref, reasons] of s.candidates) out.push({ ...describeCell(layout, s.name, ref, isInput), reasons });
  }
  return out;
}
