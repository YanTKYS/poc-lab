// 画面全体で共有する状態と、保存・原票の読み込み。
import { unzipSync, zipSync } from '../vendor/fflate.js';
import { readLayout } from '../lib/xlsx-layout.js';
import * as M from './model.js';

// ZIPの展開・圧縮（#14 の検証と同じ設定。出力を毎回同じバイト列にするため更新日時を固定）
export const zip = {
  unzip: (bytes) => unzipSync(bytes),
  zip: (files) => zipSync(files, { level: 6, mtime: new Date(2026, 0, 1, 0, 0, 0) }),
};

const STORAGE_KEY = 'inquiry-workflow-poc/v1';

export const S = {
  state: M.newState(),
  layout: null, // 原票から読んだ表示用の情報（保存しない。必要なときに作る）
  ui: {
    role: 'coordinator', // coordinator / answer
    tab: 'assign', // assign / request / progress / output
    sheet: null,
    sel: null, // { sheet, c1, r1, c2, r2 }
    dept: null, // 回答部署の画面で選んでいる課
    filter: 'caution',
    onlyMissing: false,
    focusKey: null,
    output: null, // 直近の出力結果
    savedAt: null,
  },
};

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const st = JSON.parse(raw);
    if (st?.version !== 1) return false;
    S.state = st;
    S.layout = null;
    return true;
  } catch {
    return false;
  }
}

export function save() {
  S.ui.savedAt = new Date();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S.state));
    return true;
  } catch {
    return false; // 保存できなくても、このタブを開いている間は動く
  }
}

export function reset() {
  S.state = M.newState();
  S.layout = null;
  Object.assign(S.ui, { tab: 'assign', sheet: null, sel: null, dept: null, output: null, focusKey: null });
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 何もしない */ }
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const sourceBytes = () => b64ToBytes(S.state.inquiry.sourceB64);

export function layout() {
  if (!S.layout && S.state.inquiry) S.layout = readLayout(zip.unzip(sourceBytes()));
  return S.layout;
}

/** 共通リンク（照会ごとに1本。課別には作らない）。 */
export const answerUrl = () => `${location.href.split('#')[0]}#answer`;
