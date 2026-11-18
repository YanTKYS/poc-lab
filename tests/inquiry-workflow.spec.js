// 庁内照会PoC：割当て→回答→提出→差戻し→修正→集約→確認用Excel（ドラフト）出力を、画面の操作で一通り通す。
import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strToU8, strFromU8 } from 'fflate';
import { readWorkbook } from '../inquiry-workflow/src/ooxml.mjs';
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

test('一連の操作：割当て→回答→提出→差戻し→再提出→集約→確認用Excel', async ({ page }) => {
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
  expect(req.split('\n')[0]).toBe('【デモ専用・実際の依頼として送付禁止】');
  expect(req).toContain('別の端末でリンクを開いても回答内容は共有されません');
  await expect(page.getByText('この文面は実際の依頼には使えません。')).toBeVisible();
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

  // ---- 7. 確認用Excel（ドラフト）：出力前確認 → 出力 → 自動照合 ----
  await tab(page, '④ 確認用Excel');
  await expect(page.getByTestId('demo-notice')).toContainText('デモの確認用ファイルです。正式提出には使用しないでください。');
  await expect(page.getByTestId('demo-notice')).toContainText('提出先での受理は未確認');
  await expect(page.getByTestId('plan-pending')).toHaveText('0');
  const writes = await page.evaluate(() => window.__poc.M.outputPlan(window.__poc.S.state).writes);
  await expect(page.getByTestId('plan-writes')).toHaveText(String(writes.length));
  await expect(page.getByTestId('plan-summary')).toContainText(`書き込む ${writes.length}件／書き込まない 0件`);
  await page.getByRole('button', { name: '確認用Excelを出力する' }).click();
  await expect(page.getByTestId('export-result')).toContainText('問題なし');
  await expect(page.getByTestId('result-notice')).toContainText('デモの確認用ファイルです。正式提出には使用しないでください。');
  await expect(page.getByTestId('result-notice')).toContainText('Microsoft Excel実機での開封・再計算・保存、および提出先での受理は未確認');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  expect(dl.suggestedFilename()).toBe('genpyo_preview.xlsx');
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

test('未提出・未回答が残っていても確認用Excelを出力でき、件数と注意が表示される', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await tab(page, '② 依頼');
  await page.getByRole('button', { name: '回答の受付を始める' }).click();
  // 自課（デジタル推進課）の6項目だけ回答・提出し、ほかの課は未提出のままにする
  await page.evaluate(() => {
    const { S, M } = window.__poc;
    for (const it of M.itemsOf(S.state, 'dx')) M.setAnswer(S.state, it.key, 'dx', it.type === 'date' ? '2026-11-27' : '架空');
    M.submit(S.state, 'dx');
  });
  await tab(page, '④ 確認用Excel');
  await expect(page.getByTestId('plan-writes')).toHaveText('6');
  // 全62項目＝書き込む6＋書き込まない45＋任意で空欄11
  await expect(page.getByTestId('plan-pending')).toHaveText('45');
  await expect(page.getByTestId('plan-summary')).toContainText('書き込む 6件／書き込まない 45件（未提出・未回答・未確定など）／注意 0件');
  await expect(page.getByTestId('plan-summary')).toContainText('任意項目で空欄の 11件は、別に数えています');
  await expect(page.getByTestId('plan-summary')).toContainText('「書き込まない項目」と「注意」を確認してください');
  await page.getByRole('button', { name: '確認用Excelを出力する' }).click(); // 未提出があっても出力できる
  await expect(page.getByTestId('export-result')).toContainText('問題なし');
  await expect(page.getByTestId('result-notice')).toContainText('正式提出には使用しないでください');
});

test('フッターに、操作の記録は評価用であり回答データの復元・引継ぎには使えない旨を表示する', async ({ page }) => {
  await open(page);
  await expect(page.locator('#log-note')).toContainText('評価用の操作ログです。回答データの書き出し・復元・部署間の引継ぎには使えません');
});

// ---- コピーの成否（Issue #20）：クリップボードに入ったときだけ成功と表示・記録する ----
const copiedLogs = (page) => page.evaluate(() => window.__poc.S.state.log.filter((l) => l.action.endsWith('をコピー')).map((l) => l.action));

async function openRequestScreen(page) {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await tab(page, '② 依頼');
  await page.getByRole('button', { name: '回答の受付を始める' }).click();
}

test('コピー成功：成功のメッセージを出し、「コピーした」記録を残す。クリップボードAPIが拒否されても旧方式で入れば成功', async ({ page }) => {
  await openRequestScreen(page);
  // Clipboard API が成功する場合
  await page.evaluate(() => { window.__copied = null; navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.getByRole('button', { name: '依頼文をコピー' }).click();
  await expect(page.locator('#toast')).toContainText('コピーしました（デモ専用の文面です');
  expect((await page.evaluate(() => window.__copied)).split('\n')[0]).toBe('【デモ専用・実際の依頼として送付禁止】');
  expect(await copiedLogs(page)).toEqual(['依頼文をコピー']);
  // Clipboard API は拒否されるが、旧方式（execCommand）で入る場合も成功
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    document.execCommand = (cmd) => cmd === 'copy';
  });
  await page.getByRole('button', { name: '依頼文をコピー' }).click();
  await expect(page.locator('#toast')).toContainText('コピーしました');
  await expect(page.locator('dialog')).toBeHidden();
  expect(await copiedLogs(page)).toEqual(['依頼文をコピー', '依頼文をコピー']);
});

test('コピー失敗：成功と表示せず記録も残さず、文面を表示して手動コピーを案内する（依頼・催促・差戻しの3種類）', async ({ page }) => {
  await openRequestScreen(page);
  // 両方の方式が失敗する
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    document.execCommand = () => false;
  });
  const failed = async (button, firstLines) => {
    await button.click();
    await expect(page.locator('dialog')).toContainText('コピーできませんでした');
    await expect(page.locator('dialog')).toContainText('手動で選択してコピーしてください');
    await expect(page.locator('#toast')).not.toContainText('コピーしました');
    const shown = await page.locator('#manual-copy').inputValue();
    expect(shown.split('\n')[0]).toBe('【デモ専用・実際の依頼として送付禁止】');
    expect(shown).toContain(firstLines);
    await page.getByRole('button', { name: '閉じる' }).last().click();
    await expect(page.locator('dialog')).toBeHidden();
  };
  await failed(page.getByRole('button', { name: '依頼文をコピー' }), '関係各課 御中');
  // 催促文（進捗画面。文面が画面に出ていないので、失敗時に表示される）
  await tab(page, '③ 進捗・集約');
  await failed(page.getByRole('button', { name: /催促文をコピー/ }), '回答がまだ提出されていません');
  // 差戻しの連絡文：施設管理課まで提出させ、1項目を差し戻す
  await page.evaluate(() => {
    const { S, M } = window.__poc;
    for (const it of M.itemsOf(S.state, 'shisetsu')) M.setAnswer(S.state, it.key, 'shisetsu', it.type === 'text' ? '架空' : '1');
    M.submit(S.state, 'shisetsu');
    M.returnItem(S.state, '施設別実績!C5', 'shisetsu', '確認してください');
  });
  await tab(page, '② 依頼');
  await tab(page, '③ 進捗・集約');
  await failed(page.getByRole('button', { name: /差戻しの連絡文をコピー/ }), '確認してください');
  expect(await copiedLogs(page)).toEqual([]); // 失敗したコピーは1件も記録しない
});

