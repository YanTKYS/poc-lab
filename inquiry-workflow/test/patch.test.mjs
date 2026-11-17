import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { strToU8, strFromU8 } from 'fflate';
import { patch, inspect, ensureFullCalcOnLoad } from '../src/xlsx-patch.mjs';
import { verifyWriteBack, compareParts, readAllCells } from '../src/xlsx-verify.mjs';
import { isDateFormatCode, dateToSerial, serialToDate } from '../src/ooxml.mjs';
import { fflateZip as zip } from '../src/zip-fflate.mjs';

const rd = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));
const answers = JSON.parse(readFileSync(new URL('../fixtures/answers.json', import.meta.url), 'utf8'));
const inputCells = JSON.parse(readFileSync(new URL('../fixtures/input-cells.json', import.meta.url), 'utf8'));
// fixtures/genpyo*.xlsx（同じ様式を別のソフトで保存したもの）をすべて試す
const FIXTURES = readdirSync(new URL('../fixtures/', import.meta.url)).filter((f) => /^genpyo.*\.xlsx$/.test(f)).sort().map((f) => f.slice(0, -5));

test('期待値は入力セル62個とちょうど対応している', () => {
  assert.equal(answers.length, 62);
  assert.deepEqual(answers.map((a) => `${a.sheet}!${a.cell}`).sort(), inputCells.map((c) => `${c.sheet}!${c.cell}`).sort());
});

for (const id of FIXTURES) {
  const orig = rd(`fixtures/${id}.xlsx`);

  test(`${id}: 原票を調べられる（4シート、基本情報は保護あり）`, () => {
    const ins = inspect(orig, zip);
    assert.equal(ins.ok, true);
    assert.deepEqual(ins.sheets.map((s) => s.name), ['記入要領', '基本情報', '取組状況', '施設別実績']);
    assert.equal(ins.sheets[1].isProtected, true);
    assert.equal(ins.sheets[3].formulaCount, 13);
  });

  test(`${id}: 無変更往復ではすべての部品が1バイトも変わらない`, () => {
    const r = patch(orig, [], zip);
    assert.equal(r.ok, true);
    const p = compareParts(zip.unzip(orig), zip.unzip(r.bytes));
    assert.deepEqual([p.changed, p.added, p.removed], [[], [], []]);
  });

  test(`${id}: 62セルを書き戻すと、対象セルだけが期待どおりに変わる`, () => {
    const r = patch(orig, answers, zip);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const v = verifyWriteBack(orig, r.bytes, answers, zip);
    assert.deepEqual(v.problems, []);
    assert.equal(v.summary.checkedCells, 62);
    assert.equal(v.summary.formulaResultsCleared, 16);
    assert.deepEqual(v.summary.parts.added, []);
    assert.deepEqual(v.summary.parts.removed, []);
  });

  test(`${id}: 数式は変わらず、古い計算結果だけが消える`, () => {
    const before = readAllCells(zip.unzip(orig));
    const after = readAllCells(zip.unzip(patch(orig, answers, zip).bytes));
    let formulas = 0;
    for (const [sheet, cells] of Object.entries(before)) {
      for (const [ref, c] of cells) {
        if (!c.hasFormula) continue;
        formulas++;
        const n = after[sheet].get(ref);
        assert.equal(n.formula, c.formula, `${sheet}!${ref}`);
        assert.equal(n.kind, 'empty', `${sheet}!${ref} に計算結果が残っている`);
      }
    }
    assert.equal(formulas, 16);
  });

  test(`${id}: formulaResults:'keep' なら数式セルは1バイトも変わらない`, () => {
    const r = patch(orig, answers, zip, { formulaResults: 'keep' });
    const v = verifyWriteBack(orig, r.bytes, answers, zip);
    assert.deepEqual(v.problems, []);
    assert.equal(v.summary.formulaResultsCleared, 0);
  });

  test(`${id}: 同じ入力からは毎回同じバイト列が出る`, () => {
    assert.deepEqual(patch(orig, answers, zip).bytes, patch(orig, answers, zip).bytes);
  });

  test(`${id}: 照合は、対象外のセル・数式・結合の改変を検出する`, () => {
    const out = patch(orig, answers, zip).bytes;
    const tamper = (fn) => {
      const files = zip.unzip(out);
      const path = inspect(orig, zip).sheets.find((s) => s.name === '施設別実績').path;
      files[path] = strToU8(fn(strFromU8(files[path])));
      return verifyWriteBack(orig, zip.zip(files), answers, zip);
    };
    assert.equal(tamper((x) => x).ok, true);
    assert.equal(tamper((x) => x.replace('SUM(C5:C12)', 'SUM(C5:C11)')).ok, false, '数式の改変');
    assert.equal(tamper((x) => x.replace(/<mergeCell\b[^>]*>/, '')).ok, false, '結合セルの削除');
    assert.equal(tamper((x) => x.replace(/(<c r="B5"[^>]*>)/, (m) => m.replace(/ s="\d+"/, ' s="0"'))).ok, false, '対象外セルの書式番号の変更');
    assert.equal(tamper((x) => x.replace(/<v>12345<\/v>/, '<v>12346</v>')).ok, false, '対象セルの値違い');
  });
}

