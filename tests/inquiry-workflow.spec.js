// 庁内照会PoC：割当て→回答→提出→差戻し→修正→集約→提出用Excel出力を、画面の操作で一通り通す。
import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { patch } from '../inquiry-workflow/src/xlsx-patch.mjs';
import { verifyWriteBack, readAllCells } from '../inquiry-workflow/src/xlsx-verify.mjs';
import { fflateZip as zip } from '../inquiry-workflow/src/zip-fflate.mjs';

const ORIGIN = 'http://localhost:4173';
const BASE = `${ORIGIN}/poc-lab/`;

// 外部への通信はブロックして記録し、サブパス外や404の参照も検出する（pele.spec.js と同じ）
const test = base.extend({
  page: async ({ page }, use) => {
    const external = [];
    const failed = [];
    const pageErrors = [];
    await page.route((url) => url.origin !== ORIGIN && !url.protocol.startsWith('blob') && !url.protocol.startsWith('data'), (route) => {
      external.push(route.request().url());
      return route.abort();
    });
    page.on('response', (res) => {
      if (res.url().startsWith(ORIGIN) && (!res.url().startsWith(BASE) || res.status() >= 400)) failed.push(`${res.status()} ${res.url()}`);
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await use(page);
    expect(external, '外部への通信が発生した').toEqual([]);
    expect(failed, 'サブパス外または失敗したリクエストがある').toEqual([]);
    expect(pageErrors, '未捕捉の例外が発生した').toEqual([]);
  },
});

async function open(page) {
  await page.goto('inquiry-workflow/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
}
const tab = (page, name) => page.locator('.tabs button', { hasText: name }).click();
const role = (page, name) => page.locator('button[data-role]', { hasText: name }).click();
async function pickDept(page, name) {
  await role(page, '回答部署');
  const sw = page.getByRole('button', { name: '課を切り替える' });
  if (await sw.isVisible()) await sw.click();
  await page.locator('.dept-pick button', { hasText: name }).click();
}
const field = (page, key) => page.locator(`[data-key="${key}"]`).first();
async function submitDept(page, label = '提出する') {
  await page.locator('[data-act=precheck]').click();
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('.ans-head .badge')).toHaveText('提出済み');
}

test('一連の操作：割当て→回答→提出→差戻し→再提出→集約→提出用Excel', async ({ page }) => {
  await open(page);
  await expect(page.locator('.banner')).toContainText('架空データ専用');

  // ---- 1. 原票の登録と割当て（とりまとめ部署） ----
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await expect(page.locator('.stat-row b').first()).toHaveText('62');
  await page.getByRole('tab', { name: /取組状況/ }).click();
  // ドラッグで C5:D8 を選んで市民課へ（8セルを1操作）
  const from = await page.locator('#assign-grid td[data-ref=C5]').boundingBox();
  const to = await page.locator('#assign-grid td[data-ref=D8]').boundingBox();
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(to.x + 5, to.y + 5, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#sel-panel h2')).toContainText('C5:D8');
  await expect(page.locator('#sel-panel h2')).toContainText('入力セル 8個');
  await page.locator('#sel-panel button', { hasText: '市民課' }).click();
  await expect(page.locator('#assign-grid td[data-ref=C5] .chip')).toHaveText('市民');
  await expect(page.locator('#assign-grid td[data-ref=C19]')).toContainText('数式');
  await expect(page.getByTestId('assign-ops')).toHaveText('1');
  // 番地の入力でも選べる。表型（施設別実績）を範囲ごと施設管理課へ
  await page.getByRole('tab', { name: /施設別実績/ }).click();
  await page.fill('#range-input', 'C5:F9');
  await page.press('#range-input', 'Enter');
  await expect(page.locator('#sel-panel h2')).toContainText('入力セル 20個');
  await page.locator('#sel-panel button', { hasText: '施設管理課' }).click();
  await expect(page.getByTestId('assign-ops')).toHaveText('2');
  // 残りは設計資料の例どおりに（9範囲＝9操作）
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await expect(page.locator('.stat-row div').nth(2).locator('b')).toHaveText('6'); // 未割当て＝基本情報の6（自課）

  // ---- 2. 依頼（通知は送らない。文面をコピーするだけ） ----
  await tab(page, '② 依頼');
  await page.fill('#deadline', '2026-11-27');
  await page.locator('#deadline').dispatchEvent('change');
  await page.getByRole('button', { name: '回答の受付を始める' }).click();
  const req = await page.locator('#request-text').inputValue();
  expect(req).toContain('庁内締切：2026年11月27日');
  expect(req).toContain('/poc-lab/inquiry-workflow/#answer');
  expect(req).toContain('・施設管理課：21項目');

  // ---- 3. 回答部署：市民課（自課の項目だけ。全角数字も受け付ける） ----
  await pickDept(page, '市民課');
  await expect(page.locator('.q')).toHaveCount(6);
  await expect(page.locator('.ans-meter')).toContainText('0 / 6');
  await field(page, '取組状況!C5').fill('１２');
  await field(page, '取組状況!C6').selectOption('導入済み');
  await field(page, '取組状況!C7').selectOption('導入予定');
  await field(page, '取組状況!C8').selectOption('未導入');
  await field(page, '取組状況!C16').fill('abc');
  await expect(page.locator('.field[data-field="取組状況!C16"] .msg')).toHaveText('数値で入力してください');
  await field(page, '取組状況!C16').fill('3');
  await field(page, '取組状況!C17').fill('窓口の混雑。');
  await expect(page.locator('#done-count')).toHaveText('6');
  await submitDept(page);

  // ---- 施設管理課：Excelからの貼り付けで表にまとめて入力 ----
  await pickDept(page, '施設管理課');
  await expect(page.locator('table.tbl-in tbody tr')).toHaveCount(5);
  const tsv = ['12345\t300\t2400\t15800', '5120\t298\t610\t7200', '4870\t301\t0\t6900', '48211\t340\t21050\t32500', '152340\t285\t30455\t41000'].join('\n');
  await page.locator('table.tbl-in input').first().focus();
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, tsv);
  await expect(field(page, '施設別実績!F9')).toHaveValue('41000');
  await field(page, '取組状況!C17').fill('予約システムが施設ごとに異なる。');
  await submitDept(page);

  // ---- 4. 進捗・差戻し（とりまとめ部署） ----
  await role(page, 'とりまとめ部署');
  await tab(page, '③ 進捗・集約');
  const progress = page.getByTestId('progress');
  await expect(progress.locator('tr', { hasText: '市民課' }).locator('.badge')).toHaveText('提出済み');
  await expect(progress.locator('tr', { hasText: '税務課' }).locator('.badge')).toHaveText('未着手');
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '回答例を入力して全課を提出済みにする' }).click();
  await expect(progress.locator('.badge', { hasText: '提出済み' })).toHaveCount(6);

  await page.selectOption('#filter', 'shimin');
  const row = page.getByTestId('review').locator('tr', { hasText: '問2 コンビニ交付の導入状況 ／ 回答' });
  await row.getByRole('button', { name: '差戻し' }).click();
  await page.fill('#return-reason', '開始予定の年度を確認してください');
  await page.getByRole('button', { name: '差し戻す', exact: true }).click();
  await expect(progress.locator('tr', { hasText: '市民課' }).locator('.badge')).toHaveText('差戻し');
  await expect(page.getByRole('button', { name: /差戻しの連絡文をコピー（1件）/ })).toBeVisible();

  // ---- 5. 回答部署で修正・再提出 → 解消し、記録は残る ----
  await pickDept(page, '市民課');
  await expect(page.locator('.returns')).toContainText('開始予定の年度を確認してください');
  await page.locator('[data-act=precheck]').click();
  await expect(page.locator('dialog')).toContainText('差戻しに未対応');
  await page.getByRole('button', { name: '入力に戻る' }).click();
  await page.locator('.returns [data-key="取組状況!C6"]').selectOption('導入予定');
  await submitDept(page, '再提出する');
  await expect(page.locator('.returns')).toHaveCount(0);

  await role(page, 'とりまとめ部署');
  await page.selectOption('#filter', 'caution');
  const review = page.getByTestId('review');
  await expect(review).toContainText('差戻し後に修正あり（導入済み → 導入予定）');
  await expect(progress.locator('tr', { hasText: '市民課' }).locator('.badge')).toHaveText('提出済み');

  // ---- 6. 複数課項目の集約（候補を採用して確定） ----
  const multi16 = review.locator('tr', { hasText: '問12' });
  await multi16.getByRole('button', { name: /合計 3＋2＝5 を採用/ }).click();
  await multi16.getByRole('button', { name: 'この値で確定' }).click();
  const multi17 = page.getByTestId('review').locator('tr', { hasText: '問13' });
  await multi17.getByRole('button', { name: '各課の回答を連結して入れる' }).click();
  await multi17.getByRole('button', { name: 'この値で確定' }).click();
  await expect(page.getByTestId('review')).toHaveCount(1);
  await expect(page.getByTestId('review')).not.toContainText('確定値が未設定');

  // ---- 7. 提出用Excel：出力前確認 → 出力 → 自動照合 ----
  await tab(page, '④ 提出用Excel');
  await expect(page.getByTestId('plan-pending')).toHaveText('0');
  const writes = await page.evaluate(() => window.__poc.M.outputPlan(window.__poc.S.state).writes);
  await expect(page.getByTestId('plan-writes')).toHaveText(String(writes.length));
  await page.getByRole('button', { name: '提出用Excelを出力する' }).click();
  await expect(page.getByTestId('export-result')).toContainText('問題なし');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  expect(dl.suggestedFilename()).toBe('genpyo_submit.xlsx');
  const out = new Uint8Array(await readFile(await dl.path()));

  // ブラウザが出した .xlsx を、Node 側でも照合する（原票は fixtures のもの）
  const orig = new Uint8Array(await readFile(new URL('../inquiry-workflow/fixtures/genpyo.xlsx', import.meta.url)));
  expect(verifyWriteBack(orig, out, writes, zip).problems).toEqual([]);
  expect(out).toEqual(patch(orig, writes, zip).bytes); // Node で同じ計画を書いた結果とバイト一致
  const cells = readAllCells(zip.unzip(out));
  expect(cells['取組状況'].get('C5').value).toBe(12);
  expect(cells['取組状況'].get('C6').value).toBe('導入予定');
  expect(cells['取組状況'].get('C16').value).toBe(5);
  expect(cells['取組状況'].get('C17').value).toMatch(/^【市民課】窓口の混雑。\n/);
  expect(cells['施設別実績'].get('F9').value).toBe(41000);
  expect(cells['施設別実績'].get('C13').formula).toBe('SUM(C5:C12)');
  expect(cells['基本情報'].get('D4').value).toBe('012345');
});

