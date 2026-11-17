// 画面の切り替えと操作の受け付け。
import { describeCandidates, readLayout, refOf } from '../lib/xlsx-layout.js';
import { inspect, patch } from '../lib/xlsx-patch.js';
import { verifyWriteBack } from '../lib/xlsx-verify.js';
import * as M from './model.js';
import { S, zip, load, save, reset, bytesToB64, sourceBytes, layout, answerUrl } from './store.js';
import { esc, gridHtml, dialogHtml, savedText } from './ui.js';
import { coordinatorHtml, selPanelHtml, selectedKeys, addSelectedAsInput } from './views-coordinator.js';
import { answerHtml, precheckHtml } from './views-answer.js';
import { applySampleAssignment, applySampleSubmissions } from './sample.js';

const SAMPLE = { file: 'fixtures/genpyo.xlsx', title: '地域デジタル化取組状況調査（架空）' };
const MAX_BYTES = 3 * 1024 * 1024;
const app = document.getElementById('app');
const dlg = document.getElementById('dlg');
const role = () => (S.ui.role === 'answer' ? '回答' : 'とりまとめ');

function log(action) {
  if (S.state.inquiry) M.logAction(S.state, role(), action);
}
/** 保存して、その成否を画面に出す（失敗を「保存済み」と見せない）。 */
function persist() {
  const ok = save();
  showSaveState();
  return ok;
}
function showSaveState() {
  const banner = document.getElementById('save-alert');
  banner.hidden = !S.ui.saveError;
  const s = document.getElementById('saved-at');
  if (s) {
    s.textContent = savedText();
    s.classList.toggle('err', S.ui.saveError);
  }
}

function commit(action) {
  if (action) log(action);
  // 状態が変わったら、前に出力したファイルは古くなるので表示から外す
  if (!action?.startsWith('確認用Excelを出力') && S.ui.output) {
    if (S.ui.output.url) URL.revokeObjectURL(S.ui.output.url);
    S.ui.output = null;
  }
  persist();
  render();
}

// ---- 描画 ----------------------------------------------------------------
function render() {
  const keepScroll = window.scrollY;
  document.querySelectorAll('[data-role]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.role === S.ui.role)));
  document.body.dataset.view = S.ui.role;
  app.innerHTML = S.ui.role === 'answer' ? answerHtml() : coordinatorHtml();
  const n = S.state.log.length;
  document.getElementById('log-count').textContent = n ? `（${n}件）` : '';
  if (S.ui.role === 'coordinator' && S.ui.tab === 'assign' && S.state.inquiry) markSelection();
  showSaveState();
  window.scrollTo(0, keepScroll);
  if (S.ui.focusKey) {
    const el = app.querySelector(`[data-key="${CSS.escape(S.ui.focusKey)}"]`);
    S.ui.focusKey = null;
    if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
  }
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500);
}

function openDialog(title, body, foot) {
  dlg.innerHTML = dialogHtml(title, body, foot);
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('textarea, input:not([type=hidden]), select, .primary')?.focus();
}
const closeDialog = () => dlg.open && dlg.close();

// ---- 原票の登録 ------------------------------------------------------------
function register(bytes, name, title) {
  const ins = inspect(bytes, zip);
  const bad = [...ins.unsupported, ...ins.sheets.filter((s) => !s.supported).map((s) => `シート「${s.name}」：${s.reason}`)];
  if (!ins.ok || ins.sheets.every((s) => !s.supported)) {
    S.ui.registerError = bad.length ? bad : ['ワークシートが見つかりません'];
    return render();
  }
  const L = readLayout(zip.unzip(bytes));
  M.registerSource(S.state, { title, sourceName: name, sourceB64: bytesToB64(bytes), descriptions: describeCandidates(L) });
  S.layout = L;
  Object.assign(S.ui, { registerError: null, tab: 'assign', sheet: null, sel: null, output: null });
  if (bad.length) toast(`扱えないシートがあります：${bad.join('、')}`);
  commit(`原票を登録（入力セル候補 ${Object.keys(S.state.items).length}）`);
}

