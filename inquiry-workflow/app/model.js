// 庁内照会PoC の業務ロジック（画面に依存しない。Node のテストからも使う）。
// 状態はすべて JSON にできる普通のオブジェクトで、関数はそれを直接書き換える。

export const COORDINATOR = 'dx';
export const DEPTS = [
  { id: 'dx', name: 'デジタル推進課', short: '自課' },
  { id: 'shimin', name: '市民課', short: '市民' },
  { id: 'zeimu', name: '税務課', short: '税務' },
  { id: 'fukushi', name: '福祉課', short: '福祉' },
  { id: 'kosodate', name: '子育て支援課', short: '子育て' },
  { id: 'shisetsu', name: '施設管理課', short: '施設' },
];
export const deptName = (id) => DEPTS.find((d) => d.id === id)?.name ?? id;
export const TYPE_LABEL = { text: '文章', number: '数値', percent: '％', date: '日付', choice: '選択' };
export const STATUS = { none: '未着手', draft: '作成中', submitted: '提出済み', returned: '差戻し' };

export const keyOf = (sheet, cell) => `${sheet}!${cell}`;

export function newState() {
  return {
    version: 1,
    inquiry: null, // { title, sourceName, sourceB64, deadline, opened, naAsText }
    items: {}, // key → 項目
    answers: {}, // key → { 課id → { raw, na, at } }
    submitted: {}, // 課id → 提出日時
    returns: [], // 差戻しの記録
    finals: {}, // key → 複数課項目の確定値 { raw, na, by }
    edits: [], // とりまとめ部署が直接直した記録
    counters: { assignOps: 0 },
    log: [], // 操作の記録（評価用）
  };
}

/** 原票を登録する。descriptions は入力セル候補の一覧（describeCell の結果＋reasons）。 */
export function registerSource(state, { title, sourceName, sourceB64, descriptions }) {
  Object.assign(state, newState(), {
    inquiry: { title, sourceName, sourceB64, deadline: '', opened: false, naAsText: true },
  });
  for (const d of descriptions) addItem(state, d);
  return state;
}

export function addItem(state, d) {
  const key = keyOf(d.sheet, d.cell);
  state.items[key] = {
    key, sheet: d.sheet, cell: d.cell, col: d.col, row: d.row,
    label: d.label, rowLabel: d.rowLabel, colLabel: d.colLabel,
    type: d.type, options: d.options ?? null, rule: d.rule ?? null,
    reasons: d.reasons ?? [], note: '', optional: false, depts: [],
  };
  return state.items[key];
}

export const itemList = (state) => Object.values(state.items).sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row || a.col - b.col);
/** 未割当ての項目は、とりまとめ部署（自課）が回答する。 */
export const ownersOf = (item) => (item.depts.length ? item.depts : [COORDINATOR]);
export const isMulti = (item) => item.depts.length > 1;
export const itemsOf = (state, dept) => itemList(state).filter((it) => ownersOf(it).includes(dept));

// ---- 割当て ------------------------------------------------------------
/** 項目をまとめて課に割り当てる（1回の操作として数える）。depts が空なら未割当てに戻す。 */
export function assign(state, keys, depts) {
  const hit = keys.filter((k) => state.items[k]);
  if (!hit.length) return 0;
  for (const k of hit) state.items[k].depts = [...new Set(depts)];
  state.counters.assignOps++;
  return hit.length;
}
export function removeItems(state, keys) {
  for (const k of keys) {
    delete state.items[k];
    delete state.answers[k];
    delete state.finals[k];
  }
}
/**
 * 表示されているシート以外（非表示・存在しないシート）にある項目を、対象から外す。
 * 非表示シートの対応前に登録した状態（ブラウザに保存済み）を読み込んだときに使う。
 * 項目に結び付いた回答・確定値・差戻し・修正の記録も一緒に外す。外した項目数を返す。
 */
