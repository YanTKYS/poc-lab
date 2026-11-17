// とりまとめ部署の画面：原票の登録、① 割当て、② 依頼、③ 進捗・集約、④ 出力。
import { describeCell, refOf, colName, REASON_LABEL } from '../lib/xlsx-layout.js';
import * as M from './model.js';
import { S, layout, answerUrl } from './store.js';
import { esc, fmtTime, statusBadge, ownerChip, gridHtml, legendHtml, answerText } from './ui.js';

const TABS = [['assign', '① 割当て'], ['request', '② 依頼'], ['progress', '③ 進捗・集約'], ['output', '④ 確認用Excel（ドラフト）']];

export function coordinatorHtml() {
  const st = S.state;
  if (!st.inquiry) return registerHtml();
  const tab = S.ui.tab;
  const body = { assign: assignHtml, request: requestHtml, progress: progressHtml, output: outputHtml }[tab]();
  return `<div class="inq-head"><h1>${esc(st.inquiry.title)}</h1>
    <p class="sub">原票：${esc(st.inquiry.sourceName)}（登録後は書き換えません）</p></div>
    <nav class="tabs" aria-label="とりまとめ部署の作業">${TABS.map(([id, label]) => `<button type="button" data-act="tab" data-tab="${id}"${id === tab ? ' aria-current="step"' : ''}>${label}</button>`).join('')}</nav>
    ${body}`;
}

