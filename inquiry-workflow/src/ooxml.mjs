// .xlsx（Open XML）の中身を「文字列のまま」調べるための最小限の道具。
// XMLをDOMに組み直さないので、触らない部分は1バイトも変わらない。
// Node・ブラウザのどちらでも動く（依存なし）。

const dec = new TextDecoder('utf-8');
const enc = new TextEncoder();
export const toText = (u8) => dec.decode(u8);
export const toBytes = (s) => enc.encode(s);

/** 開始タグの終わり（'>' の位置）を返す。属性値の中の '>' は無視する。 */
export function tagEnd(xml, i) {
  let q = null;
  for (let p = i + 1; p < xml.length; p++) {
    const ch = xml[p];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '>') return p;
  }
  throw new Error('タグが閉じていません');
}

/** 開始タグの文字列から属性値を取り出す（なければ null）。 */
export function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decodeXml(m[1] ?? m[2]) : null;
}

export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

export function encodeXmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}

/** XML 1.0 に書けない文字（制御文字・対になっていないサロゲート）を含むか。 */
export function hasIllegalXmlChar(s) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

// ---- セル番地 ----------------------------------------------------------
export function parseRef(ref) {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  const row = Number(m[2]);
  if (col > 16384 || row > 1048576) return null;
  return { col, row };
}

export function parseRange(range) {
  const [a, b = a] = range.replace(/\$/g, '').split(':');
  const p = parseRef(a);
  const q = parseRef(b);
  if (!p || !q) return null;
  return { c1: Math.min(p.col, q.col), r1: Math.min(p.row, q.row), c2: Math.max(p.col, q.col), r2: Math.max(p.row, q.row), topLeft: a };
}

export const inRange = (rg, p) => p.col >= rg.c1 && p.col <= rg.c2 && p.row >= rg.r1 && p.row <= rg.r2;

// ---- ブック全体 --------------------------------------------------------
function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir + target).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/**
 * 展開済みのファイル一覧（名前→Uint8Array）からブックの構成を読む。
 * 扱えない形式は unsupported に理由を入れて返す（例外にしない）。
 */
export function readWorkbook(files) {
  const unsupported = [];
  const wbPath = 'xl/workbook.xml';
  if (!files[wbPath] || !files['[Content_Types].xml']) {
    return { unsupported: ['E_NOT_XLSX: xlsx（Open XML）のブックではありません'], sheets: [] };
  }
  const ct = toText(files['[Content_Types].xml']);
  if (Object.keys(files).some((n) => /vbaProject\.bin$/i.test(n)) || /macroEnabled/i.test(ct)) {
    unsupported.push('E_MACRO: マクロ付きブック（.xlsm）は対象外です');
  }
  const wb = toText(files[wbPath]);
  if (!/<workbook[\s>]/.test(wb)) unsupported.push('E_XML_SHAPE: 名前空間接頭辞付きのXMLは対象外です');
  const relsText = files['xl/_rels/workbook.xml.rels'] ? toText(files['xl/_rels/workbook.xml.rels']) : '';
  const rels = {};
  for (const m of relsText.matchAll(/<Relationship\b[^>]*>/g)) {
    rels[attr(m[0], 'Id')] = { target: attr(m[0], 'Target'), type: attr(m[0], 'Type') };
  }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const rel = rels[attr(m[0], 'r:id')];
    // 表示状態：visible（属性の省略時も同じ）／hidden／veryHidden。visible 以外はすべて「非表示」として扱う
    const state = attr(m[0], 'state') ?? 'visible';
    sheets.push({
      name: attr(m[0], 'name'),
      path: rel ? resolveTarget('xl/', rel.target) : null,
      isWorksheet: !!rel && /\/worksheet$/.test(rel.type),
      state,
      hidden: state !== 'visible',
    });
  }
  const date1904 = /^(1|true)$/.test(attr(/<workbookPr\b[^>]*>/.exec(wb)?.[0] ?? '', 'date1904') ?? '');
  return { unsupported, sheets, date1904, workbookPath: wbPath };
}

// ---- スタイル（ロック・日付書式の判定に必要な分だけ） -------------------
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

export function isDateFormatCode(code) {
  if (!code || /^general$/i.test(code)) return false;
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '').replace(/E[+-]/gi, '');
  return /[ymdhsge]/i.test(bare);
}

