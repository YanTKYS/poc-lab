// デモ用のショートカット（架空の原票 genpyo.xlsx 専用）。
// 設計資料 01 §1 の割当て例（9範囲）と、架空の回答例を流し込む。
import { COORDINATOR, assign, setOptional, setAnswer, setNA, submit, itemsOf, keyOf, DEPTS } from './model.js';

export const SAMPLE_ASSIGN = [
  { sheet: '取組状況', range: 'C5:D8', depts: ['shimin'] },
  { sheet: '取組状況', range: 'C9:D10', depts: ['zeimu'] },
  { sheet: '取組状況', range: 'C11:D13', depts: ['fukushi'] },
  { sheet: '取組状況', range: 'C14:D15', depts: ['kosodate'] },
  { sheet: '取組状況', range: 'C16', depts: ['shimin', 'zeimu'] },
  { sheet: '取組状況', range: 'C17', depts: ['shimin', 'zeimu', 'fukushi', 'kosodate', 'shisetsu'] },
  { sheet: '施設別実績', range: 'C5:F9', depts: ['shisetsu'] },
  { sheet: '施設別実績', range: 'C10:F11', depts: ['fukushi'] },
  { sheet: '施設別実績', range: 'C12:F12', depts: ['kosodate'] },
];
// 補足欄は任意（空欄のまま提出できる）
export const SAMPLE_OPTIONAL = [{ sheet: '取組状況', range: 'D5:D15' }];

// 複数課項目は、課ごとに別の回答を入れる
const MULTI_ANSWERS = {
  '取組状況!C16': { shimin: '3', zeimu: '2' },
  '取組状況!C17': {
    shimin: '窓口の混雑。',
    zeimu: '証明書のコンビニ交付率が低い。',
    fukushi: '端末が不足。',
    kosodate: '申請書類の種類が多い。',
    shisetsu: '予約システムが施設ごとに異なる。',
  },
};

const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colStr = (n) => (n > 26 ? colStr(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26));

/** 'C5:D8' を、範囲内の項目のキー一覧にする。 */
export function rangeKeys(state, sheet, range) {
  const [a, b = a] = range.split(':');
  const m1 = /^([A-Z]+)(\d+)$/.exec(a);
  const m2 = /^([A-Z]+)(\d+)$/.exec(b);
  const keys = [];
  for (let r = +m1[2]; r <= +m2[2]; r++) for (let c = colNum(m1[1]); c <= colNum(m2[1]); c++) {
    const k = keyOf(sheet, `${colStr(c)}${r}`);
    if (state.items[k]) keys.push(k);
  }
  return keys;
}

/**
 * 例の割当てを適用する。
 * @returns {{cells:number, ranges:number}} cells＝割り当てた入力セルの数、ranges＝行った一括割当ての処理（範囲）の数。
 *   画面の「割当て処理（回）」は ranges だけ増える。cells・ranges は人が行った操作の回数ではない
 */
export function applySampleAssignment(state) {
  const before = state.counters.assignOps;
  let cells = 0;
  for (const a of SAMPLE_ASSIGN) cells += assign(state, rangeKeys(state, a.sheet, a.range), a.depts);
  for (const o of SAMPLE_OPTIONAL) setOptional(state, rangeKeys(state, o.sheet, o.range), true);
  return { cells, ranges: state.counters.assignOps - before };
}

/**
 * 架空の回答例を各課に入力する（提出まではしない）。
 * @param {object[]} answers fixtures/answers.json の内容
 * @param {string[]} [only] 対象の課。省略時は全課
 */
export function applySampleAnswers(state, answers, only, now = Date.now()) {
  const byKey = new Map(answers.map((a) => [keyOf(a.sheet, a.cell), a]));
  for (const d of DEPTS) {
    if (only && !only.includes(d.id)) continue;
    for (const it of itemsOf(state, d.id)) {
      const multi = MULTI_ANSWERS[it.key]?.[d.id];
      const a = byKey.get(it.key);
      if (multi != null) setAnswer(state, it.key, d.id, multi, now);
      else if (!a) continue;
      else if (a.type === 'blank') {
        if (!it.optional) setNA(state, it.key, d.id, true, now); // 必須の空欄は「該当なし」
      } else if (it.type === 'percent') setAnswer(state, it.key, d.id, String(Math.round(a.value * 1e6) / 1e4), now);
      else setAnswer(state, it.key, d.id, String(a.value), now);
    }
  }
}

/** 回答例を入れ、指定した課（省略時は全課）を提出済みにする。 */
export function applySampleSubmissions(state, answers, only, now = Date.now()) {
  applySampleAnswers(state, answers, only, now);
  const done = [];
  for (const d of DEPTS) {
    if (only && !only.includes(d.id)) continue;
    if (itemsOf(state, d.id).length && submit(state, d.id, now).ok) done.push(d.id);
  }
  return done;
}

export { COORDINATOR };
