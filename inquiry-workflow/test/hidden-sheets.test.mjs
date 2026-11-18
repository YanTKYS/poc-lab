// 非表示シート（hidden・veryHidden）：回答・割当ての対象にせず、出力する原票の複製には元のまま残す（Issue #22）。
// 検証用の .xlsx は、架空の原票の workbook.xml の <sheet state> だけを一時的に書き換えて作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strToU8, strFromU8 } from 'fflate';
import * as M from '../app/model.js';
import { applySampleAssignment, applySampleAnswers, applySampleSubmissions } from '../app/sample.js';
import { readWorkbook } from '../src/ooxml.mjs';
import { readLayout, describeCandidates } from '../src/xlsx-layout.mjs';
import { inspect, patch } from '../src/xlsx-patch.mjs';
import { verifyWriteBack } from '../src/xlsx-verify.mjs';
import { fflateZip as zip } from '../src/zip-fflate.mjs';

const rd = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));
const answers = JSON.parse(readFileSync(new URL('../fixtures/answers.json', import.meta.url), 'utf8'));

/** 指定したシートの表示状態を書き換えたブックを返す。state が null なら属性を省略する（＝visible）。 */
function withStates(bytes, states) {
  const files = zip.unzip(bytes);
  let wb = strFromU8(files['xl/workbook.xml']);
  for (const [name, state] of Object.entries(states)) {
    const re = new RegExp(`<sheet\\b[^>]*\\bname="${name}"[^>]*>`);
    const tag = re.exec(wb)[0];
    const bare = tag.replace(/\sstate="[^"]*"/, '');
    wb = wb.replace(tag, state == null ? bare : bare.replace(/(\sr:id=)/, ` state="${state}"$1`));
  }
  files['xl/workbook.xml'] = strToU8(wb);
  return zip.zip(files);
}
const states = (bytes) => Object.fromEntries(readWorkbook(zip.unzip(bytes)).sheets.map((s) => [s.name, s.state]));