/** styles.xml から cellXfs（セルが s="N" で参照する書式の表）を読む。 */
export function readCellXfs(stylesXml) {
  const custom = {};
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) custom[attr(m[0], 'numFmtId')] = attr(m[0], 'formatCode');
  const xfs = [];
  const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!block) return xfs;
  for (const m of block[1].matchAll(/<xf\b[^>]*?(?:\/>|>([\s\S]*?)<\/xf>)/g)) {
    const numFmtId = Number(attr(m[0], 'numFmtId') ?? 0);
    const formatCode = custom[numFmtId] ?? null;
    const prot = /<protection\b[^>]*>/.exec(m[1] ?? '');
    const locked = !(prot && /^(0|false)$/.test(attr(prot[0], 'locked') ?? '1'));
    xfs.push({
      numFmtId,
      formatCode,
      isDate: formatCode != null ? isDateFormatCode(formatCode) : BUILTIN_DATE_FORMATS.has(numFmtId),
      isText: numFmtId === 49 || formatCode === '@',
      isPercent: formatCode != null ? /%/.test(formatCode.replace(/"[^"]*"/g, '')) : numFmtId === 9 || numFmtId === 10,
      isNumber: formatCode != null ? /[0#]/.test(formatCode.replace(/"[^"]*"/g, '')) : (numFmtId >= 1 && numFmtId <= 11) || (numFmtId >= 37 && numFmtId <= 44) || numFmtId === 48,
      fillId: Number(attr(m[0], 'fillId') ?? 0),
      locked,
    });
  }
  return xfs;
}

// ---- シート ------------------------------------------------------------
/**
 * シートXMLの <sheetData> を走査し、行とセルの位置を記録する。
 * XMLは書き換えない。位置（start/end）は元の文字列に対する添字。
 */
export function scanSheet(xml) {
  if (!/<worksheet[\s>]/.test(xml)) throw new Error('E_XML_SHAPE: worksheet 要素が見つかりません（接頭辞付きXML・グラフシート等は対象外）');
  if (xml.includes('<!--') || xml.includes('<![CDATA[')) throw new Error('E_XML_SHAPE: コメント・CDATAを含むシートXMLは対象外です');
  const sdStart = xml.search(/<sheetData[\s>/]/);
  if (sdStart < 0) throw new Error('E_XML_SHAPE: sheetData が見つかりません');
  const sdTagEnd = tagEnd(xml, sdStart);
  const rows = [];
  let sdInnerEnd;
  let sdEnd;
  if (xml[sdTagEnd - 1] === '/') {
    sdInnerEnd = null; // <sheetData/>（行なし）
    sdEnd = sdTagEnd + 1;
  } else {
    sdInnerEnd = xml.indexOf('</sheetData>', sdTagEnd);
    if (sdInnerEnd < 0) throw new Error('E_XML_SHAPE: sheetData が閉じていません');
    sdEnd = sdInnerEnd + '</sheetData>'.length;
    let p = sdTagEnd + 1;
    while (true) {
      const rs = xml.indexOf('<row', p);
      if (rs < 0 || rs >= sdInnerEnd) break;
      const rte = tagEnd(xml, rs);
      const tag = xml.slice(rs, rte + 1);
      const row = { r: Number(attr(tag, 'r')), start: rs, tagEnd: rte, selfClosing: xml[rte - 1] === '/', cells: [] };
      if (row.selfClosing) {
        row.end = rte + 1;
      } else {
        row.innerEnd = xml.indexOf('</row>', rte);
        row.end = row.innerEnd + '</row>'.length;
        let c = rte + 1;
        while (true) {
          const cs = xml.indexOf('<c', c);
          if (cs < 0 || cs >= row.innerEnd) break;
          if (!/[\s>/]/.test(xml[cs + 2])) { c = cs + 2; continue; }
          const cte = tagEnd(xml, cs);
          const ctag = xml.slice(cs, cte + 1);
          const selfClosing = xml[cte - 1] === '/';
          const end = selfClosing ? cte + 1 : xml.indexOf('</c>', cte) + '</c>'.length;
          const inner = selfClosing ? '' : xml.slice(cte + 1, end - '</c>'.length);
          const f = /<f[\s>/]/.exec(inner);
          row.cells.push({
            ref: attr(ctag, 'r'),
            start: cs,
            end,
            attrs: ctag.slice(2, selfClosing ? -2 : -1),
            s: attr(ctag, 's'),
            t: attr(ctag, 't'),
            inner,
            hasFormula: !!f,
            arrayRef: f ? attr(inner.slice(f.index, tagEnd(inner, f.index) + 1), 'ref') : null,
            isEmpty: !/<(v|is|f)[\s>/]/.test(inner),
          });
          c = end;
        }
      }
      rows.push(row);
      p = row.end;
    }
  }
  const cells = new Map();
  for (const row of rows) for (const c of row.cells) cells.set(c.ref, c);
  const merges = [...xml.matchAll(/<mergeCell\b[^>]*>/g)].map((m) => parseRange(attr(m[0], 'ref'))).filter(Boolean);
  const dim = /<dimension\b[^>]*>/.exec(xml);
  const prot = /<sheetProtection\b[^>]*>/.exec(xml);
  return {
    rows,
    cells,
    merges,
    dimension: dim ? parseRange(attr(dim[0], 'ref')) : null,
    isProtected: !!prot && /^(1|true)$/.test(attr(prot[0], 'sheet') ?? '0'),
    sheetData: { start: sdStart, tagEnd: sdTagEnd, innerEnd: sdInnerEnd, end: sdEnd },
  };
}

/** 共有文字列（sharedStrings.xml）を順番に文字列として読む。 */
export function readSharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) out.push(siText(m[1] ?? ''));
  return out;
}