export function removeItemsOutsideSheets(state, visibleSheetNames) {
  const visible = new Set(visibleSheetNames);
  const keys = Object.values(state.items).filter((it) => !visible.has(it.sheet)).map((it) => it.key);
  if (!keys.length) return 0;
  removeItems(state, keys);
  const gone = new Set(keys);
  state.returns = state.returns.filter((r) => !gone.has(r.key));
  state.edits = state.edits.filter((e) => !gone.has(e.key));
  return keys.length;
}
export function setOptional(state, keys, optional) {
  for (const k of keys) if (state.items[k]) state.items[k].optional = optional;
}

// ---- 回答 --------------------------------------------------------------
const toHalf = (s) => s.replace(/[０-９．－＋，]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/ー/g, '-');

/**
 * 入力された文字列を、項目の型に合わせて解釈する。
 * @returns {{state:'empty'|'na'|'ok'|'error', value?:any, error?:string}}
 *   value は 数値／'YYYY-MM-DD'／文字列。％は画面の値（12.5）のまま持ち、書き出すときに 0.125 にする
 */
export function parseAnswer(item, a) {
  if (!a) return { state: 'empty' };
  if (a.na) return { state: 'na' };
  const raw = String(a.raw ?? '');
  if (raw.trim() === '') return { state: 'empty' };
  if (item.type === 'number' || item.type === 'percent') {
    const t = toHalf(raw.trim()).replace(/,/g, '').replace(/%$/, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return { state: 'error', error: '数値で入力してください' };
    const n = Number(t);
    const r = item.rule;
    if (r?.integer && !Number.isInteger(n)) return { state: 'error', error: '整数で入力してください（原票の入力規則）' };
    if (r) {
      const ok = { greaterThanOrEqual: n >= r.bound, greaterThan: n > r.bound, lessThanOrEqual: n <= r.bound, lessThan: n < r.bound, equal: n === r.bound, notEqual: n !== r.bound }[r.operator];
      if (ok === false) return { state: 'error', error: `原票の入力規則に合いません（基準値 ${r.bound}）` };
    }
    return { state: 'ok', value: n };
  }
  if (item.type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
    const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 1901) return { state: 'error', error: '日付を正しく入力してください' };
    return { state: 'ok', value: raw.trim() };
  }
  if (item.type === 'choice') {
    if (!item.options?.includes(raw)) return { state: 'error', error: '選択肢から選んでください' };
    return { state: 'ok', value: raw };
  }
  return { state: 'ok', value: raw.replace(/\r\n?/g, '\n') };
}

export const answerOf = (state, key, dept) => state.answers[key]?.[dept] ?? null;
export const parsed = (state, item, dept) => parseAnswer(item, answerOf(state, item.key, dept));

export function setAnswer(state, key, dept, raw, now = Date.now()) {
  (state.answers[key] ??= {})[dept] = { raw: String(raw ?? ''), na: false, at: now };
}
export function setNA(state, key, dept, na, now = Date.now()) {
  const cur = answerOf(state, key, dept);
  (state.answers[key] ??= {})[dept] = { raw: na ? '' : cur?.raw ?? '', na, at: now };
}

/** 課の進み具合。必須項目のうち入力済みの数、誤りのある項目、任意で空欄の数。 */
export function progress(state, dept) {
  const items = itemsOf(state, dept);
  const r = { total: items.length, required: 0, done: 0, missing: [], errors: [], optionalEmpty: 0 };
  for (const it of items) {
    const p = parsed(state, it, dept);
    if (p.state === 'error') r.errors.push(it);
    if (it.optional) {
      if (p.state === 'empty') r.optionalEmpty++;
      continue;
    }
    r.required++;
    if (p.state === 'ok' || p.state === 'na') r.done++;
    else if (p.state === 'empty') r.missing.push(it);
  }
  return r;
}

// ---- 差戻し ------------------------------------------------------------
export const openReturns = (state, dept) => state.returns.filter((r) => !r.resolved && (!dept || r.dept === dept));
const snapshot = (state, key, dept) => {
  const a = answerOf(state, key, dept);
  return a ? (a.na ? '（該当なし）' : a.raw) : '';
};

