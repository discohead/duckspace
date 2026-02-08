import { expect, test } from './fixtures/electron-app';

/** Open the "New tab" dropdown and click the "New Query" menu item. */
async function createQueryTab(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click();
  await page.getByRole('menuitem', { name: 'New Query' }).click();
}

test.describe('Query Execution', () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.getByText('DuckDB: ready')).toBeVisible({ timeout: 15_000 });

    // Ensure a clean query tab exists
    const tabCount = await page.getByRole('tab').count();
    if (tabCount === 0) {
      await createQueryTab(page);
    }

    // Clear any existing SQL
    await page.getByPlaceholder('Enter SQL query...').fill('');
  });

  test.afterEach(async ({ page }) => {
    // Close all tabs to reset state
    let tabCount = await page.getByRole('tab').count();
    while (tabCount > 0) {
      await page.getByRole('tab').first().locator('button').click();
      tabCount = await page.getByRole('tab').count();
    }
  });

  test('executes SELECT 42 AS answer and shows result', async ({ page }) => {
    await page.getByPlaceholder('Enter SQL query...').fill('SELECT 42 AS answer');
    await page.getByRole('button', { name: 'Execute' }).click();

    // Wait for result grid to display the column header and value
    await expect(page.locator('th').getByText('answer')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('td').getByText('42')).toBeVisible();
    await expect(page.getByText('1 row')).toBeVisible();
  });

  test('executes multi-row query and shows row count', async ({ page }) => {
    await page
      .getByPlaceholder('Enter SQL query...')
      .fill('SELECT * FROM generate_series(1, 10) AS t(n)');
    await page.getByRole('button', { name: 'Execute' }).click();

    await expect(page.getByText('10 rows')).toBeVisible({ timeout: 10_000 });
  });

  test('shows error panel for invalid SQL', async ({ page }) => {
    await page.getByPlaceholder('Enter SQL query...').fill('SELEKT invalid_syntax');
    await page.getByRole('button', { name: 'Execute' }).click();

    // Error panel displays an error code in brackets: [Exxxx]
    await expect(page.locator('text=/\\[E\\d+\\]/')).toBeVisible({ timeout: 10_000 });
  });
});
