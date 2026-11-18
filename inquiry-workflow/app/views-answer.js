// 回答部署の画面：自課の項目だけを表示し、回答・途中保存（自動）・提出・差戻し対応を行う。
import { colName } from '../lib/xlsx-layout.js';
import * as M from './model.js';
import { S, originalText } from './store.js';
import { esc, fmtTime, fmtDeadline, statusBadge, answerText, savedText } from './ui.js';

export function answerHtml() {
  const st = S.state;
  if (!st.inquiry) return '<h1>回答する</h1><p class="empty">まだ照会が登録されていません。とりまとめ部署の画面で原票を登録してください。</p>';
  if (!st.inquiry.opened) return `<h1>${esc(st.inquiry.title)}</h1><p class="empty">まだ回答の受付が始まっていません（とりまとめ部署が「② 依頼」で受付を始めると入力できます）。</p>`;
  const dept = S.ui.dept;
  if (!dept) return pickDeptHtml();
  return deptHtml(dept);
}

function pickDeptHtml() {
  const st = S.state;
  const list = M.DEPTS.filter((d) => M.itemsOf(st, d.id).length);
  return `<h1>${esc(st.inquiry.title)}</h1>
  <p>所属課を選んでください。選んだ課の項目だけが表示されます。</p>
  <p class="hint">本番では職員の所属から自動で判定する想定です。このPoCには認証がないため、課を選びます。</p>
  <ul class="dept-pick">${list.map((d) => `<li><button type="button" data-act="pick-dept" data-dept="${d.id}">
    <b>${esc(d.name)}</b><span>${M.itemsOf(st, d.id).length}項目</span>${statusBadge(M.deptStatus(st, d.id))}</button></li>`).join('')}</ul>`;
}

/** 自課の項目を、シートごとに「設問（行ごと）」か「表（数値の表）」にまとめる。 */
export function groupsFor(items) {
  const bySheet = new Map();
  for (const it of items) {
    if (!bySheet.has(it.sheet)) bySheet.set(it.sheet, []);
    bySheet.get(it.sheet).push(it);
  }
  const out = [];
  for (const [sheet, list] of bySheet) {
    const rows = new Map();
    for (const it of list) {
      if (!rows.has(it.row)) rows.set(it.row, []);
      rows.get(it.row).push(it);
    }
    const cols = [...new Set(list.map((it) => it.col))].sort((a, b) => a - b);
    const numeric = list.every((it) => it.type === 'number' || it.type === 'percent');
    if (numeric && rows.size >= 2 && cols.length >= 2) {
      out.push({ kind: 'table', sheet, rows: [...rows.keys()].sort((a, b) => a - b), cols, list });
    } else {
      out.push({ kind: 'list', sheet, questions: [...rows.entries()].sort(([a], [b]) => a - b).map(([row, its]) => ({ row, items: its.sort((a, b) => a.col - b.col) })) });
    }
  }
  return out;
}

const markOf = (st, it, dept) => {
  const p = M.parsed(st, it, dept);
  if (p.state === 'error') return '<span class="mark err">⚠ 誤り</span>';
  if (p.state === 'ok' || p.state === 'na') return '<span class="mark ok">✔ 入力済み</span>';
  return it.optional ? '<span class="mark opt">任意</span>' : '<span class="mark todo">● 未入力</span>';
};

