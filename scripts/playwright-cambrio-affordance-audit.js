/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const base = 'http://localhost:5173/__visual-audit';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?scene=awaiting&players=8`);
  await page.waitForTimeout(420);
  if (await page.locator('.cambio-button').count() !== 1) throw new Error('Cambrio is unavailable at the start of the active turn.');
  await page.locator('[data-table-zone="deck"]').click();
  await page.waitForTimeout(90);
  if (await page.locator('.cambio-button').count()) throw new Error('Cambrio remained available after drawing.');

  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`${base}?scene=drawn&players=2`);
  await page.waitForTimeout(420);
  if (await page.locator('.cambio-button').count()) throw new Error('Cambrio appeared in an invalid landscape draw state.');
  await page.screenshot({ path: 'output/playwright/iteration/drawn-landscape-no-overlap.png' });
  return { startOfTurn: 'callable', afterDraw: 'hidden', landscape: 'clear' };
}
