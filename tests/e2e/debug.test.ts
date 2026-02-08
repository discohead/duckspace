import { expect, test } from './fixtures/electron-app';

test('debug: query execution pipeline', async ({ page }) => {
  // Wait for DuckDB ready
  await expect(page.getByText('DuckDB: ready')).toBeVisible({ timeout: 15_000 });

  // Create a query tab
  await page.getByRole('button', { name: '+' }).click();
  await expect(page.getByPlaceholder('Enter SQL query...')).toBeVisible();

  // Capture console messages
  const consoleMsgs: string[] = [];
  page.on('console', (msg) => {
    consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Capture page errors
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  // Capture custom events being dispatched via evaluate
  await page.evaluate(() => {
    window.addEventListener('datspace:arrow-batch', (event) => {
      const detail = (event as CustomEvent).detail;
      console.log(
        `[ARROW-BATCH] queryId=${detail.queryId} index=${detail.batch?.index} isLast=${detail.batch?.isLast} byteLength=${detail.batch?.buffer?.byteLength}`,
      );
    });
    window.addEventListener('datspace:result-reset', (event) => {
      const detail = (event as CustomEvent).detail;
      console.log(`[RESULT-RESET] tabId=${detail.tabId}`);
    });
  });

  // Type and execute a simple query
  await page.getByPlaceholder('Enter SQL query...').fill('SELECT 42 AS answer');
  await page.getByRole('button', { name: 'Execute' }).click();

  // Wait a reasonable time for results
  await page.waitForTimeout(5000);

  // Capture full page text
  const bodyText = await page.locator('body').innerText();
  console.log('=== BODY TEXT AFTER EXECUTE ===');
  console.log(bodyText);
  console.log('=== CONSOLE MESSAGES ===');
  for (const msg of consoleMsgs) console.log(msg);
  console.log('=== PAGE ERRORS ===');
  for (const err of pageErrors) console.log(err);

  // Check if any <th> or <td> elements exist
  const thCount = await page.locator('th').count();
  const tdCount = await page.locator('td').count();
  console.log(`=== TABLE ELEMENTS: ${thCount} th, ${tdCount} td ===`);

  // Check what text is visible from the ResultGrid area
  const resultText = await page.evaluate(() => {
    // Look for the result grid area
    const main = document.querySelector('main');
    if (!main) return 'NO MAIN ELEMENT';
    const children = Array.from(main.querySelectorAll('*'));
    return children
      .filter((el) => el.textContent && el.children.length === 0)
      .map((el) => `<${el.tagName}> ${el.textContent?.trim()}`)
      .filter((t) => t.length > 3)
      .join('\n');
  });
  console.log('=== RESULT AREA LEAF ELEMENTS ===');
  console.log(resultText);

  expect(true).toBe(true);
});
