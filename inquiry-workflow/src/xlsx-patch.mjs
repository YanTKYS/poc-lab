// 方式B：原票（.xlsx）の「指定したセルの値だけ」を書き換える。
//
// - ZIPを展開し、対象シートのXMLのうち対象セルの <c> 要素だけを置き換える。
// - それ以外の部品（書式・図形・入力規則・保護・他シート等）はバイト単位でそのまま戻す。
// - 1つでも書けないセルがあれば、何も出力しない（全部成功か、全部中止か）。
//
// Node・ブラウザ共通。ZIPの展開と圧縮は引数 zip（{unzip, zip}）で渡す。

import {
  toText, toBytes, attr, tagEnd, encodeXmlText, hasIllegalXmlChar,
  parseRef, inRange, readWorkbook, readCellXfs, scanSheet, dateToSerial, plainSharedStringIndex,
} from './ooxml.mjs';

const err = (code, w, message) => ({ code, sheet: w?.sheet ?? null, cell: w?.cell ?? null, message });

/** 原票を調べ、扱える形式かどうかとシートの概要を返す（書き込みはしない）。 */
export function inspect(bytes, zip) {
  let files;
  try {
    files = zip.unzip(bytes);
  } catch {
    return { ok: false, unsupported: ['E_NOT_XLSX: ZIPとして開けません（旧形式 .xls、暗号化されたブック等は対象外）'], sheets: [] };
  }
  const wb = readWorkbook(files);
  const sheets = [];
  for (const sh of wb.sheets) {
    const info = { name: sh.name, path: sh.path, supported: false, state: sh.state, hidden: sh.hidden };
    if (!sh.isWorksheet || !files[sh.path]) {
      info.reason = 'ワークシートではありません（グラフシート等）';
    } else {
      try {
        const sc = scanSheet(toText(files[sh.path]));
        Object.assign(info, {
          supported: true,
          isProtected: sc.isProtected,
          cellCount: sc.cells.size,
          formulaCount: [...sc.cells.values()].filter((c) => c.hasFormula).length,
          mergeCount: sc.merges.length,
        });
      } catch (e) {
        info.reason = e.message;
      }
    }
    sheets.push(info);
  }
  return { ok: wb.unsupported.length === 0, unsupported: wb.unsupported, sheets, files, workbook: wb };
}

/**
 * @param {Uint8Array} bytes 原票
 * @param {{sheet:string, cell:string, type:'number'|'text'|'date'|'blank', value?:any}[]} writes
 * @param {{unzip:Function, zip:Function}} zip
 * @param {{recalcOnLoad?:boolean, formulaResults?:'clear'|'keep', allowLocked?:boolean}} [options]
 *   formulaResults: 数式セルに保存されている「前回の計算結果」の扱い。
 *     'clear'（既定）= 消す。数式そのものは変えない。古い合計が残って見えるのを防ぐ。
 *     'keep' = 残す。数式セルには一切触れないが、再計算しない閲覧環境では古い結果が見える。
 * @returns {{ok:boolean, errors:object[], warnings:object[], bytes?:Uint8Array, report?:object}}
 */