for (const id of ['genpyo', 'genpyo-lo']) {
  const base = rd(`fixtures/${id}.xlsx`);

  test(`${id}: シートの表示状態（visible・属性の省略・hidden・veryHidden）を読み取る`, () => {
    const wbk = withStates(base, { 記入要領: 'veryHidden', 基本情報: 'hidden', 取組状況: null });
    assert.deepEqual(states(wbk), { 記入要領: 'veryHidden', 基本情報: 'hidden', 取組状況: 'visible', 施設別実績: 'visible' });
    const sheets = readWorkbook(zip.unzip(wbk)).sheets;
    assert.deepEqual(sheets.map((s) => s.hidden), [true, true, false, false]);
    // inspect() にも引き継がれる
    assert.deepEqual(inspect(wbk, zip).sheets.map((s) => [s.name, s.hidden]), [['記入要領', true], ['基本情報', true], ['取組状況', false], ['施設別実績', false]]);
  });

  test(`${id}: 非表示シートは入力セル候補・割当て対象にならない。表示シートの候補は従来どおり`, () => {
    // 施設別実績（入力セル32）を hidden、記入要領を veryHidden にする
    const wbk = withStates(base, { 施設別実績: 'hidden', 記入要領: 'veryHidden' });
    const L = readLayout(zip.unzip(wbk));
    assert.deepEqual(L.sheets.map((s) => s.name), ['基本情報', '取組状況']);
    assert.deepEqual(L.hiddenSheets, [{ name: '記入要領', state: 'veryHidden' }, { name: '施設別実績', state: 'hidden' }]);
    const cands = describeCandidates(L);
    assert.equal(cands.length, 30);
    assert.ok(cands.every((c) => c.sheet !== '施設別実績'));
    // 表示シートの候補は、非表示にしていない原票と同じ
    const normal = describeCandidates(readLayout(zip.unzip(base))).filter((c) => c.sheet !== '施設別実績');
    assert.deepEqual(cands, normal);
  });

  test(`${id}: 非表示シートにある参照値（入力規則の選択肢）は、引き続き読み取れる`, () => {
    // 問7（取組状況 C11）の選択肢は、記入要領!H2:H4（veryHidden にしたシート）を参照している
    const wbk = withStates(base, { 記入要領: 'veryHidden' });
    const c11 = describeCandidates(readLayout(zip.unzip(wbk))).find((c) => c.sheet === '取組状況' && c.cell === 'C11');
    assert.deepEqual(c11.options, ['実施済み', '実施予定', '未実施']);
    assert.equal(c11.type, 'choice');
  });

  test(`${id}: 非表示シートを含む原票でも、割当て→回答→出力でき、非表示シートは1バイトも変わらない`, () => {
    const wbk = withStates(base, { 基本情報: 'hidden', 記入要領: 'veryHidden' });
    const L = readLayout(zip.unzip(wbk));
    const state = M.registerSource(M.newState(), { title: '架空', sourceName: 'x.xlsx', sourceB64: '', descriptions: describeCandidates(L) });
    assert.equal(Object.keys(state.items).length, 56); // 62 − 基本情報の6
    applySampleAssignment(state);
    applySampleSubmissions(state, answers, ['shimin', 'zeimu', 'fukushi', 'kosodate', 'shisetsu']);
    const s16 = M.mergeSuggestion(state, state.items['取組状況!C16']);
    M.setFinal(state, '取組状況!C16', s16.raw, s16.by);
    const s17 = M.mergeSuggestion(state, state.items['取組状況!C17']);
    M.setFinal(state, '取組状況!C17', s17.raw, s17.by);
    // 自課（デジタル推進課）の担当は、非表示の基本情報だけだったので、回答項目は無い
    assert.equal(M.itemsOf(state, 'dx').length, 0);
    const plan = M.outputPlan(state);
    assert.equal(plan.pending.length, 0);
    assert.ok(plan.writes.every((w) => w.sheet !== '基本情報'));

    const r = patch(wbk, plan.writes, zip);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(verifyWriteBack(wbk, r.bytes, plan.writes, zip).problems, []);

    const before = zip.unzip(wbk);
    const after = zip.unzip(r.bytes);
    const path = (name) => readWorkbook(before).sheets.find((s) => s.name === name).path;
    // 非表示シートの部品は、内容・数式・書式・保存済みの計算結果とも元のまま
    for (const name of ['基本情報', '記入要領']) assert.deepEqual(after[path(name)], before[path(name)], `${name} のシートが変わった`);
    // 表示状態も元のまま。表示シートは書き換わっている
    assert.deepEqual(states(r.bytes), { 記入要領: 'veryHidden', 基本情報: 'hidden', 取組状況: 'visible', 施設別実績: 'visible' });
    assert.notDeepEqual(after[path('取組状況')], before[path('取組状況')]);
  });

  test(`${id}: 表示シートの変更で再計算が要る数式が非表示シートにあっても、非表示シートは元のまま（再計算はExcelで開いたときに行われる）`, () => {
    // 基本情報!D12 は 取組状況!C19（表示シートの入力に依存する数式）を参照する。基本情報を hidden にして取組状況に書く
    const wbk = withStates(base, { 基本情報: 'hidden' });
    const r = patch(wbk, [{ sheet: '取組状況', cell: 'C5', type: 'number', value: 7 }], zip);
    assert.equal(r.ok, true);
    const p = readWorkbook(zip.unzip(wbk)).sheets.find((s) => s.name === '基本情報').path;
    assert.deepEqual(zip.unzip(r.bytes)[p], zip.unzip(wbk)[p]);
    // 比較：非表示にしなければ、基本情報の数式セルの保存済み計算結果も消される（原票が計算結果を持つ場合＝LibreOffice保存の原票）
    if (id === 'genpyo-lo') {
      const w = [{ sheet: '取組状況', cell: 'C5', type: 'number', value: 7 }];
      assert.ok(patch(base, w, zip).report.formulaResultsCleared > r.report.formulaResultsCleared);
    }
  });

  test(`${id}: 非表示シートへの書き込みは拒否し、何も出力しない`, () => {
    const wbk = withStates(base, { 施設別実績: 'hidden' });
    const r = patch(wbk, [{ sheet: '取組状況', cell: 'C5', type: 'number', value: 1 }, { sheet: '施設別実績', cell: 'C5', type: 'number', value: 1 }], zip);
    assert.equal(r.ok, false);
    assert.equal(r.bytes, undefined);
    assert.deepEqual(r.errors.map((e) => e.code), ['E_HIDDEN']);
    const v = patch(withStates(base, { 施設別実績: 'veryHidden' }), [{ sheet: '施設別実績', cell: 'C5', type: 'number', value: 1 }], zip);
    assert.equal(v.errors[0].code, 'E_HIDDEN');
  });

  test(`${id}: 自動照合は、非表示シートの変更と、表示状態の変更（非表示→表示）を検出する`, () => {
    const wbk = withStates(base, { 基本情報: 'hidden' });
    const w = [{ sheet: '取組状況', cell: 'C5', type: 'number', value: 7 }];
    const out = patch(wbk, w, zip).bytes;
    assert.deepEqual(verifyWriteBack(wbk, out, w, zip).problems, []);
    // 非表示シートの中身が変わった
    const files = zip.unzip(out);
    const p = readWorkbook(files).sheets.find((s) => s.name === '基本情報').path;
    files[p] = strToU8(strFromU8(files[p]).replace('</worksheet>', ' </worksheet>')); // 意味は変わらない1バイトの差でも検出する
    const tampered = verifyWriteBack(wbk, zip.zip(files), w, zip);
    assert.equal(tampered.ok, false);
    assert.ok(tampered.problems.some((x) => /基本情報.*非表示シート.*元のままではありません/.test(x)), tampered.problems.join(' / '));
    // 非表示 → 表示に変わった
    const shown = withStates(out, { 基本情報: 'visible' });
    const v = verifyWriteBack(wbk, shown, w, zip);
    assert.equal(v.ok, false);
    assert.ok(v.problems.some((x) => /workbook\.xml/.test(x)), v.problems.join(' / '));
  });
}