test('書いてはいけない指定は拒否し、1件でも不正なら何も出力しない', () => {
  const orig = rd('fixtures/genpyo.xlsx');
  const good = answers[0];
  const cases = [
    [{ sheet: '施設別実績', cell: 'C13', type: 'number', value: 1 }, 'E_FORMULA'],
    [{ sheet: '取組状況', cell: 'D16', type: 'number', value: 1 }, 'E_MERGE'],
    [{ sheet: '基本情報', cell: 'B4', type: 'text', value: 'x' }, 'E_LOCKED'],
    [{ sheet: '無いシート', cell: 'A1', type: 'text', value: 'x' }, 'E_SHEET'],
    [{ sheet: '取組状況', cell: 'C0', type: 'text', value: 'x' }, 'E_REF'],
    [{ sheet: '取組状況', cell: 'Z99', type: 'text', value: 'x' }, 'E_RANGE'],
    [{ sheet: '取組状況', cell: 'C5', type: 'date', value: '2026-01-01' }, 'E_DATEFMT'],
    [{ sheet: '取組状況', cell: 'C10', type: 'date', value: '2026-02-30' }, 'E_TYPE'],
    [{ sheet: '取組状況', cell: 'C5', type: 'number', value: Number.NaN }, 'E_TYPE'],
    [{ sheet: '取組状況', cell: 'C5', type: 'number', value: '12' }, 'E_TYPE'],
    [{ sheet: '取組状況', cell: 'D5', type: 'text', value: 'a\u0001b' }, 'E_TYPE'],
    [{ ...good }, 'E_DUP'],
  ];
  for (const [w, code] of cases) {
    const r = patch(orig, [good, w], zip);
    assert.equal(r.ok, false, code);
    assert.equal(r.bytes, undefined, code);
    assert.ok(r.errors.some((e) => e.code === code), `${code}: ${JSON.stringify(r.errors)}`);
  }
});

test('対象外の形式（ZIPでない・マクロ付き）を識別する', () => {
  assert.equal(patch(strToU8('xlsxではない'), [], zip).errors[0].code, 'E_NOT_XLSX');
  const files = zip.unzip(rd('fixtures/genpyo.xlsx'));
  files['xl/vbaProject.bin'] = new Uint8Array([1]);
  assert.equal(patch(zip.zip(files), [], zip).errors[0].code, 'E_MACRO');
});

// ---- 原票にセル要素が無い場合の追加（Excelは書式のない空セルを保存しない） ----
function miniBook(sheetData, { shared = null, calcPr = '', date1904 = false } = {}) {
  const files = {
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets>${calcPr}</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/styles.xml': strToU8('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:E9"/><sheetData>${sheetData}</sheetData></worksheet>`),
  };
  if (shared) files['xl/sharedStrings.xml'] = strToU8(shared);
  return zip.zip(files);
}
const sheetXml = (bytes) => strFromU8(zip.unzip(bytes)['xl/worksheets/sheet1.xml']).match(/<sheetData>([\s\S]*)<\/sheetData>/)[1];
const W = (cell, type, value) => ({ sheet: 'S', cell, type, value });

