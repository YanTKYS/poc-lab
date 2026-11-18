import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as M from '../app/model.js';
import { applySampleAssignment, applySampleAnswers, applySampleSubmissions, rangeKeys } from '../app/sample.js';
import { readLayout, describeCandidates, describeCell } from '../src/xlsx-layout.mjs';
import { patch } from '../src/xlsx-patch.mjs';
import { verifyWriteBack, readAllCells } from '../src/xlsx-verify.mjs';
import { fflateZip as zip } from '../src/zip-fflate.mjs';

const rd = (p) => new Uint8Array(readFileSync(new URL(`../${p}`, import.meta.url)));
const answers = JSON.parse(readFileSync(new URL('../fixtures/answers.json', import.meta.url), 'utf8'));
const FIXTURES = readdirSync(new URL('../fixtures/', import.meta.url)).filter((f) => /^genpyo.*\.xlsx$/.test(f)).sort().map((f) => f.slice(0, -5));

function fresh(id = 'genpyo') {
  const bytes = rd(`fixtures/${id}.xlsx`);
  const layout = readLayout(zip.unzip(bytes));
  const state = M.registerSource(M.newState(), { title: '架空の照会', sourceName: `${id}.xlsx`, sourceB64: '', descriptions: describeCandidates(layout) });
  return { bytes, layout, state };
}

for (const id of FIXTURES) {
  test(`${id}: 入力セル候補は62個で、数式セルと結合セルの左上以外を含まない`, () => {
    const { layout, state } = fresh(id);
    assert.equal(Object.keys(state.items).length, 62);
    for (const s of layout.sheets) for (const ref of s.candidates.keys()) {
      assert.equal(s.cells.get(ref)?.isFormula ?? false, false, `${s.name}!${ref}`);
      assert.equal(s.covered.has(ref), false, `${s.name}!${ref}`);
    }
    assert.equal(layout.byName['記入要領'].candidates.size, 0);
  });

  test(`${id}: 見出し・型・選択肢の候補を原票から読み取る`, () => {
    const { state } = fresh(id);
    const it = (k) => state.items[k];
    assert.equal(it('取組状況!C5').label, '問1 オンライン申請に対応している手続の数 ／ 回答');
    assert.equal(it('施設別実績!D7').label, '西公民館 ／ 開館日数（日）');
    assert.equal(it('基本情報!D4').label, '団体コード（6桁）');
    assert.deepEqual([it('基本情報!D4').type, it('基本情報!D9').type, it('取組状況!C5').type, it('取組状況!C10').type, it('取組状況!C12').type, it('取組状況!D5').type], ['text', 'date', 'number', 'date', 'percent', 'text']);
    assert.deepEqual(it('取組状況!C6').options, ['導入済み', '導入予定', '未導入']);
    assert.deepEqual(it('取組状況!C11').options, ['実施済み', '実施予定', '未実施'], '別シートのセル範囲を参照するリスト');
    assert.deepEqual(it('取組状況!C5').rule, { integer: true, operator: 'greaterThanOrEqual', bound: 0 });
  });

  test(`${id}: 割当て→回答→提出→差戻し→再提出→集約→出力まで通り、原票の様式を保つ`, () => {
    const { bytes, state } = fresh(id);

    // 割当て：62項目を9回の一括割当て処理で（入力セル数と処理の回数は別。ログには両方を区別して書く）
    assert.deepEqual(applySampleAssignment(state), { cells: 56, ranges: 9 });
    assert.equal(state.counters.assignOps, 9);
    const count = (d) => M.itemsOf(state, d).length;
    assert.deepEqual(['dx', 'shimin', 'zeimu', 'fukushi', 'kosodate', 'shisetsu'].map(count), [6, 10, 6, 15, 9, 21]);
    assert.equal(M.itemList(state).filter(M.isMulti).length, 2);

    // 回答部署：入力すると作成中、未入力があると提出できない
    assert.equal(M.deptStatus(state, 'shimin'), 'none');
    M.setAnswer(state, '取組状況!C5', 'shimin', '１２');
    assert.equal(M.deptStatus(state, 'shimin'), 'draft');
    assert.equal(M.submit(state, 'shimin').ok, false);
    applySampleAnswers(state, answers, ['shimin']);
    assert.equal(M.progress(state, 'shimin').missing.length, 0);
    assert.equal(M.submit(state, 'shimin', 1000).ok, true);
    assert.equal(M.deptStatus(state, 'shimin'), 'submitted');

    // とりまとめ：1項目を差戻し → 課の状態が差戻しになり、対応するまで再提出できない
    const rec = M.returnItem(state, '取組状況!C6', 'shimin', '開始年度を補足に記入してください', 2000);
    assert.equal(M.deptStatus(state, 'shimin'), 'returned');
    assert.equal(M.submit(state, 'shimin').ok, false);
    M.setAnswer(state, '取組状況!C6', 'shimin', '導入予定');
    assert.equal(M.submit(state, 'shimin', 3000).ok, true);
    assert.equal(M.deptStatus(state, 'shimin'), 'submitted');
    assert.deepEqual([rec.resolved, rec.before, rec.after, state.returns.length], [true, '導入済み', '導入予定', 1], '解消しても記録は残る');

    // 直さずに返答するだけでも解消できる
    M.returnItem(state, '取組状況!C5', 'shimin', '多すぎませんか', 4000);
    M.replyReturn(state, state.returns[1].id, '確認済み。12件で正しい');
    assert.equal(M.submit(state, 'shimin', 5000).ok, true);
    assert.equal(state.returns[1].after, state.returns[1].before);

    // 残りの課も提出。複数課項目は確定するまで書かれない
    applySampleSubmissions(state, answers, ['dx', 'zeimu', 'fukushi', 'kosodate', 'shisetsu']);
    let plan = M.outputPlan(state);
    assert.deepEqual(plan.pending.map((p) => p.item.key), ['取組状況!C16', '取組状況!C17']);
    const s16 = M.mergeSuggestion(state, state.items['取組状況!C16']);
    assert.deepEqual([s16.by, s16.raw], ['sum', '5']);
    M.setFinal(state, '取組状況!C16', s16.raw, s16.by);
    const s17 = M.mergeSuggestion(state, state.items['取組状況!C17']);
    assert.match(s17.raw, /^【市民課】窓口の混雑。\n【税務課】/);
    M.setFinal(state, '取組状況!C17', s17.raw, s17.by);

    // 出力：計画どおりに書き戻し、自動照合を通る
    plan = M.outputPlan(state);
    assert.equal(plan.pending.length, 0);
    assert.equal(plan.skippedOptional, 3, '任意の補足欄3つは空欄のまま');
    assert.equal(plan.writes.length, 59);
    const r = patch(bytes, plan.writes, zip);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(verifyWriteBack(bytes, r.bytes, plan.writes, zip).problems, []);
    const cells = readAllCells(zip.unzip(r.bytes));
    assert.equal(cells['取組状況'].get('C12').value, 0.125, '％は 12.5 → 0.125');
    assert.equal(cells['取組状況'].get('C6').value, '導入予定', '差戻し後の値');
    assert.equal(cells['取組状況'].get('C16').value, 5);
    assert.equal(cells['基本情報'].get('D4').value, '012345', '先頭ゼロ');
    assert.equal(cells['施設別実績'].get('E11')?.kind ?? 'empty', 'empty', '数値項目の該当なしは空欄');
    assert.equal(cells['施設別実績'].get('C13').formula, 'SUM(C5:C12)');
  });
}

