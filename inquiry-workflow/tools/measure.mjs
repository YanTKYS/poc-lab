// 無変更往復・セル値書き戻しの実測（Nodeで動く部分）。
//
//   node tools/measure.mjs
//
// 方式A（ExcelJS で読み書き）と方式B（対象セルだけXMLを書き換え）を、
// 2つの原票（openpyxl生成／LibreOffice保存）に対して実行し、
// 出力を out/ に、結果を results/measure.json に書く。
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { patch } from '../src/xlsx-patch.mjs';
import { compareParts, verifyWriteBack } from '../src/xlsx-verify.mjs';
import { fflateZip as zip } from '../src/zip-fflate.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const rd = (p) => new Uint8Array(readFileSync(path.join(root, p)));
const answers = JSON.parse(readFileSync(path.join(root, 'fixtures/answers.json'), 'utf8'));
mkdirSync(path.join(root, 'out'), { recursive: true });
mkdirSync(path.join(root, 'results'), { recursive: true });

// fixtures/genpyo*.xlsx をすべて対象にする。同じ様式を別のソフトで保存し直したもの
// （例: Excelで開いて保存した genpyo-excel.xlsx）を置けば、そのまま追加で測れる。
const LABELS = { genpyo: 'openpyxl生成', 'genpyo-lo': 'LibreOffice保存', 'genpyo-excel': 'Excel保存' };
export const FIXTURES = readdirSync(path.join(root, 'fixtures'))
  .filter((f) => /^genpyo.*\.xlsx$/.test(f))
  .sort()
  .map((f) => ({ id: f.slice(0, -5), label: LABELS[f.slice(0, -5)] ?? '追加の原票' }));

const partsSummary = (a, b) => {
  const p = compareParts(zip.unzip(a), zip.unzip(b));
  return { same: p.same.length, changed: p.changed, added: p.added, removed: p.removed };
};

/** ExcelJS で読んだ全セルを {シート!番地 → 値の文字列} にする（第三者の読み取り結果として使う）。 */
export async function readWithExcelJS(bytes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const cells = new Map();
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const v = cell.value;
        let norm;
        if (v instanceof Date) norm = { date: v.toISOString().slice(0, 10) };
        else if (v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)) norm = { formula: v.formula ?? `shared:${v.sharedFormula}` };
        else if (v && typeof v === 'object' && v.richText) norm = v.richText.map((r) => r.text).join('');
        else norm = v;
        cells.set(`${ws.name}!${cell.address}`, norm);
      });
    });
  });
  return cells;
}

const expectedExcelJS = (w) => (w.type === 'blank' ? null : w.type === 'date' ? { date: w.value } : w.value);

