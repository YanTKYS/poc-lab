// ZIPの展開・圧縮を fflate で行う薄い包み。
// Node では npm の fflate、ブラウザでは同梱した fflate（import map で 'fflate' を解決）を使う。
import { unzipSync, zipSync } from 'fflate';

// 出力を毎回同じバイト列にするため、ZIP内の更新日時を固定する
const FIXED_MTIME = new Date(2026, 0, 1, 0, 0, 0);

export const fflateZip = {
  /** @returns {Record<string, Uint8Array>} 名前→中身（ZIP内の並び順を保つ） */
  unzip: (bytes) => unzipSync(bytes),
  zip: (files) => zipSync(files, { level: 6, mtime: FIXED_MTIME }),
};
