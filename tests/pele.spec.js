import { test as base, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:4173';
const BASE = `${ORIGIN}/poc-lab/`;
const ENGINES = ['pele', 'mermaid'];
const SAMPLES = ['flowchart-ja', 'sequence', 'class', 'er', 'flowchart-complex'];

// 全テスト共通: 外部への通信はブロックして記録し、サブパス外や404の参照も検出する
const test = base.extend({
  page: async ({ page }, use) => {
    const external = [];
    const failed = [];
    const pageErrors = [];
    await page.route((url) => url.origin !== ORIGIN, (route) => {
      external.push(route.request().url());
      return route.abort();
    });
    page.on('response', (res) => {
      if (res.url().startsWith(ORIGIN) && (!res.url().startsWith(BASE) || res.status() >= 400)) {
        failed.push(`${res.status()} ${res.url()}`);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await use(page);
    expect(external, '外部への通信が発生した').toEqual([]);
    expect(failed, 'サブパス外または失敗したリクエストがある').toEqual([]);
    expect(pageErrors, '未捕捉の例外が発生した').toEqual([]);
  },
});

const pane = (page, engine) => page.locator(`#pane-${engine}`);
const status = (page, engine) => pane(page, engine).locator('[data-field="status"]');
const diagram = (page, engine) => pane(page, engine).locator('[data-field="frame"] > svg');

async function waitIdle(page) {
  await expect(page.locator('body')).toHaveAttribute('data-busy', 'false', { timeout: 30_000 });
}

async function open(page, sample) {
  await page.goto(sample ? `pele/?sample=${sample}` : 'pele/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await waitIdle(page);
}

test('トップページからPele比較ページへ遷移できる（サブパス配信）', async ({ page }) => {
  await page.goto('./');
  const link = page.getByRole('link', { name: /Pele と Mermaid\.js の比較/ });
  await expect(link).toHaveAttribute('href', 'pele/');
  await link.click();
  await expect(page).toHaveURL(`${BASE}pele/`);
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await waitIdle(page);
  await expect(page.locator('#versions')).toContainText('pele 1.13.0 / mermaid 12.1.0');
  await expect(pane(page, 'pele').locator('[data-field="version"]')).toHaveText('v1.13.0');
  await expect(pane(page, 'mermaid').locator('[data-field="version"]')).toHaveText('v12.1.0');
  await page.getByRole('link', { name: 'PoC一覧' }).click();
  await expect(page).toHaveURL(BASE);
});

for (const sample of SAMPLES) {
  test(`サンプル「${sample}」を両エンジンで描画できる`, async ({ page }) => {
    await open(page, sample);
    for (const engine of ENGINES) {
      await expect(status(page, engine)).toHaveText('OK');
      await expect(pane(page, engine).locator('[data-field="error"]')).toBeHidden();
      const box = await diagram(page, engine).boundingBox();
      expect(box.width).toBeGreaterThan(50);
      expect(box.height).toBeGreaterThan(50);
      await expect(pane(page, engine).locator('[data-field="first"]')).toHaveText(/\d ms$/);
      await expect(pane(page, engine).locator('[data-field="last"]')).toHaveText(/\d ms$/);
    }
    await page.locator('.compare').screenshot({ path: test.info().outputPath(`${sample}.png`) });
  });
}

test('サンプルの切替で入力と描画が更新される', async ({ page }) => {
  await open(page, 'flowchart-ja');
  await page.selectOption('#sample', 'er');
  await expect(page.locator('#source')).toHaveValue(/^erDiagram/);
  await waitIdle(page);
  await expect(page).toHaveURL(/sample=er$/);
  for (const engine of ENGINES) {
    await expect(status(page, engine)).toHaveText('OK');
    await expect(pane(page, engine).locator('[data-field="type"]')).toHaveText('er');
  }
});

test('日本語のラベルが両エンジンで表示される', async ({ page }) => {
  await open(page, 'flowchart-ja');
  for (const engine of ENGINES) {
    for (const label of ['申請受付', '担当課で審査', '住民情報システムへ登録']) {
      const el = diagram(page, engine).getByText(label, { exact: true });
      await expect(el).toBeVisible();
      // 字形が描画され、日本語の文字数に見合う幅を持つこと（文字化け・幅0の検出）
      const box = await el.boundingBox();
      expect(box.width, `${engine}: ${label}`).toBeGreaterThan(label.length * 8);
    }
  }
  // Pele: ラベルの文字幅がノードの枠に収まっていること（日本語の文字幅計測の確認）
  const { checked, overflow } = await diagram(page, 'pele').evaluate((svg) => {
    const result = { checked: 0, overflow: [] };
    for (const node of svg.querySelectorAll('.pele-node')) {
      const text = node.querySelector('text');
      const shape = node.querySelector('rect, path, polygon, ellipse');
      if (!text || !shape) continue;
      result.checked++;
      const t = text.getBBox();
      const s = shape.getBBox();
      if (t.x < s.x - 1 || t.x + t.width > s.x + s.width + 1) result.overflow.push(text.textContent);
    }
    return result;
  });
  expect(checked).toBe(9); // A〜I の全ノード
  expect(overflow).toEqual([]);
});

test('構文エラーは各エンジンごとに表示され、修正後に復帰する', async ({ page }) => {
  await open(page, 'flowchart-ja');
  await page.fill('#source', 'flowchart TD\n  A[開始 --> B');
  await waitIdle(page);
  for (const engine of ENGINES) {
    await expect(status(page, engine)).toHaveText('エラー');
    await expect(pane(page, engine).locator('[data-field="error"]')).toBeVisible();
    await expect(pane(page, engine).locator('[data-field="error"]')).toContainText(/Parse error|Error/);
    await expect(diagram(page, engine)).toHaveCount(0);
  }
  await expect(pane(page, 'pele').locator('[data-field="error"]')).toContainText('code: syntax');
  // Mermaid がエラー表示用の要素を body に残さないこと
  await expect(page.locator('body > [id^="dmmd-"], body > svg')).toHaveCount(0);

  await page.fill('#source', 'flowchart LR\n  A[開始] --> B[終了]');
  await waitIdle(page);
  for (const engine of ENGINES) {
    await expect(status(page, engine)).toHaveText('OK');
    await expect(pane(page, engine).locator('[data-field="error"]')).toBeHidden();
    await expect(diagram(page, engine)).toBeVisible();
  }
});

test('未対応の記法でも画面全体は停止しない', async ({ page }) => {
  await open(page, 'flowchart-ja');
  await page.fill('#source', 'これは図ではありません');
  await waitIdle(page);
  for (const engine of ENGINES) await expect(status(page, engine)).toHaveText('エラー');
  await expect(pane(page, 'pele').locator('[data-field="error"]')).toContainText('unsupported-diagram');
  await page.selectOption('#sample', 'sequence');
  await waitIdle(page);
  for (const engine of ENGINES) await expect(status(page, engine)).toHaveText('OK');
});

for (const [broken, other, file] of [['mermaid', 'pele', 'mermaid.min.js'], ['pele', 'mermaid', 'pele.global.js']]) {
  test(`${broken} の読込に失敗しても ${other} は描画できる`, async ({ page }) => {
    await page.route(`**/pele/vendor/${file}`, (route) => route.abort());
    await open(page, 'sequence');
    await expect(status(page, broken)).toHaveText('読込失敗');
    await expect(pane(page, broken).locator('[data-field="error"]')).toContainText(file);
    await expect(status(page, other)).toHaveText('OK');
    await expect(diagram(page, other)).toBeVisible();
  });
}

test('描画時間を計測し、ウォームアップ後の値を表示する', async ({ page }) => {
  await open(page, 'flowchart-complex');
  for (const engine of ENGINES) {
    await expect(pane(page, engine).locator('[data-field="load"]')).toHaveText(/\d ms$/);
  }
  await expect(pane(page, 'mermaid').locator('[data-field="init"]')).toHaveText(/\d ms$/);
  await expect(pane(page, 'pele').locator('[data-field="init"]')).toContainText('不要');

  await page.fill('#warmup', '2');
  await page.fill('#runs', '5');
  await page.click('#bench');
  await waitIdle(page);
  await expect(page.locator('#bench')).toBeEnabled();
  for (const engine of ENGINES) {
    await expect(pane(page, engine).locator('[data-field="median"]')).toHaveText(/\d ms（2回捨てて5回）$/);
    await expect(pane(page, engine).locator('[data-field="range"]')).toHaveText(/\d ms \/ [\d.]+ ms$/);
  }
  await expect(page.locator('#summary')).toContainText('ウォームアップ後の中央値');
  console.log(await page.locator('#summary').textContent());

  await page.check('#cold-text');
  await page.click('#bench');
  await waitIdle(page);
  await expect(pane(page, 'pele').locator('[data-field="median"]')).toHaveText(/\d ms（2回捨てて5回、文字幅キャッシュ破棄）$/);
  await expect(pane(page, 'mermaid').locator('[data-field="median"]')).toHaveText(/\d ms（2回捨てて5回）$/);
  console.log(await page.locator('#summary').textContent());
});

test('表示幅を狭めると両エンジンがその幅に収めて描画する', async ({ page }) => {
  await open(page, 'flowchart-complex');
  await page.selectOption('#frame-width', '360');
  for (const engine of ENGINES) {
    const frame = pane(page, engine).locator('[data-field="frame"]');
    await expect.poll(async () => (await frame.boundingBox()).width).toBe(360);
    // ResizeObserver による再描画中は一時的に SVG がなくなるため、幅の検証をリトライする。
    await expect.poll(async () => (await diagram(page, engine).boundingBox())?.width ?? Infinity).toBeLessThanOrEqual(360);
  }
  await page.locator('.compare').screenshot({ path: test.info().outputPath('frame-360.png') });
});

test('スマートフォン幅では左右比較を縦に並べ、横スクロールが発生しない', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, 'flowchart-ja');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(375);
  const p = await pane(page, 'pele').boundingBox();
  const m = await pane(page, 'mermaid').boundingBox();
  expect(m.y).toBeGreaterThanOrEqual(p.y + p.height);
  for (const engine of ENGINES) {
    await expect(status(page, engine)).toHaveText('OK');
    expect((await diagram(page, engine).boundingBox()).width).toBeLessThanOrEqual(375);
  }
  await page.screenshot({ path: test.info().outputPath('mobile.png'), fullPage: true });
});

test('フォントを切り替えると両エンジンに同じフォントが指定される', async ({ page }) => {
  await open(page, 'flowchart-ja');
  await page.selectOption('#font', 'windows');
  await waitIdle(page);
  for (const engine of ENGINES) {
    await expect(status(page, engine)).toHaveText('OK');
    const family = await pane(page, engine).locator('[data-field="frame"]').evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toBe('"Yu Gothic UI", Meiryo, sans-serif');
  }
  // Mermaid は initialize() で指定したフォントを SVG 内のスタイルに出力する
  await expect.poll(() => diagram(page, 'mermaid').evaluate((svg) => svg.outerHTML.includes('font-family:"Yu Gothic UI","Meiryo",sans-serif'))).toBe(true);
  await expect(diagram(page, 'pele').getByText('申請受付', { exact: true })).toBeVisible();
});