test('セル要素が無い位置には、列・行の順を守って追加する', () => {
  const book = miniBook('<row r="2" spans="1:5"><c r="A2"><v>1</v></c><c r="D2"><v>4</v></c></row><row r="5"/><row r="7"><c r="B7"><v>7</v></c></row>');
  const writes = [W('E2', 'number', 5), W('B2', 'number', 2), W('C2', 'text', 'x'), W('D2', 'number', 40), W('C5', 'number', 55), W('A4', 'number', 44), W('A9', 'text', 'last'), W('A7', 'blank')];
  const r = patch(book, writes, zip);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(
    sheetXml(r.bytes),
    '<row r="2" spans="1:5"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c><c r="C2" t="inlineStr"><is><t xml:space="preserve">x</t></is></c><c r="D2"><v>40</v></c><c r="E2"><v>5</v></c></row>'
    + '<row r="4"><c r="A4"><v>44</v></c></row><row r="5"><c r="C5"><v>55</v></c></row>'
    + '<row r="7"><c r="B7"><v>7</v></c></row><row r="9"><c r="A9" t="inlineStr"><is><t xml:space="preserve">last</t></is></c></row>',
  );
  assert.deepEqual(verifyWriteBack(book, r.bytes, writes, zip).problems, []);
});

test('共有文字列を使うブックでは、末尾に追加して番号で参照する', () => {
  const book = miniBook('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/></row>', {
    shared: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>見出し</t></si></sst>',
  });
  const writes = [W('B1', 'text', 'a & b < c'), W('C1', 'text', ' 前後空白 ')];
  const r = patch(book, writes, zip);
  const files = zip.unzip(r.bytes);
  assert.equal(strFromU8(files['xl/sharedStrings.xml']), '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>見出し</t></si><si><t xml:space="preserve">a &amp; b &lt; c</t></si><si><t xml:space="preserve"> 前後空白 </t></si></sst>');
  assert.equal(sheetXml(r.bytes), '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>');
  assert.deepEqual(verifyWriteBack(book, r.bytes, writes, zip).problems, []);
});

test('日付はシリアル値で書く（1904年基準のブックにも対応）', () => {
  const sd = '<row r="1"><c r="A1" s="1"/></row>';
  assert.match(sheetXml(patch(miniBook(sd), [W('A1', 'date', '2026-11-27')], zip).bytes), /<c r="A1" s="1"><v>46353<\/v><\/c>/);
  assert.match(sheetXml(patch(miniBook(sd, { date1904: true }), [W('A1', 'date', '2026-11-27')], zip).bytes), /<v>44891<\/v>/);
  assert.equal(dateToSerial('2026-11-27'), 46353);
  assert.equal(serialToDate(46353), '2026-11-27');
  assert.equal(dateToSerial('1900-02-28'), null);
});

test('「開いたときに再計算」の指定を workbook.xml に入れる', () => {
  assert.equal(ensureFullCalcOnLoad('<workbook><sheets><sheet/></sheets></workbook>'), '<workbook><sheets><sheet/></sheets><calcPr fullCalcOnLoad="1"/></workbook>');
  assert.equal(ensureFullCalcOnLoad('<workbook><sheets><sheet/></sheets><definedNames></definedNames><extLst/></workbook>'), '<workbook><sheets><sheet/></sheets><definedNames></definedNames><calcPr fullCalcOnLoad="1"/><extLst/></workbook>');
  assert.equal(ensureFullCalcOnLoad('<workbook><calcPr calcId="1"/></workbook>'), '<workbook><calcPr calcId="1" fullCalcOnLoad="1"/></workbook>');
  assert.equal(ensureFullCalcOnLoad('<workbook><calcPr fullCalcOnLoad="0" calcId="1"/></workbook>'), '<workbook><calcPr fullCalcOnLoad="1" calcId="1"/></workbook>');
  const same = '<workbook><calcPr calcId="1" fullCalcOnLoad="1"/></workbook>';
  assert.equal(ensureFullCalcOnLoad(same), same);
});

test('日付の表示形式を見分ける', () => {
  for (const c of ['yyyy/m/d', 'yyyy"年"m"月"d"日"', 'yyyy\\年m\\月d\\日', '[$-411]ggge"年"m"月"d"日"', 'h:mm']) assert.equal(isDateFormatCode(c), true, c);
  for (const c of ['General', '#,##0', '0.0%', '0.00E+00', '@', '#,##0"円"', '[Red]#,##0']) assert.equal(isDateFormatCode(c), false, c);
});