/** とりまとめ部署が、ある課のある項目を差し戻す。 */
export function returnItem(state, key, dept, reason, now = Date.now()) {
  const rec = { id: `r${state.returns.length + 1}`, key, dept, reason: String(reason).trim(), at: now, resolved: false, resolvedAt: null, reply: '', before: snapshot(state, key, dept), after: null };
  state.returns.push(rec);
  return rec;
}
export function replyReturn(state, id, text) {
  const r = state.returns.find((x) => x.id === id);
  if (r && !r.resolved) r.reply = String(text);
}
/** 未解消の差戻しのうち、まだ対応していないもの（値も変えず、返答も書いていない）。 */
export const unhandledReturns = (state, dept) => openReturns(state, dept).filter((r) => snapshot(state, r.key, dept) === r.before && !r.reply.trim());

// ---- 提出 --------------------------------------------------------------
export function deptStatus(state, dept) {
  if (openReturns(state, dept).length) return 'returned';
  if (state.submitted[dept]) return 'submitted';
  return itemsOf(state, dept).some((it) => parsed(state, it, dept).state !== 'empty') ? 'draft' : 'none';
}

/** 提出できない理由の一覧（空なら提出できる）。 */
export function submitBlockers(state, dept) {
  const p = progress(state, dept);
  const out = [];
  if (!p.total) out.push('担当の項目がありません');
  if (p.missing.length) out.push(`未入力の項目が ${p.missing.length} 件あります`);
  if (p.errors.length) out.push(`入力に誤りのある項目が ${p.errors.length} 件あります`);
  const un = unhandledReturns(state, dept);
  if (un.length) out.push(`差戻しに未対応の項目が ${un.length} 件あります（値を直すか、直さない理由を返答してください）`);
  return out;
}

/** 提出（再提出）。未解消の差戻しは、この時点で解消済みになる。記録は消さない。 */
export function submit(state, dept, now = Date.now()) {
  const blockers = submitBlockers(state, dept);
  if (blockers.length) return { ok: false, blockers };
  for (const r of openReturns(state, dept)) {
    r.resolved = true;
    r.resolvedAt = now;
    r.after = snapshot(state, r.key, dept);
  }
  state.submitted[dept] = now;
  return { ok: true, blockers: [] };
}
export function withdraw(state, dept) {
  if (openReturns(state, dept).length) return false;
  delete state.submitted[dept];
  return true;
}

// ---- とりまとめ部署の確認・集約 ------------------------------------------
/** とりまとめ部署が軽微な誤りを自分で直す。差戻しの記録は作らず、誰がいつ直したかを残す。 */
export function coordinatorEdit(state, key, dept, raw, now = Date.now()) {
  state.edits.push({ key, dept, before: snapshot(state, key, dept), after: String(raw), at: now });
  setAnswer(state, key, dept, raw, now);
}

/** 複数課項目のまとめ方の候補。数値は合計、文章は「【課名】回答」を改行でつないだもの。 */
export function mergeSuggestion(state, item) {
  const parts = ownersOf(item).map((d) => ({ dept: d, p: parsed(state, item, d) })).filter((x) => x.p.state === 'ok');
  if (!parts.length) return null;
  if (item.type === 'number' || item.type === 'percent') {
    const sum = parts.reduce((s, x) => s + x.p.value, 0);
    return { by: 'sum', raw: String(Math.round(sum * 1e9) / 1e9), label: `合計 ${parts.map((x) => x.p.value).join('＋')}` };
  }
  if (item.type === 'text') return { by: 'concat', raw: parts.map((x) => `【${deptName(x.dept)}】${x.p.value}`).join('\n'), label: '各課の回答を連結' };
  return null;
}
// 複数課項目の確定値は、確定した時点の各課の回答と結び付けて記録する。
// あとで回答が変わったり、提出が取り消されたり、差戻し中になったりしたら、確定値は使わない（再確認・再確定が必要）。
const answerSig = (state, key, dept) => {
  const a = answerOf(state, key, dept);
  return a ? `${a.na ? 'na' : 'v'}:${a.raw}` : '';
};
/** 項目の担当課がすべて「提出済み」（差戻し中ではない）か。 */
export const allOwnersSubmitted = (state, item) => ownersOf(item).every((d) => deptStatus(state, d) === 'submitted');

