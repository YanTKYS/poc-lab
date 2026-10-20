import { defineConfig, devices } from '@playwright/test';

// dist/ を GitHub Pages と同じサブパス (/poc-lab/) で配信して検証する。
// 事前に `npm run build` が必要。
export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173/poc-lab/',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 1000 },
    locale: 'ja-JP',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/serve.mjs 4173',
    url: 'http://localhost:4173/poc-lab/',
    reuseExistingServer: !process.env.CI,
  },
});