// ---- 共有文字列の count / uniqueCount（既存セルの置換・消去でも、参照数・項目数と一致すること） ----
const SST_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const sst = (count, unique, items) => `<sst ${SST_NS}${count == null ? '' : ` count="${count}"`}${unique == null ? '' : ` uniqueCount="${unique}"`}>${items.join('')}</sst>`;
const sstText = (bytes) => strFromU8(zip.unzip(bytes)['xl/sharedStrings.xml']);
const sstNums = (bytes) => {
  const t = sstText(bytes);
  return { count: +/\scount="(\d+)"/.exec(t)?.[1], unique: +/uniqueCount="(\d+)"/.exec(t)?.[1], items: (t.match(/<si[\s>]/g) ?? []).length };
};
// A1・C1 は項目0「見出し」、B1 は項目1「B」を参照（参照3・項目2）。A2 は空
const sharedBook = (items = ['<si><t>見出し</t></si>', '<si><t>B</t></si>'], count = 3, unique = 2) =>
  miniBook('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>0</v></c></row><row r="2"><c r="A2"/></row>', {
    shared: sst(count, unique, items),
  });

test('共有文字列：既存の文字列セルを別の文字列に置換しても count は増えず、uniqueCount だけ増える', () => {
  const book = sharedBook();
  const w = [W('A1', 'text', 'X')];
  const r = patch(book, w, zip);
  assert.deepEqual(sstNums(r.bytes), { count: 3, unique: 3, items: 3 });
  assert.match(sheetXml(r.bytes), /<c r="A1" t="s"><v>2<\/v><\/c>/);
  assert.deepEqual(verifyWriteBack(book, r.bytes, w, zip).problems, []);
});

test('共有文字列：既存と同じ文字列は新しい項目を作らず、既存の項目を参照する', () => {
  const book = sharedBook();
  const w = [W('A1', 'text', 'B')]; // A1 の置換。参照数は変わらず、項目も増えない
  const r = patch(book, w, zip);
  assert.equal(sstText(r.bytes), sstText(book), '共有文字列の部品が1バイトも変わらない');
  assert.equal(r.report.changedParts.includes('xl/sharedStrings.xml'), false);
  assert.match(sheetXml(r.bytes), /<c r="A1" t="s"><v>1<\/v><\/c>/);
  assert.deepEqual(verifyWriteBack(book, r.bytes, w, zip).problems, []);
});

test('共有文字列：文字列セルを空欄・数値にすると count が減る', () => {
  const book = sharedBook();
  for (const [w, count] of [[W('B1', 'blank'), 2], [W('A1', 'number', 7), 2]]) {
    const r = patch(book, [w], zip);
    assert.deepEqual(sstNums(r.bytes), { count, unique: 2, items: 2 }, JSON.stringify(w));
    assert.deepEqual(verifyWriteBack(book, r.bytes, [w], zip).problems, [], JSON.stringify(w));
  }
  const both = [W('A1', 'blank'), W('B1', 'blank'), W('C1', 'blank')];
  assert.equal(sstNums(patch(sharedBook(), both, zip).bytes).count, 0);
});

test('共有文字列：空だったセルへの追加は count が増える。同じ新しい文字列は1項目にまとめる', () => {
  const book = sharedBook();
  const w1 = [W('A2', 'text', 'B')]; // 既存の項目を参照するだけ
  const r1 = patch(book, w1, zip);
  assert.deepEqual(sstNums(r1.bytes), { count: 4, unique: 2, items: 2 });
  const w2 = [W('A2', 'text', 'Z'), W('B2', 'text', 'Z'), W('C2', 'text', 'Z')]; // B2・C2 は行に無いセル
  const r2 = patch(book, w2, zip);
  assert.deepEqual(sstNums(r2.bytes), { count: 6, unique: 3, items: 3 });
  assert.equal([...sheetXml(r2.bytes).matchAll(/<v>2<\/v>/g)].length, 3, '3セルとも同じ項目（2）を参照');
  assert.deepEqual(verifyWriteBack(book, r2.bytes, w2, zip).problems, []);
});

test('共有文字列：前後に空白のある既存項目（xml:space なし）は、空白が保たれないので再利用しない', () => {
  const book = sharedBook(['<si><t>見出し</t></si>', '<si><t>a </t></si>']);
  const w = [W('A2', 'text', 'a ')];
  const r = patch(book, w, zip);
  assert.deepEqual(sstNums(r.bytes), { count: 4, unique: 3, items: 3 });
  assert.deepEqual(verifyWriteBack(book, r.bytes, w, zip).problems, []);
});

