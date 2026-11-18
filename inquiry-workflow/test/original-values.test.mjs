// 原票に元からある内容（「　年　月」等のひな形文字・記入例）の扱い（Issue #23）。
// - 割り当てても、原票の内容は表示から消えず、原票も書き換わらない
// - 元の内容を、回答として暗黙に入力済みにしない
// - 回答がなければ、確認用Excelでも原票のままにする。回答したときだけ、その回答を書き込む
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../app/model.js';
import { applySampleAssignment, applySampleAnswers, applySampleSubmissions } from '../app/sample.js';
import { readLayout, describeCandidates } from '../src/xlsx-layout.mjs';
import { patch } from '../src/xlsx-patch.mjs';
import { verifyWriteBack, readAllCells } from '../src/xlsx-verify.mjs';
import { fflateZip as zip } from '../src/zip-fflate.mjs';

const rd = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));
const answers = JSON.parse(readFileSync(new URL('../fixtures/answers.json', import.meta.url), 'utf8'));
const W = (sheet, cell, type, value) => ({ sheet, cell, type, value });

// 架空の原票の入力セルに、ひな形文字・記入例を入れた原票を作る（方式Bで書き込んで作る）
const TEMPLATE = [
  W('取組状況', 'C10', 'text', '　年　月'), // 問6（日付の入力欄）のひな形文字。税務課の担当
  W('取組状況', 'D7', 'text', '（補足を記入）'), // 問3の補足（任意）。市民課の担当
  W('施設別実績', 'C5', 'number', 99), // 記入例の数値。施設管理課の担当
  W('取組状況', 'C12', 'number', 0.5), // ％の表示形式のセル
  W('基本情報', 'D9', 'date', '2025-04-01'), // 日付の表示形式のセル
];

for (const id of ['genpyo', 'genpyo-lo']) {
  const base = rd(`fixtures/${id}.xlsx`);
  const book = patch(base, TEMPLATE, zip).bytes;
  const register = (bytes) => {
    const L = readLayout(zip.unzip(bytes));
    return { L, state: M.registerSource(M.newState(), { title: '架空', sourceName: 'x.xlsx', sourceB64: '', descriptions: describeCandidates(L) }) };
  };

  test(`${id}: 原票に元からある内容を、表示用の文字列として読み取る（文字・数値・日付・％。空欄と数式は空）`, () => {
    const { L } = register(book);
    const d = (sheet, ref) => L.byName[sheet].cells.get(ref)?.display;
    assert.equal(d('取組状況', 'C10'), '　年　月');
    assert.equal(d('取組状況', 'D7'), '（補足を記入）');
    assert.equal(d('施設別実績', 'C5'), '99');
    assert.equal(d('取組状況', 'C12'), '50%');
    assert.equal(d('基本情報', 'D9'), '2025-04-01');
    // 何も入っていないセルと、数式セルは空
    assert.ok(!d('取組状況', 'C5'));
    assert.equal(d('施設別実績', 'C13'), '');
  });

  test(`${id}: 元の内容があっても、入力セル候補・見出し・型・選択肢は変わらない（番地と見出しの対応を維持）`, () => {
    // 候補の根拠（reasons）だけは変わり得る：「色付きの空欄」は空欄が条件なので、元の内容があるセルには付かない
    const strip = (cands) => cands.map(({ reasons, ...rest }) => rest);
    assert.deepEqual(strip(describeCandidates(register(book).L)), strip(describeCandidates(register(base).L)));
    assert.equal(register(book).state.items['取組状況!C10'].label, '問6 申告の電子化を開始した日 ／ 回答');
  });

  test(`${id}: 割り当てても、原票の内容は回答として入力済みにならない（未回答のまま。必須なら提出できない）`, () => {
    const { state } = register(book);
    applySampleAssignment(state);
    const key = '取組状況!C10';
    assert.equal(M.answerOf(state, key, 'zeimu'), null);
    assert.equal(M.parsed(state, state.items[key], 'zeimu').state, 'empty');
    assert.ok(M.progress(state, 'zeimu').missing.some((it) => it.key === key));
    const r = M.submit(state, 'zeimu');
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => /未入力/.test(b)));
  });

  test(`${id}: 回答がなければ原票のまま残り（必須は提出不可・任意は空のまま提出可）、回答したときだけ、その回答を書き込む`, () => {
    const { state } = register(book);
    applySampleAssignment(state);
    // 全課に回答例を入れるが、C10（必須）の回答を外し、D7（任意）は回答例がない
    applySampleAnswers(state, answers);
    delete state.answers['取組状況!C10'];
    assert.equal(M.parsed(state, state.items['取組状況!D7'], 'shimin').state, 'empty');
    for (const d of ['dx', 'shimin', 'fukushi', 'kosodate', 'shisetsu']) assert.equal(M.submit(state, d).ok, true, d); // 任意の空欄だけの課も提出できる
    assert.equal(M.submit(state, 'zeimu').ok, false, 'C10 が未回答の税務課は提出できない');
    for (const k of ['取組状況!C16', '取組状況!C17']) {
      const sug = M.mergeSuggestion(state, state.items[k]);
      if (sug) M.setFinal(state, k, sug.raw, sug.by); // 税務課が未提出なので確定できない（出力では書かない）
    }

    // 1回目の出力：未回答の C10（税務課が未提出）と D7（任意・未回答）は書かない → 原票のまま
    let plan = M.outputPlan(state);
    assert.ok(!plan.writes.some((w) => w.sheet === '取組状況' && (w.cell === 'C10' || w.cell === 'D7')));
    let out = patch(book, plan.writes, zip);
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    assert.deepEqual(verifyWriteBack(book, out.bytes, plan.writes, zip).problems, []);
    let cells = readAllCells(zip.unzip(out.bytes))['取組状況'];
    assert.deepEqual([cells.get('C10').kind, cells.get('C10').value], ['string', '　年　月']);
    assert.deepEqual([cells.get('D7').kind, cells.get('D7').value], ['string', '（補足を記入）']);
    // 回答済みのセルは、回答が書かれ、原票の記入例は置き換わる
    assert.equal(readAllCells(zip.unzip(out.bytes))['施設別実績'].get('C5').value, 12345);

    // C10 に回答して再び提出 → 2回目の出力：C10 だけ新しい回答（日付）になり、D7 は原票のまま
    M.setAnswer(state, '取組状況!C10', 'zeimu', '2025-04-01');
    assert.equal(M.submit(state, 'zeimu').ok, true);
    plan = M.outputPlan(state);
    const w = plan.writes.find((x) => x.sheet === '取組状況' && x.cell === 'C10');
    assert.deepEqual(w, { sheet: '取組状況', cell: 'C10', type: 'date', value: '2025-04-01' });
    assert.ok(!plan.writes.some((x) => x.sheet === '取組状況' && x.cell === 'D7'));
    out = patch(book, plan.writes, zip);
    assert.deepEqual(verifyWriteBack(book, out.bytes, plan.writes, zip).problems, []);
    cells = readAllCells(zip.unzip(out.bytes))['取組状況'];
    assert.deepEqual([cells.get('C10').kind, typeof cells.get('C10').value], ['number', 'number'], '原票の文字ではなく、新しい回答（日付）');
    assert.equal(cells.get('D7').value, '（補足を記入）');
  });
}