async function loadSample() {
  const res = await fetch(SAMPLE.file);
  register(new Uint8Array(await res.arrayBuffer()), 'genpyo.xlsx', SAMPLE.title);
}

async function loadAnswersJson() {
  return (await fetch('fixtures/answers.json')).json();
}

// ---- 割当て画面の範囲選択 ---------------------------------------------------
let drag = null;
function setSel(c1, r1, c2, r2) {
  const sheet = layout().byName[S.ui.sheet];
  S.ui.sel = { sheet: sheet.name, c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
  markSelection();
  document.getElementById('sel-panel').innerHTML = selPanelHtml();
}
function markSelection() {
  const sel = S.ui.sel;
  app.querySelectorAll('#assign-grid td').forEach((td) => {
    const c = +td.dataset.c;
    const r = +td.dataset.r;
    const c2 = +(td.dataset.c2 ?? c);
    const r2 = +(td.dataset.r2 ?? r);
    const on = sel && sel.sheet === S.ui.sheet && c <= sel.c2 && c2 >= sel.c1 && r <= sel.r2 && r2 >= sel.r1;
    td.classList.toggle('sel', !!on);
  });
}
function cellOf(target) {
  const td = target.closest?.('#assign-grid td');
  return td ? { c: +td.dataset.c, r: +td.dataset.r, c2: +(td.dataset.c2 ?? td.dataset.c), r2: +(td.dataset.r2 ?? td.dataset.r) } : null;
}

app.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const sheet = S.state.inquiry && S.ui.tab === 'assign' ? layout().byName[S.ui.sheet] : null;
  if (!sheet) return;
  const th = e.target.closest('#assign-grid th');
  if (th) {
    if (th.dataset.rowhead) setSel(1, +th.dataset.rowhead, sheet.maxCol, +th.dataset.rowhead);
    else if (th.dataset.colhead) setSel(+th.dataset.colhead, 1, +th.dataset.colhead, sheet.maxRow);
    else if (th.dataset.all) setSel(1, 1, sheet.maxCol, sheet.maxRow);
    return;
  }
  const p = cellOf(e.target);
  if (!p) return;
  e.preventDefault();
  if (e.shiftKey && S.ui.sel && S.ui.sel.sheet === S.ui.sheet) {
    const a = drag?.anchor ?? { c: S.ui.sel.c1, r: S.ui.sel.r1 };
    setSel(a.c, a.r, p.c2, p.r2);
    return;
  }
  drag = { anchor: { c: p.c, r: p.r }, active: true };
  setSel(p.c, p.r, p.c2, p.r2);
});
app.addEventListener('mouseover', (e) => {
  if (!drag?.active) return;
  const p = cellOf(e.target);
  if (p) setSel(Math.min(drag.anchor.c, p.c), Math.min(drag.anchor.r, p.r), Math.max(drag.anchor.c, p.c2), Math.max(drag.anchor.r, p.r2));
});
window.addEventListener('mouseup', () => { if (drag) drag.active = false; });

function selectByText(text) {
  const m = /^\s*([A-Za-z]{1,3})(\d+)(?:\s*[:：]\s*([A-Za-z]{1,3})(\d+))?\s*$/.exec(text);
  if (!m) return toast('範囲は「C5:D8」のように入力してください');
  const col = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const [c1, r1, c2, r2] = [col(m[1]), +m[2], col(m[3] ?? m[1]), +(m[4] ?? m[2])];
  // 表示中のシートの範囲を超える指定は受け付けない（巨大な範囲を指定すると、選択の処理で画面が固まるため）
  const sheet = layout().byName[S.ui.sheet];
  if (Math.min(c1, c2, r1, r2) < 1 || Math.max(c1, c2) > sheet.maxCol || Math.max(r1, r2) > sheet.maxRow) {
    return toast(`このシートの範囲外です（A1:${refOf(sheet.maxCol, sheet.maxRow)} の中で指定してください）`);
  }
  setSel(c1, r1, c2, r2);
}