test('共有文字列：書式付き文字列の項目は再利用せず、count・uniqueCount の無い部品には属性を足さない', () => {
  const rich = '<si><r><rPr><b/></rPr><t>太字</t></r></si>';
  const book = sharedBook(['<si><t>見出し</t></si>', rich], null, null);
  const w = [W('A2', 'text', '太字')];
  const r = patch(book, w, zip);
  assert.equal(sstText(r.bytes), `<sst ${SST_NS}><si><t>見出し</t></si>${rich}<si><t xml:space="preserve">太字</t></si></sst>`);
  assert.deepEqual(verifyWriteBack(book, r.bytes, w, zip).problems, []);
});

test('共有文字列：照合は count・uniqueCount のずれを検出する', () => {
  const book = sharedBook();
  const w = [W('A1', 'text', 'X')];
  const out = zip.unzip(patch(book, w, zip).bytes);
  const bad = (fn) => verifyWriteBack(book, zip.zip({ ...out, 'xl/sharedStrings.xml': strToU8(fn(strFromU8(out['xl/sharedStrings.xml']))) }), w, zip);
  assert.equal(bad((x) => x).ok, true);
  assert.equal(bad((x) => x.replace('count="3"', 'count="4"')).ok, false, 'count が実際より多い');
  assert.equal(bad((x) => x.replace('uniqueCount="3"', 'uniqueCount="4"')).ok, false, 'uniqueCount が実際より多い');
  assert.equal(bad((x) => x.replace('count="3"', 'count="2"')).ok, false, 'count が実際より少ない');
});

// ---- 行の属性・内容（<sheetData> 内のセル以外）も照合の対象 ----
for (const id of FIXTURES) {
  test(`${id}: 照合は、行の高さ・非表示などの行属性の改変、行の削除・追加を検出する`, () => {
    const orig = rd(`fixtures/${id}.xlsx`);
    const out = patch(orig, answers, zip).bytes;
    const path = inspect(orig, zip).sheets.find((s) => s.name === '施設別実績').path;
    const tamper = (fn) => {
      const files = zip.unzip(out);
      files[path] = strToU8(fn(strFromU8(files[path])));
      return verifyWriteBack(orig, zip.zip(files), answers, zip);
    };
    const rowTag = (x, r) => new RegExp(`<row r="${r}"[^>]*>`).exec(x)[0];
    assert.equal(tamper((x) => x).ok, true);
    const hidden = tamper((x) => x.replace(rowTag(x, 5), rowTag(x, 5).replace(`<row r="5"`, `<row r="5" hidden="1"`)));
    assert.equal(hidden.ok, false, '行を非表示にする');
    assert.ok(hidden.problems.some((p) => /行5/.test(p)), hidden.problems.join(' / '));
    assert.equal(tamper((x) => x.replace(rowTag(x, 6), rowTag(x, 6).replace(/>$/, ' ht="40" customHeight="1">'))).ok, false, '行の高さを変える');
    assert.equal(tamper((x) => x.replace(/<row r="7"[\s\S]*?<\/row>/, '')).ok, false, '行ごと削除する');
    assert.equal(tamper((x) => x.replace('</sheetData>', '<row r="20"><c r="A20"><v>1</v></c></row></sheetData>')).ok, false, '対象外の行を追加する');
  });
}

test('行：spans は、書き込んだセルが範囲外なら広げる。照合は spans がセルを覆っていることを確かめる', () => {
  const book = miniBook('<row r="2" spans="2:3" ht="20" customHeight="1"><c r="B2"><v>1</v></c></row>');
  const w = [W('E2', 'number', 5), W('A2', 'number', 9)];
  const r = patch(book, w, zip);
  assert.equal(sheetXml(r.bytes), '<row r="2" spans="1:5" ht="20" customHeight="1"><c r="A2"><v>9</v></c><c r="B2"><v>1</v></c><c r="E2"><v>5</v></c></row>');
  assert.deepEqual(verifyWriteBack(book, r.bytes, w, zip).problems, []);
  const files = zip.unzip(r.bytes);
  files['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(files['xl/worksheets/sheet1.xml']).replace('spans="1:5"', 'spans="2:3"'));
  assert.equal(verifyWriteBack(book, zip.zip(files), w, zip).ok, false);
});