// ---- デモ割当てのログ（Issue #20）：入力セル数・範囲数・人の操作回数を混同しない ----
test('デモ割当てのログは「56セル・9範囲」と記録し、「56操作」とは書かない', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click();
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await expect(page.getByTestId('assign-ops')).toHaveText('9'); // 割当て処理（回）
  const actions = await page.evaluate(() => window.__poc.S.state.log.map((l) => l.action));
  expect(actions.at(-1)).toBe('例の割当てを適用（56セル・9範囲）');
  expect(actions.join('\n')).not.toContain('56操作');
});

// ---- 非表示シート（Issue #22）：回答・割当ての対象にせず、確認用Excelには元のまま残す ----
/** 架空の原票の workbook.xml の <sheet state> だけを書き換えた .xlsx を作る（検証用の一時的なXML変更）。 */
async function workbookWithStates(states) {
  const files = zip.unzip(new Uint8Array(await readFile(new URL('../inquiry-workflow/fixtures/genpyo.xlsx', import.meta.url))));
  let wb = strFromU8(files['xl/workbook.xml']);
  for (const [name, state] of Object.entries(states)) {
    const tag = new RegExp(`<sheet\\b[^>]*\\bname="${name}"[^>]*>`).exec(wb)[0];
    wb = wb.replace(tag, tag.replace(/\sstate="[^"]*"/, '').replace(/(\sr:id=)/, ` state="${state}"$1`));
  }
  files['xl/workbook.xml'] = strToU8(wb);
  return zip.zip(files);
}
const sheetStates = (bytes) => Object.fromEntries(readWorkbook(zip.unzip(bytes)).sheets.map((x) => [x.name, x.state]));

test('非表示シート（hidden・veryHidden）は割当て・回答の対象にならず、出力した確認用Excelに元の状態・内容のまま残る', async ({ page }) => {
  const hiddenBook = await workbookWithStates({ 施設別実績: 'hidden', 記入要領: 'veryHidden' });
  await open(page);
  await page.setInputFiles('#file', { name: 'hidden-demo.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(hiddenBook) });

  // 割当て画面：表示シートだけがタブに出る。対象外のシートが案内される。入力セル候補は 62−32＝30
  await expect(page.locator('.sheet-tabs [role=tab]')).toHaveCount(2);
  await expect(page.locator('.sheet-tabs')).not.toContainText('施設別実績');
  await expect(page.locator('.sheet-tabs')).not.toContainText('記入要領');
  await expect(page.getByTestId('hidden-note')).toContainText('非表示のシートは、回答・割当ての対象にしていません');
  await expect(page.getByTestId('hidden-note')).toContainText('「施設別実績」（非表示）');
  await expect(page.getByTestId('hidden-note')).toContainText('「記入要領」（非表示 veryHidden）');
  await expect(page.locator('.stat-row b').first()).toHaveText('30');
  // 表示シートの入力候補は従来どおり（問7の選択肢は、veryHidden にした記入要領のセルを参照している）
  await page.getByRole('tab', { name: /取組状況/ }).click();
  await expect(page.locator('#assign-grid td[data-ref=C11] .chip')).toBeVisible();

  // 回答画面：非表示シートの項目は出ない。veryHidden のシートにある選択肢は使える
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '例の割当てを適用する' }).click();
  await tab(page, '② 依頼');
  await page.getByRole('button', { name: '回答の受付を始める' }).click();
  await pickDept(page, '福祉課');
  await expect(page.locator('.sheet-sec h2')).toHaveText(['取組状況']);
  await expect(page.locator('table.tbl-in')).toHaveCount(0);
  await expect(field(page, '取組状況!C11').locator('option')).toHaveText(['選んでください', '実施済み', '実施予定', '未実施']);

  // 残りをデモ用ショートカットで提出済みにし、複数課項目を確定して出力
  await role(page, 'とりまとめ部署');
  await tab(page, '③ 進捗・集約');
  await page.locator('summary', { hasText: 'デモ用ショートカット' }).click();
  await page.getByRole('button', { name: '回答例を入力して全課を提出済みにする' }).click();
  await expect(page.getByTestId('progress').locator('.badge', { hasText: '提出済み' })).toHaveCount(6); // 回答例の読み込みを待つ
  await page.evaluate(() => {
    const { S, M } = window.__poc;
    for (const key of ['取組状況!C16', '取組状況!C17']) {
      const sug = M.mergeSuggestion(S.state, S.state.items[key]);
      M.setFinal(S.state, key, sug.raw, sug.by);
    }
  });
  await tab(page, '④ 確認用Excel');
  await expect(page.getByTestId('hidden-note')).toContainText('これらのシートも内容・数式・書式・表示状態を変えずに残ります');
  await expect(page.getByTestId('plan-pending')).toHaveText('0');
  const writes = await page.evaluate(() => window.__poc.M.outputPlan(window.__poc.S.state).writes);
  expect(writes.length).toBe(30 - 3); // 任意で空欄の補足3つ（D5〜D15 のうち回答のない欄）は書かない
  expect(writes.every((w) => w.sheet !== '施設別実績')).toBe(true);
  await page.getByRole('button', { name: '確認用Excelを出力する' }).click();
  await expect(page.getByTestId('export-result')).toContainText('問題なし');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  const out = new Uint8Array(await readFile(await dl.path()));

  // 出力：表示状態は元のまま、非表示シートの部品は1バイトも変わらない。ブラウザの出力を Node 側でも照合する
  expect(sheetStates(out)).toEqual({ 記入要領: 'veryHidden', 基本情報: 'visible', 取組状況: 'visible', 施設別実績: 'hidden' });
  const before = zip.unzip(hiddenBook);
  const after = zip.unzip(out);
  const pathOf = (name) => readWorkbook(before).sheets.find((x) => x.name === name).path;
  for (const name of ['施設別実績', '記入要領']) expect(after[pathOf(name)], `${name} が変わった`).toEqual(before[pathOf(name)]);
  expect(verifyWriteBack(hiddenBook, out, writes, zip).problems).toEqual([]);
  expect(readAllCells(after)['取組状況'].get('C5').value).toBe(12);
});

test('すべてのシートが非表示の原票は登録しない', async ({ page }) => {
  const book = await workbookWithStates({ 記入要領: 'hidden', 基本情報: 'hidden', 取組状況: 'veryHidden', 施設別実績: 'hidden' });
  await open(page);
  await page.setInputFiles('#file', { name: 'all-hidden.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(book) });
  await expect(page.locator('#app .alert.error')).toContainText('表示されているシートがありません');
  await expect(page.locator('.tabs')).toHaveCount(0);
});

test('非表示シートの対応前に登録した状態を読み込むと、非表示シートの項目を対象から外す', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '架空の原票を読み込む' }).click(); // 全シート表示で62項目（以前の版と同じ状態）
  await expect(page.locator('.stat-row b').first()).toHaveText('62');
  const hiddenB64 = Buffer.from(await workbookWithStates({ 施設別実績: 'hidden' })).toString('base64');
  // 保存済みの状態の原票だけを「施設別実績が非表示」のものに入れ替える（項目は以前のまま）
  await page.evaluate((b64) => {
    const key = 'inquiry-workflow-poc/v1';
    const st = JSON.parse(localStorage.getItem(key));
    st.inquiry.sourceB64 = b64;
    localStorage.setItem(key, JSON.stringify(st));
  }, hiddenB64);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#toast')).toContainText('非表示シートにあった 32項目を、回答・割当ての対象から外しました');
  await expect(page.locator('.stat-row b').first()).toHaveText('30');
  await expect(page.locator('.sheet-tabs [role=tab]')).toHaveCount(3); // 記入要領・基本情報・取組状況
  await expect(page.locator('.sheet-tabs')).not.toContainText('施設別実績');
});