/**
 * 複数課項目の確定値の状態。
 * none＝未設定／waiting＝未提出・差戻し中の課がある／stale＝確定後に回答が変わった／ok＝そのまま使える
 */
export function finalStatus(state, item) {
  const f = state.finals[item.key];
  if (!f) return 'none';
  if (!allOwnersSubmitted(state, item)) return 'waiting';
  return ownersOf(item).every((d) => f.basis?.[d] === answerSig(state, item.key, d)) ? 'ok' : 'stale';
}
export const FINAL_WHY = {
  none: '複数課の回答をまとめた確定値が未設定',
  waiting: '未提出または差戻し中の課があるため、確定値を使えません',
  stale: '確定した後に回答が変わったため、再確認・再確定が必要',
};

/** 確定値を記録する。担当課がすべて提出済みのときだけ確定できる。 */
export function setFinal(state, key, raw, by = 'manual', now = Date.now()) {
  const item = state.items[key];
  if (!allOwnersSubmitted(state, item)) return { ok: false, reason: 'すべての担当課が提出してから確定してください' };
  const basis = Object.fromEntries(ownersOf(item).map((d) => [d, answerSig(state, key, d)]));
  state.finals[key] = { raw: String(raw), na: false, by, at: now, basis };
  return { ok: true };
}
export const clearFinal = (state, key) => delete state.finals[key];

/**
 * 確認用Excel（ドラフト）に何を書くかの計画。
 * - 書くのは、提出済みの課の回答と、とりまとめ部署が確定した複数課項目だけ
 * - 書かない項目は pending に理由を付けて返す（原票のセルはそのまま残る）
 * @returns {{writes:object[], rows:object[], pending:object[], cautions:object[], skippedOptional:number}}
 */
export function outputPlan(state) {
  const plan = { writes: [], rows: [], pending: [], cautions: [], skippedOptional: 0 };
  for (const it of itemList(state)) {
    let p;
    let source;
    if (isMulti(it)) {
      const fs = finalStatus(state, it);
      if (fs !== 'ok') { plan.pending.push({ item: it, why: FINAL_WHY[fs] }); continue; }
      p = parseAnswer(it, state.finals[it.key]);
      source = `確定値（${it.depts.map(deptName).join('・')}）`;
    } else {
      const d = ownersOf(it)[0];
      p = parsed(state, it, d);
      source = deptName(d);
      if (!state.submitted[d]) {
        if (it.optional && p.state === 'empty') plan.skippedOptional++;
        else plan.pending.push({ item: it, why: `${deptName(d)}が未提出` });
        continue;
      }
      if (openReturns(state, d).some((r) => r.key === it.key)) plan.cautions.push({ item: it, why: '差戻し中（未解消）のまま書き込みます' });
    }
    if (p.state === 'empty') {
      if (it.optional) plan.skippedOptional++;
      else plan.pending.push({ item: it, why: '未回答' });
      continue;
    }
    if (p.state === 'error') { plan.pending.push({ item: it, why: `入力に誤り（${p.error}）` }); continue; }
    const w = { sheet: it.sheet, cell: it.cell };
    let shown;
    if (p.state === 'na') {
      const asText = it.type === 'text' && state.inquiry.naAsText;
      Object.assign(w, asText ? { type: 'text', value: '該当なし' } : { type: 'blank' });
      shown = asText ? '該当なし' : '（空欄：該当なし）';
    } else if (it.type === 'number') {
      Object.assign(w, { type: 'number', value: p.value });
      shown = String(p.value);
    } else if (it.type === 'percent') {
      Object.assign(w, { type: 'number', value: Math.round(p.value * 1e10) / 1e12 });
      shown = `${p.value}％`;
    } else if (it.type === 'date') {
      Object.assign(w, { type: 'date', value: p.value });
      shown = p.value;
    } else {
      Object.assign(w, { type: 'text', value: p.value });
      shown = p.value;
    }
    plan.writes.push(w);
    plan.rows.push({ item: it, shown, source });
  }
  return plan;
}