// ---- クリック操作 -----------------------------------------------------------
const actions = {
  role: (el) => { S.ui.role = el.dataset.role; if (S.ui.role === 'coordinator') history.replaceState(null, '', location.pathname + location.search); render(); },
  tab: (el) => { S.ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  'load-sample': () => loadSample(),
  sheet: (el) => { S.ui.sheet = el.dataset.sheet; S.ui.sel = null; render(); },
  'select-range': () => selectByText(document.getElementById('range-input').value),
  assign: (el) => {
    const keys = selectedKeys();
    const depts = el.dataset.dept ? [el.dataset.dept] : [];
    const n = M.assign(S.state, keys, depts);
    S.ui.sel = null;
    commit(`割当て ${n}項目 → ${depts.length ? M.deptName(depts[0]) : '未割当て'}`);
    toast(`${n}項目を${depts.length ? `${M.deptName(depts[0])}に割り当てました` : '未割当て（自課）に戻しました'}`);
  },
  'assign-multi': () => {
    const depts = [...app.querySelectorAll('input[name=multi]:checked')].map((x) => x.value);
    if (depts.length < 2) return toast('2つ以上の課を選んでください');
    const n = M.assign(S.state, selectedKeys(), depts);
    S.ui.sel = null;
    commit(`割当て ${n}項目 → 複数課（${depts.map(M.deptName).join('・')}）`);
  },
  optional: (el) => { M.setOptional(S.state, selectedKeys(), el.dataset.v === '1'); commit(el.dataset.v === '1' ? '任意項目にする' : '必須に戻す'); },
  'remove-input': () => { const k = selectedKeys(); M.removeItems(S.state, k); commit(`入力不要にする ${k.length}セル`); },
  'add-input': () => { const n = addSelectedAsInput(); commit(`入力セルにする ${n}セル`); },
  'sample-assign': () => { const n = applySampleAssignment(S.state); commit(`例の割当てを適用（${n}操作）`); },
  open: () => { S.state.inquiry.opened = true; commit('回答の受付を始める'); },
  copy: (el) => {
    const url = answerUrl();
    const text = el.dataset.copy === 'request' ? M.requestText(S.state, url)
      : el.dataset.copy === 'reminder' ? M.reminderText(S.state, url).text
        : M.returnText(S.state, el.dataset.dept, url);
    copyText(text);
    log({ request: '依頼文をコピー', reminder: '催促文をコピー', return: '差戻しの連絡文をコピー' }[el.dataset.copy]);
    persist();
    toast('コピーしました（デモ専用の文面です。実際の依頼・連絡には使えません）');
  },
  'goto-own': () => { Object.assign(S.ui, { role: 'answer', dept: M.COORDINATOR }); render(); window.scrollTo(0, 0); },
  'sample-answers': async () => {
    const pending = M.DEPTS.filter((d) => M.itemsOf(S.state, d.id).length && !S.state.submitted[d.id]).map((d) => d.id);
    const done = applySampleSubmissions(S.state, await loadAnswersJson(), pending);
    commit(`回答例を入力して提出（${done.length}課）`);
  },
  return: (el) => {
    const it = S.state.items[el.dataset.key];
    openDialog('この項目を差し戻す', `<p><b>${esc(it.label)}</b>（${esc(M.deptName(el.dataset.dept))}）</p>
      <label class="fld">理由（回答部署の画面の一番上に表示されます）<textarea id="return-reason" rows="3" required></textarea></label>`,
    `<button type="button" data-act="close-dialog">やめる</button><button type="button" class="primary" data-act="return-ok" data-key="${esc(el.dataset.key)}" data-dept="${el.dataset.dept}">差し戻す</button>`);
  },
  'return-ok': (el) => {
    const reason = document.getElementById('return-reason').value.trim();
    if (!reason) return toast('理由を入力してください');
    M.returnItem(S.state, el.dataset.key, el.dataset.dept, reason);
    closeDialog();
    commit(`差戻し ${el.dataset.key}（${M.deptName(el.dataset.dept)}）`);
    toast('差し戻しました。連絡文のコピーを試せます（デモ専用）');
  },
  edit: (el) => {
    const it = S.state.items[el.dataset.key];
    const a = M.answerOf(S.state, it.key, el.dataset.dept);
    openDialog('回答を直す（軽微な誤りの修正）', `<p><b>${esc(it.label)}</b>（${esc(M.deptName(el.dataset.dept))}の回答）</p>
      <label class="fld">新しい値<input type="text" id="edit-value" value="${esc(a?.raw ?? '')}"></label>
      <p class="hint">誰がいつ直したかは履歴に残ります。回答部署への確認が必要なら「差戻し」を使ってください。</p>`,
    `<button type="button" data-act="close-dialog">やめる</button><button type="button" class="primary" data-act="edit-ok" data-key="${esc(it.key)}" data-dept="${el.dataset.dept}">直す</button>`);
  },
  'edit-ok': (el) => {
    const it = S.state.items[el.dataset.key];
    const raw = document.getElementById('edit-value').value;
    const p = M.parseAnswer(it, { raw, na: false });
    if (p.state === 'error') return toast(p.error);
    M.coordinatorEdit(S.state, it.key, el.dataset.dept, raw);
    closeDialog();
    commit(`とりまとめ課が修正 ${it.key}`);
  },
  'final-suggest': (el) => {
    const sug = M.mergeSuggestion(S.state, S.state.items[el.dataset.key]);
    const box = app.querySelector(`[data-final="${CSS.escape(el.dataset.key)}"]`);
    if (sug && box) { box.value = sug.raw; box.dataset.by = sug.by; box.focus(); }
  },
  'final-set': (el) => {
    const it = S.state.items[el.dataset.key];
    const box = app.querySelector(`[data-final="${CSS.escape(it.key)}"]`);
    const p = M.parseAnswer(it, { raw: box.value, na: false });
    if (p.state !== 'ok') return toast(p.state === 'empty' ? '確定値を入力してください' : p.error);
    const r = M.setFinal(S.state, it.key, box.value, box.dataset.by || 'manual');
    if (!r.ok) return toast(r.reason);
    commit(`複数課項目を確定 ${it.key}`);
  },
  'final-clear': (el) => { M.clearFinal(S.state, el.dataset.key); commit(`確定を取り消す ${el.dataset.key}`); },
  export: () => exportXlsx(),
  // 回答部署
  'pick-dept': (el) => { S.ui.dept = el.dataset.dept; S.ui.onlyMissing = false; commit(`課を選ぶ（${M.deptName(el.dataset.dept)}）`); window.scrollTo(0, 0); },
  'switch-dept': () => { S.ui.dept = null; render(); },
  pos: (el) => {
    const it = S.state.items[el.dataset.item];
    const sheet = layout().byName[it.sheet];
    openDialog(`原票での位置：${it.sheet} ${it.cell}`, `<p>${esc(it.label)}</p><div class="grid-wrap small">${gridHtml(sheet, { state: S.state, rows: [it.row - 4, it.row + 4], highlight: it.cell })}</div>`);
    log(`原票での位置を見る ${it.key}`);
  },
  precheck: () => {
    const { body, foot } = precheckHtml(S.ui.dept);
    log('提出前の確認を開く');
    openDialog('提出前の確認', body, foot);
  },
  focus: (el) => { closeDialog(); S.ui.onlyMissing = false; S.ui.focusKey = el.dataset.item; render(); },
  submit: () => {
    const re = M.openReturns(S.state, S.ui.dept).length > 0;
    const r = M.submit(S.state, S.ui.dept);
    closeDialog();
    if (!r.ok) return toast(r.blockers.join('。'));
    commit(re ? '再提出' : '提出');
    toast(re ? '再提出しました。差戻しは解消済みになりました' : '提出しました');
    window.scrollTo(0, 0);
  },
  withdraw: () => { if (M.withdraw(S.state, S.ui.dept)) commit('提出を取り消す'); },
  print: () => { log('回答一覧を印刷'); persist(); window.print(); },
  'close-dialog': () => closeDialog(),
  'download-log': () => download(new Blob([`﻿${M.logCsv(S.state)}`], { type: 'text/csv' }), 'operation-log.csv'),
  reset: () => {
    openDialog('最初からやり直す', '<p>登録した原票・割当て・回答・差戻しの記録を、このブラウザからすべて消します。</p>',
      '<button type="button" data-act="close-dialog">やめる</button><button type="button" class="danger" data-act="reset-ok">消してやり直す</button>');
  },
  'reset-ok': () => { reset(); closeDialog(); render(); toast('最初の状態に戻しました'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], button[data-role]');
  if (!el || el.disabled) return;
  if (el.dataset.role) return actions.role(el);
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); Promise.resolve(fn(el)).catch((err) => { console.error(err); toast(`エラー：${err.message}`); }); }
});