test('すべてのシートが非表示なら、表示シートは0（アプリは登録を断る）', () => {
  const wbk = withStates(rd('fixtures/genpyo.xlsx'), { 記入要領: 'hidden', 基本情報: 'hidden', 取組状況: 'veryHidden', 施設別実績: 'hidden' });
  const L = readLayout(zip.unzip(wbk));
  assert.equal(L.sheets.length, 0);
  assert.equal(L.hiddenSheets.length, 4);
});

test('非表示シートの対応前に登録した状態：非表示シートにある項目と、結び付いた記録を対象から外す', () => {
  const orig = rd('fixtures/genpyo.xlsx');
  // 以前の版は、非表示にあたるシートも含めて 62項目を登録していた
  const old = M.registerSource(M.newState(), { title: '架空', sourceName: 'x.xlsx', sourceB64: '', descriptions: describeCandidates(readLayout(zip.unzip(orig))) });
  applySampleAssignment(old);
  applySampleAnswers(old, answers, ['shisetsu']);
  M.submit(old, 'shisetsu');
  M.returnItem(old, '施設別実績!C5', 'shisetsu', '確認してください');
  assert.equal(Object.keys(old.items).length, 62);
  // いまの版で、施設別実績が非表示の原票として読み込む
  const L = readLayout(zip.unzip(withStates(orig, { 施設別実績: 'hidden' })));
  assert.equal(M.removeItemsOutsideSheets(old, L.sheets.map((s) => s.name)), 32);
  assert.equal(Object.keys(old.items).length, 30);
  assert.equal(M.itemsOf(old, 'shisetsu').length, 1, '残るのは複数課項目（問13）だけ');
  assert.ok(!Object.keys(old.answers).some((k) => k.startsWith('施設別実績!')));
  assert.deepEqual(old.returns, []);
  assert.equal(M.removeItemsOutsideSheets(old, L.sheets.map((s) => s.name)), 0, '2回目は何も外さない');
});