export function patch(bytes, writes, zip, options = {}) {
  const { recalcOnLoad = true, formulaResults = 'clear', allowLocked = false } = options;
  const ins = inspect(bytes, zip);
  if (!ins.ok) return { ok: false, errors: ins.unsupported.map((m) => err(m.split(':')[0], null, m)), warnings: [] };
  const { files, workbook } = ins;
  const errors = [];
  const warnings = [];

  const xfs = files['xl/styles.xml'] ? readCellXfs(toText(files['xl/styles.xml'])) : [];
  const ssPath = Object.keys(files).find((n) => /^xl\/sharedStrings\.xml$/i.test(n));
  // 共有文字列を使うブックでは、文字列を共有文字列の表に入れてセルから番号で参照する。
  // 既存の項目と同じ文字列は、新しい項目を作らずその番号を使う（uniqueCount を正しく保つため）
  const sstIndex = ssPath ? plainSharedStringIndex(toText(files[ssPath])) : null;
  const newStrings = []; // 末尾に追加する <si>
  const newIndex = new Map(); // 追加する文字列 → 番号
  const sstNumberFor = (text) => {
    if (sstIndex.plain.has(text)) return sstIndex.plain.get(text);
    if (!newIndex.has(text)) {
      newIndex.set(text, sstIndex.size + newStrings.length);
      newStrings.push(`<si><t xml:space="preserve">${encodeXmlText(text)}</t></si>`);
    }
    return newIndex.get(text);
  };

  // ---- 1. すべての書き込みを検査する（この段階では何も変えない） ----
  const bySheet = new Map();
  const seen = new Set();
  for (const w of writes) {
    const key = `${w.sheet}!${w.cell}`;
    if (seen.has(key)) { errors.push(err('E_DUP', w, '同じセルが2回指定されています')); continue; }
    seen.add(key);
    const sh = workbook.sheets.find((s) => s.name === w.sheet);
    if (!sh) { errors.push(err('E_SHEET', w, 'シートがありません')); continue; }
    const info = ins.sheets.find((s) => s.name === w.sheet);
    if (!info.supported) { errors.push(err('E_XML_SHAPE', w, info.reason)); continue; }
    // 非表示シートは回答の対象にしない。原票の複製に、元のまま残す
    if (info.hidden) { errors.push(err('E_HIDDEN', w, `非表示シート（${info.state}）には書き込めません`)); continue; }
    const pos = parseRef(String(w.cell));
    if (!pos) { errors.push(err('E_REF', w, 'セル番地が不正です')); continue; }
    if (!bySheet.has(sh.path)) {
      const xml = toText(files[sh.path]);
      bySheet.set(sh.path, { name: sh.name, xml, scan: scanSheet(xml), edits: [] });
    }
    const st = bySheet.get(sh.path);
    const { scan } = st;
    const cell = scan.cells.get(w.cell);

    if (scan.dimension && !inRange(scan.dimension, pos)) {
      errors.push(err('E_RANGE', w, 'シートの使用範囲の外です')); continue;
    }
    const merge = scan.merges.find((m) => inRange(m, pos));
    if (merge && merge.topLeft !== w.cell) {
      errors.push(err('E_MERGE', w, `結合セルの左上（${merge.topLeft}）以外には書けません`)); continue;
    }
    if (cell?.hasFormula) { errors.push(err('E_FORMULA', w, '数式セルには書けません')); continue; }
    const inArray = [...scan.cells.values()].some((c) => c.arrayRef && c.arrayRef.includes(':') && inRange(parseRangeSafe(c.arrayRef), pos));
    if (inArray) { errors.push(err('E_FORMULA', w, '配列数式の範囲内には書けません')); continue; }
    const xf = cell?.s != null ? xfs[Number(cell.s)] : undefined;
    if (scan.isProtected && !allowLocked && (xf?.locked ?? true)) {
      errors.push(err('E_LOCKED', w, '保護されたシートのロックされたセルです（入力欄ではない可能性）')); continue;
    }

    // 値を <c> 要素の中身にする
    let body; // {t, inner} / null は空欄
    if (w.type === 'blank') {
      body = null;
    } else if (w.type === 'number') {
      if (typeof w.value !== 'number' || !Number.isFinite(w.value)) { errors.push(err('E_TYPE', w, '数値ではありません')); continue; }
      if (xf?.isText) warnings.push(err('W_NUM_IN_TEXT', w, '文字列書式のセルに数値を書いています'));
      body = { t: null, inner: `<v>${String(w.value)}</v>` };
    } else if (w.type === 'date') {
      const serial = typeof w.value === 'string' ? dateToSerial(w.value, workbook.date1904) : null;
      if (serial == null) { errors.push(err('E_TYPE', w, '日付は YYYY-MM-DD で指定してください（1900-03-01以降）')); continue; }
      if (!xf?.isDate) { errors.push(err('E_DATEFMT', w, 'セルの表示形式が日付ではありません（数値として表示されてしまう）')); continue; }
      body = { t: null, inner: `<v>${serial}</v>` };
    } else if (w.type === 'text') {
      if (typeof w.value !== 'string' || w.value === '') { errors.push(err('E_TYPE', w, '空でない文字列を指定してください（空欄は type:"blank"）')); continue; }
      if (hasIllegalXmlChar(w.value)) { errors.push(err('E_TYPE', w, 'XMLに書けない制御文字を含んでいます')); continue; }
      const normalized = w.value.replace(/\r\n?/g, '\n');
      if (ssPath) {
        body = { t: 's', inner: `<v>${sstNumberFor(normalized)}</v>` };
      } else {
        body = { t: 'inlineStr', inner: `<is><t xml:space="preserve">${encodeXmlText(normalized)}</t></is>` };
      }
    } else {
      errors.push(err('E_TYPE', w, `未対応の型です: ${w.type}`)); continue;
    }
    st.edits.push({ w, pos, cell, body });
  }
  if (errors.length) return { ok: false, errors, warnings };

  // ---- 2. 書き換える ----
  const out = { ...files };
  const report = { cells: [], changedParts: [] };
  const opsByPath = new Map();
  for (const [path, st] of bySheet) {
    const { xml, scan } = st;
    const ops = []; // {at, del, text} 元の文字列に対する置換。後ろから適用する
    const added = new Map(); // 行番号 → 追加するセル（原票にセル要素が無い場合）
    for (const e of st.edits) {
      const { w, pos, cell, body } = e;
      if (cell) {
        if (body == null && cell.isEmpty) { report.cells.push({ sheet: w.sheet, cell: w.cell, action: 'unchanged' }); continue; }
        ops.push({ at: cell.start, del: cell.end - cell.start, text: buildCell(stripT(cell.attrs), body) });
        report.cells.push({ sheet: w.sheet, cell: w.cell, action: 'replaced' });
        continue;
      }
      if (body == null) { report.cells.push({ sheet: w.sheet, cell: w.cell, action: 'unchanged' }); continue; }
      // 原票にセル要素が無い（書式も値も無い空セル）→ 行の正しい位置に追加する
      if (!added.has(pos.row)) added.set(pos.row, []);
      added.get(pos.row).push({ col: pos.col, text: buildCell(` r="${w.cell}"`, body) });
      report.cells.push({ sheet: w.sheet, cell: w.cell, action: 'inserted' });
    }
    for (const [r, cs] of added) {
      cs.sort((a, b) => a.col - b.col);
      const row = scan.rows.find((x) => x.r === r);
      if (!row) {
        // 行そのものが無い → 行番号の順になる位置に行ごと追加する
        const next = scan.rows.find((x) => x.r > r);
        const sd = scan.sheetData;
        if (sd.innerEnd == null) throw new Error('E_XML_SHAPE: 行が1つもないシートへの追加は未対応です');
        ops.push({ at: next ? next.start : sd.innerEnd, del: 0, text: `<row r="${r}">${cs.map((c) => c.text).join('')}</row>`, order: r });
      } else if (row.selfClosing) {
        // <row .../> → <row ...>セル</row>。spans は目安の属性なので外す
        const open = xml.slice(row.start, row.tagEnd - 1).replace(/\s+spans\s*=\s*"[^"]*"/, '').replace(/\s+$/, '');
        ops.push({ at: row.start, del: row.end - row.start, text: `${open}>${cs.map((c) => c.text).join('')}</row>` });
      } else {
        for (const c of cs) {
          const next = row.cells.find((x) => parseRef(x.ref).col > c.col);
          ops.push({ at: next ? next.start : row.innerEnd, del: 0, text: c.text, order: c.col });
        }
        // spans（行にあるセルの列の範囲。読み手への目安）が、追加したセルを含まなければ広げる
        const open = xml.slice(row.start, row.tagEnd + 1);
        const sp = /\sspans\s*=\s*"(\d+):(\d+)"/.exec(open);
        if (sp) {
          const lo = Math.min(Number(sp[1]), ...cs.map((c) => c.col));
          const hi = Math.max(Number(sp[2]), ...cs.map((c) => c.col));
          if (lo !== Number(sp[1]) || hi !== Number(sp[2])) {
            ops.push({ at: row.start, del: open.length, text: open.replace(sp[0], ` spans="${lo}:${hi}"`) });
          }
        }
      }
    }
    if (ops.length) opsByPath.set(path, ops);
  }

  const wrote = opsByPath.size > 0;
  // 値を1つでも書いたら、表示シートの数式セルから古い計算結果（<v>）を取り除く。
  // <f>（数式）は変えない。別シートを参照する数式もあるので、書いていないシートも対象にする。
  // ただし非表示シートは、内容・数式・保存済みの計算結果とも元のまま（1バイトも変えない）
  if (wrote && formulaResults === 'clear') {
    let cleared = 0;
    for (const info of ins.sheets) {
      if (!info.supported || info.hidden) continue;
      if (!bySheet.has(info.path)) {
        const xml = toText(files[info.path]);
        bySheet.set(info.path, { name: info.name, xml, scan: scanSheet(xml), edits: [] });
      }
      const { xml, scan } = bySheet.get(info.path);
      for (const c of scan.cells.values()) {
        if (!c.hasFormula || !/<v[\s>/]/.test(c.inner)) continue;
        const inner = c.inner.replace(/<v\b[^>]*?(?:\/>|>[\s\S]*?<\/v>)/, '');
        if (!opsByPath.has(info.path)) opsByPath.set(info.path, []);
        opsByPath.get(info.path).push({ at: c.start, del: c.end - c.start, text: `<c${stripT(c.attrs)}>${inner}</c>` });
        cleared++;
      }
    }
    report.formulaResultsCleared = cleared;
  }

  for (const [path, ops] of opsByPath) {
    const { xml } = bySheet.get(path);
    // 後ろから適用する。同じ位置では「置換 → 挿入（列・行の大きい順）」の順に適用すると、
    // 結果は 挿入（小さい順）→ 置換後のセル の並びになる
    ops.sort((a, b) => b.at - a.at || (b.del > 0) - (a.del > 0) || (b.order ?? 0) - (a.order ?? 0));
    let s = xml;
    for (const op of ops) s = s.slice(0, op.at) + op.text + s.slice(op.at + op.del);
    out[path] = toBytes(s);
    report.changedParts.push(path);
  }

  if (wrote && ssPath) {
    // count は「文字列セルの参照の総数」。書き換えたシートで、書き換え前後の参照数の差だけ増減させる
    // （既存の文字列セルの置換では増えず、消去では減る）。uniqueCount は項目数なので、追加した項目の数だけ増やす
    let refsDelta = 0;
    for (const path of opsByPath.keys()) refsDelta += countSharedRefs(toText(out[path])) - countSharedRefs(bySheet.get(path).xml);
    report.sharedStrings = { appended: newStrings.length, refsDelta };
    if (newStrings.length || refsDelta !== 0) {
      out[ssPath] = toBytes(updateSharedStrings(toText(files[ssPath]), newStrings, refsDelta));
      report.changedParts.push(ssPath);
    }
  }
  if (wrote && recalcOnLoad) {
    const before = toText(files[workbook.workbookPath]);
    const after = ensureFullCalcOnLoad(before);
    if (after !== before) {
      out[workbook.workbookPath] = toBytes(after);
      report.changedParts.push(workbook.workbookPath);
    }
  }
  return { ok: true, errors: [], warnings, bytes: zip.zip(out), report };
}

