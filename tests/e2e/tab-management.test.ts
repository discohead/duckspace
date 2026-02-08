import { expect, test } from './fixtures/electron-app';

/** Open the "New tab" dropdown and click the "New Query" menu item. */
async function createQueryTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('menuitem', { name: 'New Query' }).click();
}

test.describe('Tab Management', () => {
  test.beforeEach(async ({ page }) => {
    // Ensure worker is ready before interacting with tabs
    await expect(page.getByText('DuckDB: ready')).toBeVisible({ timeout: 15_000 });
  });

  test.afterEach(async ({ page }) => {
    // Clean up: close all tabs to return to WelcomeView
    let tabCount = await page.getByRole('tab').count();
    while (tabCount > 0) {
      await page.getByRole('tab').first().locator('button').click();
      tabCount = await page.getByRole('tab').count();
    }
  });

  test('create new tab via + button shows query editor', async ({ page }) => {
    // Start from WelcomeView
    await expect(page.getByRole('heading', { name: 'Datspace' })).toBeVisible();

    // Click + to create a new query tab
    await createQueryTab(page);

    // Tab appears with "Query 1" title
    await expect(page.getByRole('tab', { name: /Query 1/ })).toBeVisible();

    // WelcomeView disappears
    await expect(page.getByRole('heading', { name: 'Datspace' })).not.toBeVisible();

    // Query editor is shown
    await expect(page.getByPlaceholder('Enter SQL query...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Execute' })).toBeVisible();
    await expect(page.getByText('Execute a query to see results')).toBeVisible();
  });

  test('close tab returns to WelcomeView', async ({ page }) => {
    // Create a tab
    await createQueryTab(page);
    await expect(page.getByRole('tab')).toHaveCount(1);

    // Close it
    await page.getByRole('tab').first().locator('button').click();

    // WelcomeView returns
    await expect(page.getByRole('heading', { name: 'Datspace' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
  });

  test('multiple tabs can be created and switched', async ({ page }) => {
    // Create first tab
    await createQueryTab(page);
    await expect(page.getByRole('tab')).toHaveCount(1);

    // Create second tab
    await createQueryTab(page);
    await expect(page.getByRole('tab')).toHaveCount(2);

    // Second tab is active (most recently created)
    const secondTab = page.getByRole('tab').nth(1);
    await expect(secondTab).toHaveAttribute('aria-selected', 'true');

    // Click first tab to switch
    const firstTab = page.getByRole('tab').first();
    await firstTab.click();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect(secondTab).toHaveAttribute('aria-selected', 'false');
  });
});