// ---- 入力（全体を描き直さずに保存し、表示だけ更新する） ------------------------
let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}
function refreshField(key) {
  const dept = S.ui.dept;
  const it = S.state.items[key];
  const p = M.parsed(S.state, it, dept);
  app.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((el) => {
    el.toggleAttribute('aria-invalid', p.state === 'error');
    el.closest('td')?.classList.toggle('err', p.state === 'error');
    if (el.dataset.table) el.title = p.state === 'error' ? p.error : `${it.sheet} ${it.cell}`;
  });
  const f = app.querySelector(`.field[data-field="${CSS.escape(key)}"]`);
  if (f) {
    f.querySelector('.msg').textContent = p.state === 'error' ? p.error : '';
    f.querySelector('.status-slot').innerHTML = p.state === 'error' ? '<span class="mark err">⚠ 誤り</span>'
      : p.state === 'ok' || p.state === 'na' ? '<span class="mark ok">✔ 入力済み</span>'
        : it.optional ? '<span class="mark opt">任意</span>' : '<span class="mark todo">● 未入力</span>';
  }
  const dc = document.getElementById('done-count');
  if (dc) dc.textContent = M.progress(S.state, dept).done;
}
const NA_WORDS = new Set(['-', '－', 'ー', '―', '該当なし']);
function setFromInput(el) {
  const key = el.dataset.key;
  if (el.dataset.table && NA_WORDS.has(el.value.trim())) M.setNA(S.state, key, S.ui.dept, true);
  else M.setAnswer(S.state, key, S.ui.dept, el.value);
  refreshField(key);
}
function wasEmpty(key) {
  return M.parsed(S.state, S.state.items[key], S.ui.dept).state === 'empty';
}