const parseRangeSafe = (ref) => {
  const [a, b] = ref.split(':');
  const p = parseRef(a);
  const q = parseRef(b);
  return { c1: p.col, r1: p.row, c2: q.col, r2: q.row };
};

/** <c> の属性から t（値の型）だけを取り除く。r・s（書式）などは残す。 */
const stripT = (attrs) => attrs.replace(/\s+t\s*=\s*(?:"[^"]*"|'[^']*')/, '').replace(/\s+$/, '');

function buildCell(attrs, body) {
  if (body == null) return `<c${attrs}/>`;
  return `<c${attrs}${body.t ? ` t="${body.t}"` : ''}>${body.inner}</c>`;
}

const countSharedRefs = (xml) => [...scanSheet(xml).cells.values()].filter((c) => c.t === 's').length;

/** 共有文字列の表に項目を追加し、count・uniqueCount（元にある場合だけ）を増減させる。 */
function updateSharedStrings(xml, items, refsDelta) {
  const start = xml.search(/<sst[\s>]/);
  const te = tagEnd(xml, start);
  let tag = xml.slice(start, te + 1);
  for (const [name, delta] of [['count', refsDelta], ['uniqueCount', items.length]]) {
    const v = attr(tag, name);
    if (v != null) tag = tag.replace(new RegExp(`(\\s${name}\\s*=\\s*")[^"]*(")`), `$1${Math.max(0, Number(v) + delta)}$2`);
  }
  let rest = xml.slice(te + 1);
  if (tag.endsWith('/>')) {
    tag = `${tag.slice(0, -2)}>`;
    rest = `</sst>${rest}`;
  }
  const close = rest.lastIndexOf('</sst>');
  return xml.slice(0, start) + tag + rest.slice(0, close) + items.join('') + rest.slice(close);
}

/** Excelで開いたときに全数式を再計算させる指定を workbook.xml に入れる。 */
export function ensureFullCalcOnLoad(xml) {
  const m = /<calcPr\b[^>]*>/.exec(xml);
  if (m) {
    const cur = attr(m[0], 'fullCalcOnLoad');
    if (cur === '1' || cur === 'true') return xml;
    const tag = cur != null
      ? m[0].replace(/(\sfullCalcOnLoad\s*=\s*")[^"]*(")/, '$11$2')
      : m[0].replace(/\s*\/?>$/, (end) => ` fullCalcOnLoad="1"${end.trim()}`);
    return xml.slice(0, m.index) + tag + xml.slice(m.index + m[0].length);
  }
  // calcPr が無い場合は、スキーマ上の順序（sheets → … → definedNames → calcPr）に従って追加する
  for (const close of ['</definedNames>', '</externalReferences>', '</functionGroups>', '</sheets>']) {
    const i = xml.indexOf(close);
    if (i >= 0) return `${xml.slice(0, i + close.length)}<calcPr fullCalcOnLoad="1"/>${xml.slice(i + close.length)}`;
  }
  return xml;
}