test('未提出の課の回答は書き出さない。未割当ての項目は自課が回答する', () => {
  const { state } = fresh();
  assert.equal(M.itemsOf(state, 'dx').length, 62, '割当て前はすべて自課');
  applySampleAssignment(state);
  applySampleAnswers(state, answers);
  const plan = M.outputPlan(state);
  assert.equal(plan.writes.length, 0);
  assert.ok(plan.pending.every((p) => /未提出|確定値/.test(p.why)));
});

test('入力の解釈：全角数字・カンマ・％、入力規則、日付、選択肢、該当なし', () => {
  const { state } = fresh();
  const p = (key, raw) => M.parseAnswer(state.items[key], { raw, na: false });
  assert.deepEqual(p('施設別実績!C5', '１２，３４５'), { state: 'ok', value: 12345 });
  assert.equal(p('施設別実績!C5', '12,O00').state, 'error');
  assert.equal(p('取組状況!C5', '1.5').state, 'error', '整数の入力規則');
  assert.equal(p('取組状況!C5', '-1').state, 'error', '0以上の入力規則');
  assert.deepEqual(p('取組状況!C12', '12.5%'), { state: 'ok', value: 12.5 });
  assert.equal(p('取組状況!C10', '2026-02-30').state, 'error');
  assert.equal(p('取組状況!C6', 'その他').state, 'error');
  assert.equal(p('取組状況!D5', '  ').state, 'empty');
  assert.equal(M.parseAnswer(state.items['取組状況!D5'], { raw: '', na: true }).state, 'na');
});

test('該当なしの書き方：文章は文言または空欄、数値は空欄', () => {
  const { state } = fresh();
  applySampleAssignment(state); // 自課の担当は基本情報の6項目だけになる
  for (const k of ['基本情報!D5', '基本情報!D9']) M.setNA(state, k, 'dx', true);
  for (const it of M.itemsOf(state, 'dx')) if (M.parsed(state, it, 'dx').state === 'empty') M.setAnswer(state, it.key, 'dx', it.type === 'date' ? '2026-11-27' : '1');
  assert.equal(M.submit(state, 'dx').ok, true);
  const w = (key) => M.outputPlan(state).writes.find((x) => M.keyOf(x.sheet, x.cell) === key);
  assert.deepEqual(w('基本情報!D5'), { sheet: '基本情報', cell: 'D5', type: 'text', value: '該当なし' });
  assert.deepEqual(w('基本情報!D9'), { sheet: '基本情報', cell: 'D9', type: 'blank' });
  state.inquiry.naAsText = false;
  assert.deepEqual(w('基本情報!D5'), { sheet: '基本情報', cell: 'D5', type: 'blank' });
});