app.addEventListener('input', (e) => {
  const el = e.target;
  if (S.ui.role === 'answer' && el.dataset.key) {
    const first = wasEmpty(el.dataset.key) && el.value !== '';
    setFromInput(el);
    if (first) log(`入力 ${el.dataset.key}`);
    saveSoon();
  } else if (el.dataset.reply) {
    M.replyReturn(S.state, el.dataset.reply, el.value);
    saveSoon();
  }
});

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.na) {
    M.setNA(S.state, el.dataset.na, S.ui.dept, el.checked);
    return commit(`該当なし ${el.checked ? 'ON' : 'OFF'} ${el.dataset.na}`);
  }
  if (S.ui.role === 'answer' && el.dataset.key && el.tagName === 'SELECT') { setFromInput(el); log(`選択 ${el.dataset.key}`); return saveSoon(); }
  if (el.id === 'only-missing') { S.ui.onlyMissing = el.checked; return render(); }
  if (el.id === 'filter') { S.ui.filter = el.value; return render(); }
  if (el.id === 'deadline') { S.state.inquiry.deadline = el.value; return commit('庁内締切を設定'); }
  if (el.id === 'na-text') { S.state.inquiry.naAsText = el.checked; S.ui.output = null; return commit('該当なしの書き方を変更'); }
  if (el.id === 'file' && el.files[0]) return readFile(el.files[0]);
  if (el.dataset.edit) {
    const [key] = selectedKeys();
    const it = S.state.items[key];
    if (!it) return;
    it[el.dataset.edit] = el.value;
    log(`見出し・型を修正 ${key}`);
    persist();
    return toast('直しました');
  }
});