/**
 * 共有文字列の項目数と、再利用できる項目（書式なしで <t> が1つだけの項目）の「文字列 → 番号」の表を返す。
 * 前後に空白のある文字列は、項目が xml:space="preserve" を持つときだけ再利用できる
 * （持たない項目では、読み手が空白を落としてもよいため）。
 */
export function plainSharedStringIndex(xml) {
  const plain = new Map();
  let size = 0;
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    const t = m[1] == null ? null : /^<t(\s[^>]*)?>([^<]*)<\/t>$/.exec(m[1]);
    if (t) {
      const text = decodeXml(t[2]);
      const preserve = /xml:space\s*=\s*["']preserve["']/.test(t[1] ?? '');
      if ((preserve || text === text.trim()) && !plain.has(text)) plain.set(text, size);
    }
    size++;
  }
  return { size, plain };
}

/** <si> や <is> の中身から表示文字列を取り出す（ふりがな rPh は除く）。 */
export function siText(inner) {
  const noPh = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of noPh.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) s += decodeXml(m[1] ?? '');
  return s;
}

/** セル1つの値を {kind, value, formula} にする。kind: empty/number/string/bool/error */
export function cellValue(cell, sharedStrings) {
  const f = /<f\b[^>]*?(?:\/>|>([\s\S]*?)<\/f>)/.exec(cell.inner);
  const formula = f ? decodeXml(f[1] ?? '') : null;
  const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(cell.inner);
  const raw = v ? decodeXml(v[1] ?? '') : null;
  const base = { formula, hasFormula: cell.hasFormula };
  if (cell.t === 'inlineStr') return { ...base, kind: 'string', value: siText(cell.inner) };
  if (raw == null) return { ...base, kind: 'empty', value: null };
  if (cell.t === 's') return { ...base, kind: 'string', value: sharedStrings[Number(raw)] };
  if (cell.t === 'str') return { ...base, kind: 'string', value: raw };
  if (cell.t === 'b') return { ...base, kind: 'bool', value: raw === '1' };
  if (cell.t === 'e') return { ...base, kind: 'error', value: raw };
  return { ...base, kind: 'number', value: Number(raw) };
}

// ---- 日付 --------------------------------------------------------------
/** 'YYYY-MM-DD' をExcelのシリアル値にする。不正な日付は null。 */
export function dateToSerial(iso, date1904 = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  // 1900年2月以前はExcelの「1900年うるう年」問題があるため扱わない
  if (t < Date.UTC(1900, 2, 1)) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return Math.round((t - epoch) / 86400000);
}

export function serialToDate(serial, date1904 = false) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(epoch + Math.round(serial) * 86400000).toISOString().slice(0, 10);
}