test('連絡文は共通リンクを含み、催促文は未提出の課だけを挙げる', () => {
  const { state } = fresh();
  applySampleAssignment(state);
  state.inquiry.deadline = '2026-11-27';
  applySampleSubmissions(state, answers, ['shimin', 'shisetsu']);
  const url = 'https://example.invalid/poc-lab/inquiry-workflow/#answer';
  assert.match(M.requestText(state, url), /庁内締切：2026年11月27日[\s\S]*#answer[\s\S]*・市民課：10項目/);
  // 依頼・催促・差戻しのどの文面も、冒頭がデモ専用・送付禁止の見出しで、別端末では共有されないと読み取れる
  const rem = M.reminderText(state, url);
  assert.deepEqual(rem.depts.map((d) => d.id), ['zeimu', 'fukushi', 'kosodate']);
  M.returnItem(state, '取組状況!C6', 'shimin', '確認してください');
  for (const text of [M.requestText(state, url), rem.text, M.returnText(state, 'shimin', url)]) {
    assert.equal(text.split('\n')[0], '【デモ専用・実際の依頼として送付禁止】');
    assert.match(text, /別の端末でリンクを開いても回答内容は共有されません/);
  }
  assert.match(M.returnText(state, 'shimin', url), /問2 コンビニ交付の導入状況 ／ 回答：確認してください/);
  assert.deepEqual(M.reminderText(state, url).depts.map((d) => d.id), ['zeimu', 'fukushi', 'kosodate'], '差戻し中の課は催促しない');
});

test('候補外のセルも、見出しを付けて項目に追加できる。範囲からキーを取り出せる', () => {
  const { layout, state } = fresh();
  M.removeItems(state, ['取組状況!D5']);
  assert.equal(rangeKeys(state, '取組状況', 'C5:D6').length, 3);
  const s = layout.byName['取組状況'];
  M.addItem(state, { ...describeCell(layout, '取組状況', 'D5', (r) => !!state.items[M.keyOf(s.name, r)]), reasons: ['manual'] });
  assert.equal(state.items['取組状況!D5'].label, '問1 オンライン申請に対応している手続の数 ／ 補足・自由記述');
});

test('複数課項目の確定値は、確定後に回答が変わる・提出が取り消されると使わない（再確定が必要）', () => {
  const { state } = fresh();
  applySampleAssignment(state);
  const key = '取組状況!C16';
  const item = state.items[key];
  // 未提出の課があるうちは確定できない
  applySampleSubmissions(state, answers, ['shimin']);
  assert.equal(M.setFinal(state, key, '5').ok, false);
  applySampleSubmissions(state, answers, ['dx', 'zeimu', 'fukushi', 'kosodate', 'shisetsu']);
  assert.equal(M.setFinal(state, key, '5', 'sum').ok, true);
  assert.equal(M.finalStatus(state, item), 'ok');
  assert.ok(M.outputPlan(state).writes.some((w) => w.cell === 'C16' && w.value === 5));

  // 市民課が提出を取り消す → 未提出の課があるので書き出さない
  M.withdraw(state, 'shimin');
  assert.equal(M.finalStatus(state, item), 'waiting');
  // 回答を 3→4 に直して再提出 → 確定値5は古いので書き出さない
  M.setAnswer(state, key, 'shimin', '4');
  assert.equal(M.submit(state, 'shimin').ok, true);
  assert.equal(M.finalStatus(state, item), 'stale');
  let plan = M.outputPlan(state);
  assert.equal(plan.writes.some((w) => w.cell === 'C16'), false);
  assert.match(plan.pending.find((p) => p.item.key === key).why, /再確認・再確定/);

  // 差戻し中も同じ（確定値は使わない）
  M.setFinal(state, key, '6');
  assert.equal(M.finalStatus(state, item), 'ok');
  M.returnItem(state, key, 'zeimu', '確認してください');
  assert.equal(M.finalStatus(state, item), 'waiting');
  M.replyReturn(state, state.returns.at(-1).id, '2で正しい');
  M.submit(state, 'zeimu');
  assert.equal(M.finalStatus(state, item), 'ok', '回答が同じまま再提出されたら、確定値はそのまま使える');
  plan = M.outputPlan(state);
  assert.ok(plan.writes.some((w) => w.cell === 'C16' && w.value === 6));
});