app.addEventListener('keydown', (e) => {
  const el = e.target;
  if (el.id === 'range-input' && e.key === 'Enter') { e.preventDefault(); selectByText(el.value); return; }
  if (el.dataset.table && e.key === 'Enter') {
    e.preventDefault();
    const tbl = el.closest('table');
    const next = tbl.querySelector(`input[data-r="${+el.dataset.r + (e.shiftKey ? -1 : 1)}"][data-c="${el.dataset.c}"]`);
    next?.focus();
    next?.select();
  }
});

// 表への貼り付け：Excelからコピーした範囲（タブ区切り・改行区切り）を、選んだ欄から右下へ流し込む
app.addEventListener('paste', (e) => {
  const el = e.target;
  if (!el.dataset?.table) return;
  const text = e.clipboardData.getData('text/plain');
  if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
  e.preventDefault();
  const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((r) => r.split('\t'));
  const tbl = el.closest('table');
  let n = 0;
  rows.forEach((cells, i) => cells.forEach((v, j) => {
    const target = tbl.querySelector(`input[data-r="${+el.dataset.r + i}"][data-c="${+el.dataset.c + j}"]`);
    if (!target || target.disabled) return;
    target.value = v.trim();
    setFromInput(target);
    n++;
  }));
  log(`表に貼り付け ${n}欄`);
  saveSoon();
  toast(`${n}欄に貼り付けました`);
});

dlg.addEventListener('close', () => { dlg.innerHTML = ''; });

// ---- ファイル ---------------------------------------------------------------
async function readFile(file) {
  if (file.size > MAX_BYTES) {
    S.ui.registerError = [`ファイルが大きすぎます（${Math.round(file.size / 1024)}KB）。このPoCは3MBまでです`];
    return render();
  }
  register(new Uint8Array(await file.arrayBuffer()), file.name, file.name.replace(/\.xlsx$/i, ''));
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* 手でコピーしてもらう */ }
  ta.remove();
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportXlsx() {
  const plan = M.outputPlan(S.state);
  const orig = sourceBytes();
  if (S.ui.output?.url) URL.revokeObjectURL(S.ui.output.url);
  const r = patch(orig, plan.writes, zip);
  const out = { ok: r.ok, errors: r.errors, at: Date.now() };
  if (r.ok) {
    out.verify = verifyWriteBack(orig, r.bytes, plan.writes, zip);
    if (out.verify.ok) {
      // 日本語のファイル名は、検証に使った Chromium で「download」（拡張子なし）に置き換わったため英数字にする
      const base = S.state.inquiry.sourceName.replace(/\.xlsx$/i, '');
      out.name = `${/^[\w.-]+$/.test(base) ? base : 'inquiry'}_preview.xlsx`;
      out.url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    }
  }
  S.ui.output = out;
  commit(`確認用Excelを出力（${plan.writes.length}セル、照合 ${out.verify?.ok ? 'OK' : 'NG'}）`);
}

// ---- 起動 -----------------------------------------------------------------
if (load() && S.state.inquiry) layout();
if (location.hash === '#answer') S.ui.role = 'answer';
window.addEventListener('hashchange', () => { if (location.hash === '#answer') { S.ui.role = 'answer'; render(); } });
render();
document.body.dataset.ready = 'true';
// 自動テスト用に状態を見せる（画面の操作には使わない）
window.__poc = { S, M };
