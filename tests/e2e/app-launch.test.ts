import { expect, test } from './fixtures/electron-app';

test.describe('App Launch', () => {
  test('renders WelcomeView with branding on startup', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Datspace' })).toBeVisible();
    await expect(page.getByText('Embedded Analytics Workbench')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Get Started' })).toBeVisible();
    await expect(page.getByText('Open a new query tab to write and execute SQL')).toBeVisible();
  });

  test('DuckDB worker reaches ready state', async ({ page }) => {
    // StatusBar shows "DuckDB: loading" initially, then transitions to "DuckDB: ready"
    await expect(page.getByText('DuckDB: ready')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('window is visible with expected dimensions', async ({ electronApp, page }) => {
    // Wait for the app content to be rendered (ensures ready-to-show has fired)
    await expect(page.getByRole('heading', { name: 'Datspace' })).toBeVisible();

    const isVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win?.isVisible() ?? false;
    });
    expect(isVisible).toBe(true);

    const bounds = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win?.getBounds();
    });
    expect(bounds).toBeDefined();
    if (bounds) {
      expect(bounds.width).toBeGreaterThanOrEqual(800);
      expect(bounds.height).toBeGreaterThanOrEqual(600);
    }
  });
});