test('対象外のファイルは登録せず、理由を示す', async ({ page }) => {
  await open(page);
  await page.setInputFiles('#file', { name: 'old.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('これはxlsxではない') });
  await expect(page.locator('#app .alert.error')).toContainText('ZIPとして開けません');
  await expect(page.locator('.tabs')).toHaveCount(0);
});

test('入力はブラウザ内に保存され、再読み込みしても続きから始められる', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await tab(page, '② 依頼');
  await page.getByRole('button', { name: '回答の受付を始める' }).click();
  // 共通リンク（#answer）で開くと、回答部署の画面になる
  await page.goto('inquiry-workflow/#answer');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('.dept-pick button', { hasText: '税務課' }).click();
  await field(page, '取組状況!C9').selectOption('導入済み');
  await page.waitForTimeout(500); // 自動保存（0.3秒後）を待つ
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('.dept-pick button', { hasText: '税務課' }).click();
  await expect(field(page, '取組状況!C9')).toHaveValue('導入済み');
  await expect(page.locator('.dept-pick')).toHaveCount(0);
});

test('番地の直接入力は、表示中のシートの範囲内だけ受け付ける', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await page.getByRole('tab', { name: /取組状況/ }).click();
  await page.fill('#range-input', 'A1:XFD1048576');
  await page.press('#range-input', 'Enter');
  await expect(page.locator('#toast')).toContainText('このシートの範囲外です（A1:D19 の中で指定してください）');
  await expect(page.locator('#sel-panel')).toContainText('範囲を選ぶと');
  await page.fill('#range-input', 'C5:D8');
  await page.press('#range-input', 'Enter');
  await expect(page.locator('#sel-panel h2')).toContainText('入力セル 8個');
});

test('ブラウザに保存できないときは「保存済み」と見せず、警告を出す', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await tab(page, '② 依頼');
  await page.getByRole('button', { name: '回答の受付を始める' }).click();
  await expect(page.locator('#save-alert')).toBeHidden();
  // 容量不足を再現する
  await page.evaluate(() => {
    window.__setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new DOMException('容量不足', 'QuotaExceededError'); };
  });
  await pickDept(page, '税務課');
  await field(page, '取組状況!C9').selectOption('導入済み');
  await expect(page.locator('#saved-at')).toHaveText('保存できていません（再読み込みすると入力が失われます）');
  await expect(page.locator('#save-alert')).toBeVisible();
  // 保存できるようになれば、表示も戻る
  await page.evaluate(() => { Storage.prototype.setItem = window.__setItem; });
  await field(page, '取組状況!C10').fill('2025-04-01');
  await expect(page.locator('#saved-at')).toContainText('自動保存済み');
  await expect(page.locator('#save-alert')).toBeHidden();
});
