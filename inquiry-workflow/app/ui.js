// 画面の部品（HTML文字列を作る小さな関数）。
import { colName, refOf } from '../lib/xlsx-layout.js';
import * as M from './model.js';
import { S } from './store.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
export const fmtTime = (t) => {
  if (!t) return '－';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fmtDeadline = (iso) => {
  if (!iso) return '未設定';
  const d = new Date(`${iso}T00:00:00`);
  const days = Math.ceil((d - new Date(new Date().toDateString())) / 86400000);
  const rest = days > 0 ? `あと${days}日` : days === 0 ? '本日' : `${-days}日超過`;
  return `${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}） ${rest}`;
};
export const statusBadge = (st) => `<span class="badge st-${st}">${M.STATUS[st]}</span>`;

/** 項目を担当課の短い名前で表す（色だけに頼らない）。 */
export function ownerChip(item) {
  if (!item.depts.length) return '<span class="chip c-none">未割当</span>';
  if (item.depts.length > 1) return `<span class="chip c-multi">複数${item.depts.length}課</span>`;
  const d = M.DEPTS.find((x) => x.id === item.depts[0]);
  return `<span class="chip c-${d.id}">${esc(d.short)}</span>`;
}

/**
 * 原票の1シートを表として描く。見た目の再現ではなく、位置が分かることを目的にする。
 * @param {{state?:object, rows?:[number,number], highlight?:string, assign?:boolean}} opt
 */
export function gridHtml(sheet, opt = {}) {
  const { state, highlight, assign } = opt;
  const [r1, r2] = opt.rows ?? [1, sheet.maxRow];
  const cols = [];
  for (let c = 1; c <= sheet.maxCol; c++) cols.push(c);
  const width = (c) => Math.max(56, Math.min(300, Math.round((sheet.colWidths[c] ?? 9) * 7.2)));
  let html = `<table class="grid${assign ? ' assign' : ''}" data-sheet="${esc(sheet.name)}"><colgroup><col style="width:36px">${cols.map((c) => `<col style="width:${width(c)}px">`).join('')}</colgroup>`;
  html += `<thead><tr><th class="corner"${assign ? ' data-all="1" title="シート全体を選択"' : ''}></th>${cols.map((c) => `<th${assign ? ` data-colhead="${c}" title="列を選択"` : ''}>${colName(c)}</th>`).join('')}</tr></thead><tbody>`;
  for (let r = Math.max(1, r1); r <= Math.min(sheet.maxRow, r2); r++) {
    html += `<tr><th${assign ? ` data-rowhead="${r}" title="行を選択"` : ''}>${r}</th>`;
    for (const c of cols) {
      const ref = refOf(c, r);
      if (sheet.covered.has(ref)) continue;
      const m = sheet.merges.find((x) => x.topLeft === ref);
      const span = m ? `${m.c2 > m.c1 ? ` colspan="${m.c2 - m.c1 + 1}"` : ''}${m.r2 > m.r1 ? ` rowspan="${Math.min(m.r2, r2) - m.r1 + 1}"` : ''}` : '';
      const cell = sheet.cells.get(ref);
      const item = state?.items[M.keyOf(sheet.name, ref)];
      const cls = [];
      let body = '';
      let title = '';
      if (item) {
        cls.push('in', item.depts.length > 1 ? 'd-multi' : `d-${item.depts[0] ?? 'none'}`);
        // 担当課のチップと並べて、原票に元からある内容（「　年　月」等）も出す。割り当てても原票は書き換わらない
        const orig = cell?.display ?? '';
        body = ownerChip(item) + (item.optional ? '<span class="opt">任意</span>' : '') + (orig ? `<span class="orig">${esc(orig)}</span>` : '');
        title = `${item.label}（${M.TYPE_LABEL[item.type]}）${orig ? `／原票の内容：${orig}` : ''}`;
      } else if (cell?.isFormula) {
        cls.push('fx');
        body = '<span class="fxm">数式</span>';
        title = '数式セル（書き込み不可）';
      } else if (cell && cell.value != null && cell.value !== '') {
        body = esc(String(cell.value));
        title = String(cell.value);
      }
      if (ref === highlight) cls.push('hl');
      html += `<td data-ref="${ref}" data-c="${c}" data-r="${r}"${m ? ` data-c2="${m.c2}" data-r2="${m.r2}"` : ''}${span} class="${cls.join(' ')}" title="${esc(title)}">${body}</td>`;
    }
    html += '</tr>';
  }
  return `${html}</tbody></table>`;
}

export const legendHtml = () => `<p class="legend">
  ${M.DEPTS.filter((d) => d.id !== M.COORDINATOR).map((d) => `<span class="chip c-${d.id}">${esc(d.short)}</span>`).join('')}
  <span class="chip c-multi">複数課</span><span class="chip c-none">未割当</span>＝入力セル（未割当ては自課で回答）
  <span class="fxm">数式</span>＝数式セル（書き込まない）
  <span class="orig">原票の内容</span>＝原票に元からある文字・数値（割り当てても変わらず、回答がなければそのまま残ります）</p>`;

export const dialogHtml = (title, body, foot = '') => `<form method="dialog" class="dlg">
  <header><h2>${esc(title)}</h2><button type="button" class="link" data-act="close-dialog" aria-label="閉じる">閉じる ✕</button></header>
  <div class="dlg-body">${body}</div>${foot ? `<footer>${foot}</footer>` : ''}</form>`;

/** 保存の状態を表す文（失敗しているときは、保存済みと見せない）。 */
export function savedText() {
  if (S.ui.saveError) return '保存できていません（再読み込みすると入力が失われます）';
  return S.ui.savedAt ? `自動保存済み ${fmtTime(S.ui.savedAt)}` : '入力は自動で保存されます';
}

/** 回答1件を人が読める文字列にする。 */
export function answerText(state, item, dept) {
  const p = M.parsed(state, item, dept);
  if (p.state === 'na') return '該当なし';
  if (p.state === 'empty') return '';
  if (p.state === 'error') return `${M.answerOf(state, item.key, dept).raw}（誤り）`;
  return item.type === 'percent' ? `${p.value}％` : String(p.value);
}