// ---- 連絡文（ツールは送信しない。文面のコピーを試すためのデモ専用） ---------
// このPoCは1台・同一ブラウザの localStorage だけで動く。別端末では回答内容を共有できないので、
// コピーした文面は実際の依頼・催促・差戻しには使えない。冒頭にそれが読み取れる見出しを必ず付ける。
export const DEMO_HEADING = '【デモ専用・実際の依頼として送付禁止】';
export const DEMO_NOTICE = [
  DEMO_HEADING,
  'この文面は、PoC（試作）の画面で作った見本です。実際の依頼・催促・差戻しには使えません。',
  'このPoCは1台の端末・同じブラウザの中だけで動き、別の端末でリンクを開いても回答内容は共有されません。',
  '',
];
const fmtDate = (iso) => (iso ? iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${y}年${+m}月${+d}日`) : '（未設定）');

export function requestText(state, url) {
  const lines = DEPTS.filter((d) => d.id !== COORDINATOR && itemsOf(state, d.id).length).map((d) => `・${d.name}：${itemsOf(state, d.id).length}項目`);
  return [
    ...DEMO_NOTICE,
    '関係各課 御中',
    '',
    `「${state.inquiry.title}」への回答をお願いします。`,
    `庁内締切：${fmtDate(state.inquiry.deadline)}`,
    '',
    '下のリンクを開き、所属課を選んで回答してください。',
    'Excelファイルの配布・返信はありません。入力は、このブラウザの中に自動で保存されます。',
    url,
    '',
    '担当項目数',
    ...lines,
    '',
    `問合せ先：${deptName(COORDINATOR)}`,
  ].join('\n');
}

export function reminderText(state, url) {
  // 催促するのは未着手・作成中の課だけ（差戻し中の課は提出済みで、差戻しの連絡文で知らせる）
  const late = DEPTS.filter((d) => d.id !== COORDINATOR && itemsOf(state, d.id).length && ['none', 'draft'].includes(deptStatus(state, d.id)));
  return {
    depts: late,
    text: [
      ...DEMO_NOTICE,
      `${late.map((d) => d.name).join('、')} 御中`,
      '',
      `「${state.inquiry.title}」の回答がまだ提出されていません。`,
      `庁内締切：${fmtDate(state.inquiry.deadline)}`,
      ...late.map((d) => `・${d.name}：${STATUS[deptStatus(state, d.id)]}（入力済み ${progress(state, d.id).done} / ${progress(state, d.id).required}）`),
      '',
      '下のリンクから回答・提出をお願いします。',
      url,
      '',
      `問合せ先：${deptName(COORDINATOR)}`,
    ].join('\n'),
  };
}

export function returnText(state, dept, url) {
  const recs = openReturns(state, dept);
  return [
    ...DEMO_NOTICE,
    `${deptName(dept)} 御中`,
    '',
    `「${state.inquiry.title}」の回答について、${recs.length}件の確認をお願いします。`,
    ...recs.map((r) => `・${state.items[r.key]?.label ?? r.key}：${r.reason}`),
    '',
    '下のリンクを開くと、該当の項目が一番上に表示されます。修正のうえ再提出してください。',
    url,
    '',
    `問合せ先：${deptName(COORDINATOR)}`,
  ].join('\n');
}

/** 操作の記録（評価のときに操作回数・時刻を数えるため）。 */
export function logAction(state, role, action, now = Date.now()) {
  state.log.push({ at: now, role, action });
  if (state.log.length > 2000) state.log.splice(0, state.log.length - 2000);
}
export const logCsv = (state) => ['時刻,役割,操作', ...state.log.map((l) => `${new Date(l.at).toISOString()},${l.role},${l.action}`)].join('\n');
