import type { ElectronApplication, Page } from '@playwright/test';
import { test as base, _electron as electron } from '@playwright/test';
import fs from 'fs';
import path from 'path';

interface WorkerFixtures {
  electronApp: ElectronApplication;
}

interface TestFixtures {
  page: Page;
}

const MAIN_ENTRY = path.resolve(__dirname, '../../../.vite/build/main-entry.js');

/** Filter process.env to only string values (strip undefined entries). */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Custom Playwright test fixture for Electron e2e tests.
 *
 * The Electron app is worker-scoped (one instance per test file).
 * The page is test-scoped but reuses the same window across tests.
 * Tests must manage their own state cleanup (close tabs, etc.).
 */
export const test = base.extend<TestFixtures, WorkerFixtures>({
  electronApp: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture API requires destructured parameter
    async ({}, use) => {
      if (!fs.existsSync(MAIN_ENTRY)) {
        throw new Error(
          `Build artifact not found: ${MAIN_ENTRY}\n` +
            'Run "npm run build:e2e" to generate build artifacts.',
        );
      }

      const electronApp = await electron.launch({
        args: [MAIN_ENTRY],
        env: {
          ...cleanEnv(),
          ELECTRON_RUN_AS_NODE: '', // Must be unset — Claude Code sets this to '1'
        },
        timeout: 30_000,
      });

      await use(electronApp);
      await electronApp.close();
    },
    { scope: 'worker' },
  ],

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect } from '@playwright/test';