// ---- 原票の登録 ----------------------------------------------------------
function registerHtml() {
  const err = S.ui.registerError;
  return `<h1>照会を始める（原票の登録）</h1>
  <p>国等から届いたExcel（原票）を登録します。原票は書き換えずに保管し、最後にその複製へ回答を書き込みます。</p>
  ${err ? `<div class="alert error" role="alert"><strong>この原票は扱えません。</strong><ul>${err.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  <div class="cards2">
    <section class="card">
      <h2>架空の原票で試す</h2>
      <p>「地域デジタル化取組状況調査（架空）」。4シート・入力セル62個の検証用の様式です。</p>
      <button type="button" class="primary" data-act="load-sample">架空の原票を読み込む</button>
    </section>
    <section class="card">
      <h2>手元の .xlsx を選ぶ</h2>
      <p><strong>架空のデータだけ</strong>を使ってください。ファイルはこのブラウザの中だけで処理し、外部へ送信しません。</p>
      <label class="file">ファイルを選ぶ <input type="file" id="file" accept=".xlsx"></label>
      <p class="hint">対象外：旧形式（.xls）、マクロ付き（.xlsm）、パスワード付き、行を追加していく様式</p>
    </section>
  </div>`;
}

// ---- ① 割当て ------------------------------------------------------------
export function selectedRefs() {
  const sel = S.ui.sel;
  const sheet = layout().byName[S.ui.sheet];
  if (!sel || !sheet) return [];
  const out = [];
  for (let r = sel.r1; r <= sel.r2; r++) for (let c = sel.c1; c <= sel.c2; c++) {
    const ref = refOf(c, r);
    if (!sheet.covered.has(ref)) out.push(ref);
  }
  return out;
}
export const selectedKeys = () => selectedRefs().map((ref) => M.keyOf(S.ui.sheet, ref)).filter((k) => S.state.items[k]);
const selLabel = (sel) => (sel.c1 === sel.c2 && sel.r1 === sel.r2 ? refOf(sel.c1, sel.r1) : `${refOf(sel.c1, sel.r1)}:${refOf(sel.c2, sel.r2)}`);

function assignHtml() {
  const st = S.state;
  const L = layout();
  if (!S.ui.sheet || !L.byName[S.ui.sheet]) S.ui.sheet = (L.sheets.find((s) => M.itemList(st).some((it) => it.sheet === s.name)) ?? L.sheets[0]).name;
  const sheet = L.byName[S.ui.sheet];
  const items = M.itemList(st);
  const unassigned = items.filter((it) => !it.depts.length);
  const counts = (name) => {
    const all = items.filter((it) => it.sheet === name);
    return { all: all.length, un: all.filter((it) => !it.depts.length).length };
  };
  return `<div class="assign-layout">
    <section aria-label="原票">
      <div class="sheet-tabs" role="tablist">${L.sheets.map((s) => {
        const c = counts(s.name);
        return `<button type="button" role="tab" data-act="sheet" data-sheet="${esc(s.name)}" aria-selected="${s.name === sheet.name}">${esc(s.name)}<small>${c.all ? `入力${c.all}${c.un ? `・未割当${c.un}` : ''}` : '入力なし'}</small></button>`;
      }).join('')}</div>
      <p class="hint">セルをドラッグ（または Shift＋クリック）で範囲を選び、右の担当課を押します。行番号・列名・左上の角を押すと、行・列・シート全体を選べます。</p>
      <div class="range-row"><label for="range-input">範囲を番地で指定</label><input type="text" id="range-input" placeholder="例 C5:D8" autocomplete="off" size="10"><button type="button" data-act="select-range">選択</button></div>
      <div class="grid-wrap" id="assign-grid">${gridHtml(sheet, { state: st, assign: true })}</div>
      ${legendHtml()}
    </section>
    <aside class="panel" aria-label="割当て">
      <div class="stat-row">
        <div><b>${items.length}</b><span>入力セル</span></div>
        <div><b>${items.length - unassigned.length}</b><span>割当て済み</span></div>
        <div><b>${unassigned.length}</b><span>未割当て（自課）</span></div>
        <div title="一括割当ての処理を行った回数（例：9範囲を割り当てれば9回）。クリックやドラッグの回数ではありません"><b data-testid="assign-ops">${st.counters.assignOps}</b><span>割当て処理（回）</span></div>
      </div>
      <div id="sel-panel">${selPanelHtml()}</div>
      <details class="demo"><summary>デモ用ショートカット</summary>
        <p class="hint">架空の原票専用。設計資料の例どおり、9範囲を9回の操作として割り当てます。</p>
        <button type="button" data-act="sample-assign">例の割当てを適用する</button>
      </details>
      <p class="next"><button type="button" class="primary" data-act="tab" data-tab="request">依頼内容の確認へ →</button></p>
    </aside></div>`;
}

/** 選択範囲に対する操作のパネル（選択が変わるたびに、ここだけ描き直す）。 */
export function selPanelHtml() {
  const st = S.state;
  const sel = S.ui.sel;
  if (!sel) return '<p class="empty">左の表で範囲を選ぶと、ここに操作が表示されます。</p>';
  const sheet = layout().byName[S.ui.sheet];
  const refs = selectedRefs();
  const keys = selectedKeys();
  const addable = refs.filter((ref) => !st.items[M.keyOf(sheet.name, ref)] && !sheet.cells.get(ref)?.isFormula);
  const one = keys.length === 1 ? st.items[keys[0]] : null;
  const others = M.DEPTS.filter((d) => d.id !== M.COORDINATOR);
  return `<h2>選択中：${esc(sheet.name)} ${selLabel(sel)}<small>入力セル ${keys.length}個</small></h2>
  ${keys.length ? `
    <h3>担当課を割り当てる</h3>
    <div class="dept-buttons">${others.map((d) => `<button type="button" class="chip-btn c-${d.id}" data-act="assign" data-dept="${d.id}">${esc(d.name)}</button>`).join('')}
      <button type="button" class="chip-btn c-none" data-act="assign" data-dept="">割当てを外す（自課で回答）</button></div>
    <details class="multi"><summary>複数課で回答する項目にする</summary>
      <div class="checks">${others.map((d) => `<label><input type="checkbox" name="multi" value="${d.id}"> ${esc(d.name)}</label>`).join('')}</div>
      <button type="button" data-act="assign-multi">選んだ課に割り当てる</button>
    </details>
    <h3>その他</h3>
    <div class="btn-row">
      <button type="button" data-act="optional" data-v="1">任意項目にする</button>
      <button type="button" data-act="optional" data-v="0">必須に戻す</button>
      <button type="button" data-act="remove-input">入力不要にする</button>
    </div>` : '<p class="empty">この範囲に入力セルはありません。</p>'}
  ${addable.length ? `<div class="btn-row"><button type="button" data-act="add-input">入力セルにする（${addable.length}セル）</button></div>` : ''}
  ${one ? `<h3>見出し・型（自動抽出。違っていたら直す）</h3>
    <label class="fld">見出し<input type="text" data-edit="label" value="${esc(one.label)}"></label>
    <label class="fld">型<select data-edit="type">${Object.entries(M.TYPE_LABEL).filter(([t]) => t !== 'choice' || one.options).map(([t, l]) => `<option value="${t}"${t === one.type ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="fld">補足・記入例（任意）<input type="text" data-edit="note" value="${esc(one.note)}" placeholder="例：4月1日時点の件数"></label>
    <p class="hint">担当：${ownerChip(one)}${one.optional ? '　任意項目' : ''}　候補の根拠：${one.reasons.map((r) => REASON_LABEL[r] ?? '手動で追加').join('・') || '手動で追加'}${one.options ? `<br>選択肢：${esc(one.options.join('／'))}` : ''}</p>`
    : keys.length ? `<h3>見出し（自動抽出）</h3><ul class="labels">${keys.slice(0, 4).map((k) => `<li>${esc(st.items[k].cell)}　${esc(st.items[k].label)}</li>`).join('')}${keys.length > 4 ? `<li>ほか ${keys.length - 4} 項目</li>` : ''}</ul><p class="hint">1セルだけ選ぶと、見出し・型・補足を直せます。</p>` : ''}`;
}

export function addSelectedAsInput() {
  const st = S.state;
  const L = layout();
  const sheet = L.byName[S.ui.sheet];
  const isInput = (ref) => !!st.items[M.keyOf(sheet.name, ref)];
  let n = 0;
  for (const ref of selectedRefs()) {
    if (isInput(ref) || sheet.cells.get(ref)?.isFormula) continue;
    M.addItem(st, { ...describeCell(L, sheet.name, ref, isInput), reasons: ['manual'] });
    n++;
  }
  return n;
}

// ---- ② 依頼 --------------------------------------------------------------
function requestHtml() {
  const st = S.state;
  const items = M.itemList(st);
  const un = items.filter((it) => !it.depts.length).length;
  const rows = M.DEPTS.map((d) => {
    const mine = M.itemsOf(st, d.id);
    return `<tr><th scope="row">${esc(d.name)}${d.id === M.COORDINATOR ? '（自課）' : ''}</th><td class="num">${mine.length}</td><td class="num">${mine.filter((it) => it.optional).length}</td><td class="num">${mine.filter(M.isMulti).length}</td></tr>`;
  }).join('');
  return `<h2>依頼内容の確認</h2>
  <table class="tbl narrow"><thead><tr><th>課</th><th>担当項目</th><th>うち任意</th><th>うち複数課項目</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="hint">入力セルは ${items.length} 個です。複数課項目は関係する課それぞれに数えています。${un ? `<br><strong>未割当ての ${un} 項目は、自課（${esc(M.deptName(M.COORDINATOR))}）が回答します。</strong>` : ''}</p>
  <label class="fld inline">庁内締切 <input type="date" id="deadline" value="${esc(st.inquiry.deadline)}"></label>
  ${st.inquiry.opened ? `
    <div class="alert ok" role="status">回答の受付を始めました。下の依頼文は、<strong>コピーの使い勝手を試すためのデモ専用</strong>です。</div>
    <div class="alert warn" role="note"><strong>この文面は実際の依頼には使えません。</strong>このPoCは1台の端末・同じブラウザの中だけで動き、別の端末でリンクを開いても回答内容は共有されません。実際のメール送信・自動通知・共有の機能もありません（実運用では、同様の文面を既存のメール／グループウェアで人が送る想定です）。</div>
    <h3>依頼文（デモ専用・共通リンク入り）</h3>
    <textarea class="copytext" id="request-text" readonly rows="14">${esc(M.requestText(st, answerUrl()))}</textarea>
    <div class="btn-row"><button type="button" class="primary" data-act="copy" data-copy="request">依頼文をコピー</button>
      <button type="button" data-act="tab" data-tab="progress">進捗・集約へ →</button></div>
    <p class="hint">リンクは照会ごとに共通の1本です。開いた人が所属課を選ぶと、その課の項目だけが表示されます。このPoCでは、同じ端末・同じブラウザで開いたときだけ回答内容が見えます。</p>`
    : '<div class="btn-row"><button type="button" class="primary" data-act="open">回答の受付を始める</button></div><p class="hint">受付を始めると、回答部署の画面で入力できるようになり、依頼文が表示されます。</p>'}`;
}

// ---- ③ 進捗・集約 ---------------------------------------------------------
function progressHtml() {
  const st = S.state;
  if (!st.inquiry.opened) return '<p class="empty">まだ回答の受付を始めていません。「② 依頼」で受付を始めてください。</p>';
  const late = M.reminderText(st, answerUrl()).depts;
  const rows = M.DEPTS.filter((d) => M.itemsOf(st, d.id).length).map((d) => {
    const p = M.progress(st, d.id);
    const open = M.openReturns(st, d.id).length;
    const stt = M.deptStatus(st, d.id);
    return `<tr><th scope="row">${esc(d.name)}${d.id === M.COORDINATOR ? '（自課）' : ''}</th><td>${statusBadge(stt)}</td>
      <td class="num">${p.done} / ${p.required}${p.optionalEmpty ? `<small>（任意の空欄 ${p.optionalEmpty}）</small>` : ''}</td>
      <td>${fmtTime(st.submitted[d.id])}</td>
      <td>${open ? `<button type="button" data-act="copy" data-copy="return" data-dept="${d.id}">差戻しの連絡文をコピー（${open}件）</button>` : ''}
        ${d.id === M.COORDINATOR && stt !== 'submitted' ? '<button type="button" data-act="goto-own">自課の回答を入力する</button>' : ''}</td></tr>`;
  }).join('');
  return `<section><h2>進捗</h2>
    <table class="tbl" data-testid="progress"><thead><tr><th>課</th><th>状態</th><th>入力済み（必須）</th><th>提出</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="btn-row">${late.length ? `<button type="button" data-act="copy" data-copy="reminder">催促文をコピー（未提出 ${late.length}課：${esc(late.map((d) => d.name).join('・'))}）</button>` : '<span class="hint">依頼した課はすべて提出済みです。</span>'}</div>
    <p class="hint">催促文・差戻しの連絡文のコピーも<strong>デモ専用</strong>です（冒頭に「${esc(M.DEMO_HEADING)}」が付き、実際の連絡には使えません。別の端末とは共有されません）。提出されると、この表に自動で反映されます。</p>
    <details class="demo"><summary>デモ用ショートカット</summary>
      <p class="hint">架空の原票専用。まだ提出していない課に回答例を入力し、提出済みにします。</p>
      <button type="button" data-act="sample-answers">回答例を入力して全課を提出済みにする</button></details>
  </section>
  <section><h2>回答の確認</h2>${reviewHtml()}</section>`;
}

function historyHtml(key, dept) {
  const st = S.state;
  const recs = st.returns.filter((r) => r.key === key && (!dept || r.dept === dept));
  const eds = st.edits.filter((e) => e.key === key && (!dept || e.dept === dept));
  if (!recs.length && !eds.length) return '';
  return `<details class="hist"><summary>履歴 ${recs.length + eds.length}件</summary><ul>
    ${recs.map((r) => `<li>${fmtTime(r.at)} 差戻し「${esc(r.reason)}」→ ${r.resolved ? `${fmtTime(r.resolvedAt)} 再提出で解消（${r.before === r.after ? `値は変更なし${r.reply ? `／返答「${esc(r.reply)}」` : ''}` : `${esc(r.before || '空欄')} → ${esc(r.after || '空欄')}`}）` : '未解消'}</li>`).join('')}
    ${eds.map((e) => `<li>${fmtTime(e.at)} とりまとめ課が修正（${esc(e.before || '空欄')} → ${esc(e.after || '空欄')}）</li>`).join('')}</ul></details>`;
}

function reviewHtml() {
  const st = S.state;
  const f = S.ui.filter;
  const rows = [];
  for (const it of M.itemList(st)) {
    const owners = M.ownersOf(it);
    const pos = `${esc(it.sheet)} ${esc(it.cell)}`;
    if (M.isMulti(it)) {
      const fin = st.finals[it.key];
      const fs = M.finalStatus(st, it);
      const ready = M.allOwnersSubmitted(st, it);
      const sug = M.mergeSuggestion(st, it);
      const waiting = owners.filter((d) => M.deptStatus(st, d) !== 'submitted');
      const caution = {
        none: `確定値が未設定${waiting.length ? `（未提出・差戻し中 ${waiting.length}課）` : ''}`,
        waiting: `確定値はありますが、未提出・差戻し中の課があるため書き出しません（${waiting.map(M.deptName).join('・')}）`,
        stale: '確定した後に回答が変わりました。回答を見直して、確定し直してください（それまで書き出しません）',
        ok: '',
      }[fs];
      if (f === 'caution' ? !caution : f !== 'all' && !owners.includes(f)) continue;
      const stateNote = (d) => ({ submitted: '', returned: '（差戻し中）' }[M.deptStatus(st, d)] ?? '（未提出）');
      const parts = owners.map((d) => `<li><b>${esc(M.deptName(d))}</b>：${esc(answerText(st, it, d)) || '<span class="muted">未回答</span>'}<span class="muted">${stateNote(d)}</span></li>`).join('');
      rows.push(`<tr class="multi-row${caution ? ' has-caution' : ''}" data-final-status="${fs}"><td>${pos}</td><td>${esc(it.label)}<br><span class="chip c-multi">複数${owners.length}課</span></td>
        <td colspan="2"><ul class="parts">${parts}</ul>
          <label class="fld">確定値（原票に書く値）
            ${it.type === 'text' ? `<textarea rows="3" data-final="${esc(it.key)}">${esc(fin?.raw ?? '')}</textarea>` : `<input type="text" inputmode="decimal" data-final="${esc(it.key)}" value="${esc(fin?.raw ?? '')}">`}</label>
          <div class="btn-row">${sug && ready ? `<button type="button" data-act="final-suggest" data-key="${esc(it.key)}">${esc(sug.by === 'sum' ? `${sug.label}＝${sug.raw} を採用` : '各課の回答を連結して入れる')}</button>` : ''}
            <button type="button" class="primary" data-act="final-set" data-key="${esc(it.key)}"${ready ? '' : ' disabled'}>${fs === 'stale' ? 'この値で確定し直す' : 'この値で確定'}</button>
            ${fs === 'ok' ? '<span class="okmark">確定済み</span>' : fin ? '<span class="muted">前回の確定値（いまは使いません）</span>' : ''}
            ${fin ? `<button type="button" class="link" data-act="final-clear" data-key="${esc(it.key)}">確定を取り消す</button>` : ''}</div>
          ${ready ? '' : '<p class="hint">担当課がすべて提出してから確定できます。</p>'}</td>
        <td class="caution">${esc(caution)}</td></tr>`);
      continue;
    }
    const d = owners[0];
    const p = M.parsed(st, it, d);
    const open = st.returns.find((r) => !r.resolved && r.key === it.key && r.dept === d);
    const last = [...st.returns].reverse().find((r) => r.resolved && r.key === it.key && r.dept === d);
    let caution = '';
    if (open) caution = `差戻し中（未解消）：${open.reason}`;
    else if (last) caution = last.before === last.after ? `差戻しに返答あり：${last.reply}` : `差戻し後に修正あり（${last.before || '空欄'} → ${last.after || '空欄'}）`;
    else if (p.state === 'error') caution = `入力に誤り：${p.error}`;
    if (f === 'caution' ? !caution : f !== 'all' && f !== d) continue;
    const submitted = !!st.submitted[d];
    rows.push(`<tr class="${caution ? 'has-caution' : ''}"><td>${pos}</td><td>${esc(it.label)}${it.optional ? ' <span class="opt">任意</span>' : ''}</td>
      <td>${esc(M.deptName(d))}${submitted ? '' : '<br><span class="muted">未提出</span>'}</td>
      <td class="ans">${esc(answerText(st, it, d)) || '<span class="muted">未回答</span>'}${historyHtml(it.key, d)}</td>
      <td class="caution">${esc(caution)}
        <div class="btn-row">${submitted && !open ? `<button type="button" data-act="return" data-key="${esc(it.key)}" data-dept="${d}">差戻し</button>` : ''}
          ${submitted ? `<button type="button" data-act="edit" data-key="${esc(it.key)}" data-dept="${d}">編集</button>` : ''}</div></td></tr>`);
  }
  return `<label class="fld inline">表示 <select id="filter">
      <option value="caution"${f === 'caution' ? ' selected' : ''}>注意のある項目だけ</option>
      <option value="all"${f === 'all' ? ' selected' : ''}>すべて</option>
      ${M.DEPTS.filter((d) => M.itemsOf(st, d.id).length).map((d) => `<option value="${d.id}"${f === d.id ? ' selected' : ''}>${esc(d.name)}の項目</option>`).join('')}</select></label>
    ${rows.length ? `<table class="tbl review" data-testid="review"><thead><tr><th>位置</th><th>見出し</th><th>回答課</th><th>回答</th><th>注意・操作</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<p class="empty">${f === 'caution' ? '注意のある項目はありません。' : '該当する項目はありません。'}</p>`}`;
}

// ---- ④ 確認用Excel（ドラフト） -----------------------------------------------
function outputHtml() {
  const st = S.state;
  const plan = M.outputPlan(st);
  const total = M.itemList(st).length;
  const o = S.ui.output;
  return `<h2>確認用Excel（ドラフト）：出力前の確認</h2>
  <div class="alert warn" data-testid="demo-notice"><strong>デモの確認用ファイルです。正式提出には使用しないでください。</strong> Microsoft Excel実機での開封・再計算・保存、および提出先での受理は未確認です（出力方式は条件付き採用：<a href="https://github.com/YanTKYS/poc-lab/blob/main/inquiry-workflow/EXCEL.md" rel="noopener">検証記録</a>）。</div>
  <div class="stat-row wide">
    <div><b data-testid="plan-writes">${plan.writes.length}</b><span>書き込むセル（全 ${total}）</span></div>
    <div><b data-testid="plan-pending">${plan.pending.length}</b><span>書き込まない（未提出・未回答・未確定など）</span></div>
    <div><b data-testid="plan-cautions">${plan.cautions.length}</b><span>注意</span></div>
    <div><b>${plan.skippedOptional}</b><span>任意で空欄</span></div>
  </div>
  <p data-testid="plan-summary"><strong>書き込む ${plan.writes.length}件／書き込まない ${plan.pending.length}件（未提出・未回答・未確定など）／注意 ${plan.cautions.length}件。</strong>${plan.skippedOptional ? `任意項目で空欄の ${plan.skippedOptional}件は、別に数えています（空欄のまま）。` : ''}出力する前に、下の「書き込まない項目」と「注意」を確認してください。</p>
  ${plan.pending.length ? `<h3>書き込まない項目（原票のセルはそのまま残ります）</h3><table class="tbl"><thead><tr><th>位置</th><th>見出し</th><th>理由</th></tr></thead><tbody>
    ${plan.pending.map((p) => `<tr><td>${esc(p.item.sheet)} ${esc(p.item.cell)}</td><td>${esc(p.item.label)}</td><td>${esc(p.why)}</td></tr>`).join('')}</tbody></table>` : ''}
  ${plan.cautions.length ? `<h3>注意</h3><ul>${plan.cautions.map((c) => `<li>${esc(c.item.sheet)} ${esc(c.item.cell)}　${esc(c.item.label)}：${esc(c.why)}</li>`).join('')}</ul>` : ''}
  <label class="check"><input type="checkbox" id="na-text"${st.inquiry.naAsText ? ' checked' : ''}> 文章の項目の「該当なし」は、文言「該当なし」として書く（外すと空欄。数値・日付・選択の項目は常に空欄）</label>
  <details${plan.writes.length && plan.writes.length <= 12 ? ' open' : ''}><summary>書き込む内容の一覧（${plan.rows.length}セル）</summary>
    <table class="tbl" data-testid="plan-rows"><thead><tr><th>シート</th><th>セル</th><th>見出し</th><th>書き込む値</th><th>回答元</th></tr></thead><tbody>
    ${plan.rows.map((r) => `<tr><td>${esc(r.item.sheet)}</td><td>${esc(r.item.cell)}</td><td>${esc(r.item.label)}</td><td class="ans">${esc(r.shown)}</td><td>${esc(r.source)}</td></tr>`).join('')}</tbody></table></details>
  <div class="btn-row"><button type="button" class="primary" data-act="export"${plan.writes.length ? '' : ' disabled'}>確認用Excelを出力する</button>
    ${plan.pending.length ? '<span class="hint">未提出・未回答が残っていても出力できます（途中経過を原票の様式で確かめるため）。</span>' : ''}</div>
  ${o ? outputResultHtml(o) : ''}`;
}

function outputResultHtml(o) {
  if (!o.ok) {
    return `<div class="alert error" role="alert"><strong>出力を中止しました。</strong>原票に書けない指定があります（何も出力していません）。
      <ul>${o.errors.map((e) => `<li>${esc(e.sheet ?? '')} ${esc(e.cell ?? '')}：${esc(e.message)}</li>`).join('')}</ul></div>`;
  }
  const v = o.verify;
  if (!v.ok) {
    return `<div class="alert error" role="alert"><strong>出力後の自動照合で問題が見つかったため、ファイルを渡しません。</strong>
      <ul>${v.problems.slice(0, 20).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
  }
  const s = v.summary;
  return `<section class="result" data-testid="export-result"><h2>確認用Excelを出力しました（${fmtTime(o.at)}）</h2>
    <div class="alert warn" data-testid="result-notice"><strong>デモの確認用ファイルです。正式提出には使用しないでください。</strong>Microsoft Excel実機での開封・再計算・保存、および提出先での受理は未確認です。</div>
    <p><a class="download" id="download" href="${o.url}" download="${esc(o.name)}">${esc(o.name)} をダウンロード</a></p>
    <h3>出力直後の自動照合：<span class="okmark">問題なし</span></h3>
    <ul>
      <li>書き込んだセル ${s.checkedCells} 個は、値と型が計画どおりで、書式番号も元のまま</li>
      <li>対象外のセル ${s.untouchedCells} 個は元と同一。数式 ${s.formulaCells} 個は式が同一（保存されていた計算結果 ${s.formulaResultsCleared} 個だけを消去）</li>
      <li>行の属性・並び（${s.rowsChecked} 行）、結合・入力規則・保護などセル以外の部分は元と同一</li>
      <li>ファイル内の部品は増減なし（変更 ${s.parts.changed.length} ／ 同一 ${s.parts.same}）</li>
    </ul>
    <h3>確認用ファイルとして、Excelで開いて確認すること（自動照合では分かりません）</h3>
    <ul class="todo">
      <li>エラーや「修復」の表示が出ずに開ける</li>
      <li>合計などの数式が計算されている（出力直後のファイルには計算結果が入っていません）</li>
      <li>国側のエラーチェック欄、表示の崩れ、印刷範囲</li>
      <li>確認後、上書き保存する</li>
    </ul></section>`;
}

export { colName };
