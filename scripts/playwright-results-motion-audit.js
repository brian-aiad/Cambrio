/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=results&players=8');
  await page.waitForTimeout(280);
  if (await page.locator('.result-row').count() !== 8 || await page.locator('.winner-mark').count() !== 1) throw new Error('Eight-player results are incomplete.');
  const rowOpacity = await page.locator('.result-row').evaluateAll((rows) => rows.map((row) => Number(window.getComputedStyle(row).opacity)));
  if (rowOpacity[0] <= rowOpacity[7]) throw new Error(`Result rows did not reveal in rank order: ${rowOpacity.join(', ')}`);
  await page.screenshot({ path: `${root}/results-reveal-in-flight-8p.png`, fullPage: true });
  await page.waitForTimeout(1_000);
  const settled = await page.locator('.result-row').evaluateAll((rows) => rows.every((row) => Number(window.getComputedStyle(row).opacity) > .98));
  if (!settled) throw new Error('Result rows did not settle completely.');
  if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) throw new Error('Results introduced horizontal overflow.');
  await page.screenshot({ path: `${root}/results-settled-8p.png`, fullPage: true });

  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('http://localhost:5173/__visual-audit?scene=results&players=8');
    await page.waitForTimeout(1_200);
    const geometry = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll('.result-row')].map((row) => {
        const bounds = row.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      }),
    }));
    if (geometry.page > geometry.viewport || geometry.rows.some((row) => row.left < 0 || row.right > geometry.viewport)) {
      throw new Error(`Results overflow ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    }
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://localhost:5173/__visual-audit?scene=results&players=8');
  await page.waitForTimeout(80);
  if (!await page.locator('.result-row').evaluateAll((rows) => rows.every((row) => Number(window.getComputedStyle(row).opacity) > .98))) throw new Error('Reduced-motion results did not settle immediately.');
  return { players: 8, results: 'rank ordered', overflow: false, reducedMotion: 'immediate' };
}
