import { defineConfig } from '@playwright/test';

// biome-ignore lint/style/noDefaultExport: Required by Playwright
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  workers: 1, // Single-instance lock prevents parallel Electron instances
  retries: 1,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? 'github' : 'list',
  outputDir: 'test-results/e2e',
  globalSetup: './tests/e2e/helpers/global-setup.ts',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite --config vite.renderer.config.ts --port 5173',
    port: 5173,
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
});