function fieldHtml(st, it, dept, { locked, label }) {
  const a = M.answerOf(st, it.key, dept);
  const p = M.parsed(st, it, dept);
  const na = !!a?.na;
  const raw = a?.raw ?? '';
  const id = `f-${btoa(unescape(encodeURIComponent(it.key))).replace(/[^A-Za-z0-9]/g, '')}`;
  const dis = locked || na ? ' disabled' : '';
  const common = `id="${id}" data-key="${esc(it.key)}" aria-describedby="${id}-msg"${p.state === 'error' ? ' aria-invalid="true"' : ''}${dis}`;
  let input;
  if (it.type === 'choice') {
    input = `<select ${common}><option value="">選んでください</option>${it.options.map((o) => `<option${o === raw ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (it.type === 'date') {
    input = `<input type="date" ${common} value="${esc(raw)}">`;
  } else if (it.type === 'number' || it.type === 'percent') {
    input = `<span class="num-in"><input type="text" inputmode="decimal" ${common} value="${esc(raw)}">${it.type === 'percent' ? '<span class="unit">％</span>' : ''}</span>`;
  } else {
    input = `<textarea rows="${raw.includes('\n') || raw.length > 40 ? 3 : 2}" ${common}>${esc(raw)}</textarea>`;
  }
  // 原票に元からある内容（「　年　月」等）。入力欄には入れず、入力済みにも数えない。回答しなければ原票のまま残る
  const orig = originalText(it);
  const origRef = orig ? `<p class="orig-ref" data-testid="orig-ref"><span class="orig-label">原票の記入例／既存値</span><span class="orig-val">${esc(orig)}</span><small>入力欄には入っていません。回答しなければ、原票のままです</small></p>` : '';
  return `<div class="field" data-field="${esc(it.key)}">
    <label for="${id}">${esc(label)}${it.optional ? '<span class="opt">任意</span>' : ''}<span class="tlabel">${M.TYPE_LABEL[it.type]}</span></label>
    ${origRef}
    ${input}
    <div class="field-foot">
      <label class="check small"><input type="checkbox" data-na="${esc(it.key)}"${na ? ' checked' : ''}${locked ? ' disabled' : ''}> 該当なし</label>
      <button type="button" class="link" data-act="pos" data-item="${esc(it.key)}">原票での位置（${esc(it.sheet)} ${esc(it.cell)}）</button>
      <span class="status-slot">${markOf(st, it, dept)}</span>
    </div>
    <p class="msg" id="${id}-msg">${p.state === 'error' ? esc(p.error) : ''}</p>
  </div>`;
}

function questionHtml(st, q, dept, locked, returnedKeys) {
  const first = q.items[0];
  const title = first.rowLabel || first.label;
  const multi = q.items.some(M.isMulti);
  const notes = q.items.map((it) => it.note).filter(Boolean);
  return `<article class="q" id="q-${esc(first.sheet)}-${q.row}">
    <h3>${esc(title)}</h3>
    ${notes.length ? `<p class="note">補足：${esc(notes.join('／'))}</p>` : ''}
    ${multi ? '<p class="note multi">※ 複数課で回答する項目です。とりまとめ課が各課の回答をまとめます。</p>' : ''}
    ${q.items.map((it) => (returnedKeys.has(it.key)
    ? `<p class="note returned-note">「${esc(it.colLabel || '回答')}」は差戻し中です。上の「差戻し」で修正してください。</p>`
    : fieldHtml(st, it, dept, { locked, label: it.colLabel && it.colLabel !== title ? it.colLabel : '回答' }))).join('')}
  </article>`;
}

function tableHtml(st, g, dept, locked, returnedKeys) {
  let hasOrig = false;
  const byPos = new Map(g.list.map((it) => [`${it.row}:${it.col}`, it]));
  const head = g.cols.map((c) => {
    const it = g.list.find((x) => x.col === c);
    return `<th scope="col">${esc(it?.colLabel || colName(c))}</th>`;
  }).join('');
  const body = g.rows.map((r) => {
    const rowItem = g.list.find((x) => x.row === r);
    const cells = g.cols.map((c) => {
      const it = byPos.get(`${r}:${c}`);
      if (!it) return '<td class="none"></td>';
      const a = M.answerOf(st, it.key, dept);
      const p = M.parsed(st, it, dept);
      const shown = a?.na ? '-' : a?.raw ?? '';
      const ret = returnedKeys.has(it.key);
      const lbl = `${it.rowLabel} ${it.colLabel}`;
      const orig = originalText(it);
      if (orig) hasOrig = true;
      return `<td class="${p.state === 'error' ? 'err' : ''}${ret ? ' returned' : ''}"><input type="text" inputmode="decimal" data-key="${esc(it.key)}" data-table="1" data-r="${g.rows.indexOf(r)}" data-c="${g.cols.indexOf(c)}"
        aria-label="${esc(lbl)}" value="${esc(shown)}"${orig ? ` placeholder="${esc(orig)}"` : ''}${p.state === 'error' ? ' aria-invalid="true"' : ''}${locked || ret ? ' disabled' : ''} title="${esc(ret ? '差戻し中：上の欄で修正してください' : p.state === 'error' ? p.error : `${it.sheet} ${it.cell}${orig ? `／原票の記入例・既存値：${orig}` : ''}`)}">${it.type === 'percent' ? '<span class="unit">％</span>' : ''}</td>`;
    }).join('');
    return `<tr><th scope="row">${esc(rowItem?.rowLabel || r)}</th>${cells}</tr>`;
  }).join('');
  return `<div class="tbl-in-wrap"><table class="tbl tbl-in" data-sheet="${esc(g.sheet)}"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div>
  <p class="hint">表の欄はExcelと同じように扱えます：Excelの範囲をコピーして左上の欄に貼り付けると、まとめて入ります。Enterで下の欄へ移ります。該当がない欄は「-」と入力してください。</p>
  ${hasOrig ? '<p class="hint" data-testid="orig-hint">欄の中の<span class="orig-ph">薄い文字</span>は、原票に元からある記入例・既存値です（入力済みではありません。回答しなければ、原票のままです）。</p>' : ''}`;
}

function returnsHtml(st, dept, locked) {
  const recs = M.openReturns(st, dept);
  if (!recs.length) return '';
  return `<section class="returns" aria-labelledby="ret-h"><h2 id="ret-h">差戻し（未解消 ${recs.length}件）</h2>
  <p class="hint">値を直すか、直さない理由を返答してから、再提出してください。ほかの項目は直す必要はありません。</p>
  ${recs.map((r) => {
    const it = st.items[r.key];
    if (!it) return '';
    return `<article class="q returned">
      <h3>${esc(it.label)}</h3>
      <p class="reason"><b>とりまとめ課より（${fmtTime(r.at)}）：</b>${esc(r.reason)}</p>
      ${fieldHtml(st, it, dept, { locked, label: '回答' })}
      <label class="fld">直さない場合の返答（任意）<input type="text" data-reply="${esc(r.id)}" value="${esc(r.reply)}" placeholder="例：確認しましたが、この値で正しいです"></label>
    </article>`;
  }).join('')}</section>`;
}

function deptHtml(dept) {
  const st = S.state;
  const items = M.itemsOf(st, dept);
  const p = M.progress(st, dept);
  const status = M.deptStatus(st, dept);
  const locked = status === 'submitted';
  const returnedKeys = new Set(M.openReturns(st, dept).map((r) => r.key));
  const visible = S.ui.onlyMissing ? items.filter((it) => M.parsed(st, it, dept).state === 'empty' || M.parsed(st, it, dept).state === 'error') : items;
  const groups = groupsFor(visible);
  const resolvedCount = st.returns.filter((r) => r.dept === dept && r.resolved).length;
  return `<div class="ans-head">
    <div><h1>${esc(st.inquiry.title)}</h1>
      <p class="sub"><b>${esc(M.deptName(dept))}</b>　${statusBadge(status)}　庁内締切 ${esc(fmtDeadline(st.inquiry.deadline))}</p></div>
    <div class="ans-meter" aria-live="polite"><b id="done-count">${p.done}</b> / ${p.required}<span>入力済み（必須）</span>
      <small id="saved-at" class="${S.ui.saveError ? 'err' : ''}">${esc(savedText())}</small></div>
  </div>
  <p class="hint">問合せ先：${esc(M.deptName(M.COORDINATOR))}（とりまとめ）　<button type="button" class="link" data-act="switch-dept">課を切り替える</button></p>
  ${locked ? `<div class="alert ok" role="status">提出済みです（${fmtTime(st.submitted[dept])}）。直したいときは、提出を取り消してから修正し、もう一度提出してください。
      <button type="button" data-act="withdraw">提出を取り消して修正する</button></div>` : ''}
  ${status === 'returned' ? '<div class="alert warn" role="status">差戻しがあります。下の項目を確認して、再提出してください。</div>' : ''}
  <div class="toolbar">
    <label class="check"><input type="checkbox" id="only-missing"${S.ui.onlyMissing ? ' checked' : ''}> 未入力・誤りだけ表示</label>
    <button type="button" data-act="print">回答一覧を印刷（課内確認用）</button>
  </div>
  ${returnsHtml(st, dept, locked)}
  ${groups.map((g) => `<section class="sheet-sec"><h2>${esc(g.sheet)}</h2>
    ${g.kind === 'table' ? tableHtml(st, g, dept, locked, returnedKeys) : g.questions.map((q) => questionHtml(st, q, dept, locked, returnedKeys)).join('')}</section>`).join('')}
  ${!groups.length && S.ui.onlyMissing ? '<p class="empty">未入力・誤りの項目はありません。</p>' : ''}
  ${resolvedCount ? `<p class="hint">解消済みの差戻し ${resolvedCount}件は、とりまとめ課の画面に履歴として残っています。</p>` : ''}
  <div class="submit-bar">${locked ? '' : `<button type="button" class="primary" data-act="precheck">${status === 'returned' ? '再提出前の確認へ →' : '提出前の確認へ →'}</button>`}</div>
  <section class="print-only" aria-hidden="true"><h1>${esc(st.inquiry.title)}　${esc(M.deptName(dept))} 回答一覧</h1>
    <table><thead><tr><th>位置</th><th>項目</th><th>回答</th></tr></thead><tbody>
    ${items.map((it) => `<tr><td>${esc(it.sheet)} ${esc(it.cell)}</td><td>${esc(it.label)}</td><td>${esc(answerText(st, it, dept))}</td></tr>`).join('')}</tbody></table></section>`;
}

/** 提出前の確認（ダイアログの中身）。 */
export function precheckHtml(dept) {
  const st = S.state;
  const p = M.progress(st, dept);
  const un = M.unhandledReturns(st, dept);
  const blockers = M.submitBlockers(st, dept);
  const list = (title, its) => (its.length ? `<h3>${title}（${its.length}件）</h3><ul class="jump">${its.map((it) => `<li><button type="button" class="link" data-act="focus" data-item="${esc(it.key)}">${esc(it.label)}</button></li>`).join('')}</ul>` : '');
  return {
    body: `${blockers.length ? '<div class="alert warn">まだ提出できません。下の項目を確認してください。</div>' : '<div class="alert ok">すべての必須項目に入力があります。</div>'}
      <p>入力済み（必須） ${p.done} / ${p.required}${p.optionalEmpty ? `　任意で空欄 ${p.optionalEmpty}件（空欄のまま提出できます）` : ''}</p>
      ${list('未入力', p.missing)}${list('入力に誤り', p.errors)}${list('差戻しに未対応', un.map((r) => st.items[r.key]).filter(Boolean))}`,
    foot: blockers.length ? '<button type="button" data-act="close-dialog">入力に戻る</button>'
      : `<button type="button" data-act="close-dialog">戻る</button><button type="button" class="primary" data-act="submit">${M.openReturns(st, dept).length ? '再提出する' : '提出する'}</button>`,
  };
}