async function run() {
  const results = { generatedBy: 'tools/measure.mjs', versions: { node: process.version, exceljs: '4.4.0', fflate: '0.8.3' }, fixtures: {} };
  for (const fx of FIXTURES) {
    const orig = rd(`fixtures/${fx.id}.xlsx`);
    const r = { label: fx.label };

    // ---- 方式B：無変更往復（書き込み0件） ----
    const b0 = patch(orig, [], zip);
    writeFileSync(path.join(root, `out/${fx.id}.B-nochange.xlsx`), b0.bytes);
    r.B_nochange = { ok: b0.ok, parts: partsSummary(orig, b0.bytes), zipBytesIdentical: Buffer.compare(Buffer.from(orig), Buffer.from(b0.bytes)) === 0 };

    // ---- 方式B：書き戻し（62セル） ----
    const b1 = patch(orig, answers, zip);
    writeFileSync(path.join(root, `out/${fx.id}.B-writeback.xlsx`), b1.bytes);
    // Excel実機での確認用に、書き戻し結果だけは results/ にも置く（コミット対象）
    copyFileSync(path.join(root, `out/${fx.id}.B-writeback.xlsx`), path.join(root, `results/${fx.id}.B-writeback.xlsx`));
    const v = verifyWriteBack(orig, b1.bytes, answers, zip);
    r.B_writeback = {
      ok: b1.ok,
      warnings: b1.warnings,
      actions: b1.report.cells.reduce((a, c) => ((a[c.action] = (a[c.action] ?? 0) + 1), a), {}),
      verify: { ok: v.ok, problems: v.problems, ...v.summary },
    };
    r.B_writeback.formulaResultsCleared = b1.report.formulaResultsCleared;
    // 数式セルに一切触れない版（古い計算結果が残る様子を見るため）
    const b2 = patch(orig, answers, zip, { formulaResults: 'keep' });
    writeFileSync(path.join(root, `out/${fx.id}.B-writeback-keepresults.xlsx`), b2.bytes);
    const v2 = verifyWriteBack(orig, b2.bytes, answers, zip);
    r.B_writeback_keepresults = { ok: b2.ok, verify: { ok: v2.ok, problems: v2.problems, ...v2.summary } };

    // 第三者（ExcelJS）で読み直し：62セルが期待どおり／それ以外は原票と同じ
    // ExcelJS が原票を読み込めない場合は、その事実を記録する
    try {
      const before = await readWithExcelJS(orig);
      const after = await readWithExcelJS(b1.bytes);
      const targets = new Map(answers.map((w) => [`${w.sheet}!${w.cell}`, w]));
      const mismatches = [];
      for (const key of new Set([...before.keys(), ...after.keys()])) {
        const want = targets.has(key) ? expectedExcelJS(targets.get(key)) : before.get(key);
        const got = after.get(key) ?? null;
        if (JSON.stringify(want ?? null) !== JSON.stringify(got)) mismatches.push({ key, want, got });
      }
      r.B_writeback.rereadExcelJS = { loaded: true, targetCells: targets.size, otherCells: [...after.keys()].filter((k) => !targets.has(k)).length, mismatches };
    } catch (e) {
      r.B_writeback.rereadExcelJS = { loaded: false, error: e.message };
    }

    // ---- 方式A：ExcelJS で無変更往復・書き戻し ----
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(orig);
      const a0 = new Uint8Array(await wb.xlsx.writeBuffer());
      writeFileSync(path.join(root, `out/${fx.id}.A-nochange.xlsx`), a0);
      r.A_nochange = { loaded: true, parts: partsSummary(orig, a0) };

      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(orig);
      for (const w of answers) {
        const cell = wb2.getWorksheet(w.sheet).getCell(w.cell);
        cell.value = w.type === 'blank' ? null : w.type === 'date' ? new Date(`${w.value}T00:00:00Z`) : w.value;
      }
      writeFileSync(path.join(root, `out/${fx.id}.A-writeback.xlsx`), new Uint8Array(await wb2.xlsx.writeBuffer()));
    } catch (e) {
      r.A_nochange = { loaded: false, error: e.message };
    }

    results.fixtures[fx.id] = r;
  }

  // ---- 方式B：書いてはいけない指定を拒否できるか（openpyxl生成の原票で確認） ----
  const orig = rd('fixtures/genpyo.xlsx');
  const cases = [
    ['数式セル', { sheet: '施設別実績', cell: 'C13', type: 'number', value: 1 }, 'E_FORMULA'],
    ['結合セルの左上以外', { sheet: '取組状況', cell: 'D16', type: 'number', value: 1 }, 'E_MERGE'],
    ['保護シートのロックされたセル（見出し）', { sheet: '基本情報', cell: 'B4', type: 'text', value: 'x' }, 'E_LOCKED'],
    ['存在しないシート', { sheet: '無いシート', cell: 'A1', type: 'text', value: 'x' }, 'E_SHEET'],
    ['不正なセル番地', { sheet: '取組状況', cell: 'C0', type: 'text', value: 'x' }, 'E_REF'],
    ['使用範囲の外', { sheet: '取組状況', cell: 'Z99', type: 'text', value: 'x' }, 'E_RANGE'],
    ['日付書式でないセルへの日付', { sheet: '取組状況', cell: 'C5', type: 'date', value: '2026-01-01' }, 'E_DATEFMT'],
    ['存在しない日付', { sheet: '取組状況', cell: 'C10', type: 'date', value: '2026-02-30' }, 'E_TYPE'],
    ['数値でない値', { sheet: '取組状況', cell: 'C5', type: 'number', value: Number.NaN }, 'E_TYPE'],
    ['XMLに書けない制御文字', { sheet: '取組状況', cell: 'D5', type: 'text', value: 'a\u0001b' }, 'E_TYPE'],
  ];
  results.refusals = cases.map(([name, w, want]) => {
    // 正しい書き込み1件と一緒に渡し、1件でも不正なら全体が出力されないことも見る
    const res = patch(orig, [answers[0], w], zip);
    return { name, expected: want, got: res.errors.map((e) => e.code), refused: !res.ok && res.bytes === undefined && res.errors.some((e) => e.code === want) };
  });
  const notXlsx = patch(new TextEncoder().encode('これはxlsxではない'), [], zip);
  results.refusals.push({ name: 'ZIPでないファイル（旧.xls等）', expected: 'E_NOT_XLSX', got: notXlsx.errors.map((e) => e.code), refused: !notXlsx.ok });
  const withMacro = zip.unzip(orig);
  withMacro['xl/vbaProject.bin'] = new Uint8Array([1, 2, 3]);
  const macro = patch(zip.zip(withMacro), [answers[0]], zip);
  results.refusals.push({ name: 'マクロ付きブック', expected: 'E_MACRO', got: macro.errors.map((e) => e.code), refused: !macro.ok });

  writeFileSync(path.join(root, 'results/measure.json'), `${JSON.stringify(results, null, 1)}\n`);
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = await run();
  for (const [id, r] of Object.entries(res.fixtures)) {
    console.log(`\n== ${id}（${r.label}）`);
    console.log(` B 無変更: 同一 ${r.B_nochange.parts.same} / 変更 ${r.B_nochange.parts.changed.length} / 追加 ${r.B_nochange.parts.added.length} / 削除 ${r.B_nochange.parts.removed.length}`);
    console.log(` B 書戻し: 照合 ${r.B_writeback.verify.ok ? 'OK' : 'NG'}（対象 ${r.B_writeback.verify.checkedCells}、対象外で同一 ${r.B_writeback.verify.untouchedCells}、数式の計算結果だけ消去 ${r.B_writeback.verify.formulaResultsCleared}）変更部品 ${r.B_writeback.verify.parts.changed.join(', ')}`);
    const rr = r.B_writeback.rereadExcelJS;
    console.log(rr.loaded ? ` B 書戻し: ExcelJS読み直しの不一致 ${rr.mismatches.length}（対象 ${rr.targetCells}、対象外 ${rr.otherCells}）` : ` B 書戻し: ExcelJSで読み直せず（${rr.error}）`);
    if (r.A_nochange.loaded) {
      const p = r.A_nochange.parts;
      console.log(` A 無変更: 同一 ${p.same} / 変更 ${p.changed.length} / 追加 ${p.added.length} / 削除 ${p.removed.length}`);
      console.log(`   削除: ${p.removed.join(', ') || 'なし'}`);
      console.log(`   追加: ${p.added.join(', ') || 'なし'}`);
    } else {
      console.log(` A 無変更: ExcelJSが原票を読み込めず失敗（${r.A_nochange.error}）`);
    }
  }
  console.log(`\n拒否の確認: ${res.refusals.filter((x) => x.refused).length} / ${res.refusals.length}`);
  for (const x of res.refusals.filter((y) => !y.refused)) console.log('  NG', x);
}
