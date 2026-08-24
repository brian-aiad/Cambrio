/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const base = 'http://localhost:5173/__visual-audit';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}?scene=awaiting&players=8`);
  await page.waitForTimeout(420);
  if (await page.locator('.cambio-button').count() !== 1) throw new Error('Cambrio is unavailable at the start of the active turn.');
  await page.locator('[data-table-zone="deck"]').click();
  await page.waitForTimeout(90);
  if (await page.locator('.cambio-button').count() !== 1) throw new Error('Cambrio disappeared during an in-progress turn.');

  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`${base}?scene=drawn&players=2`);
  await page.waitForTimeout(420);
  const call = await page.locator('.cambio-button').boundingBox();
  const drawn = await page.locator('.drawn-panel').boundingBox();
  const deck = await page.locator('[data-table-zone="deck"]').boundingBox();
  const separate = (first, second) => first.x >= second.x + second.width || second.x >= first.x + first.width || first.y >= second.y + second.height || second.y >= first.y + first.height;
  if (!call || !drawn || !deck || !separate(call, drawn)) throw new Error('Cambrio overlaps the landscape draw panel.');
  if (!separate(deck, drawn)) throw new Error(`The landscape draw panel obscures the deck: deck=${JSON.stringify(deck)}, drawn=${JSON.stringify(drawn)}.`);
  await page.screenshot({ path: 'output/playwright/iteration/drawn-landscape-no-overlap.png' });
  await page.goto(`${base}?scene=opponent-turn&players=4`);
  await page.waitForTimeout(420);
  await page.locator('.cambio-button').click();
  await page.waitForTimeout(80);
  if (!(await page.locator('.ending-announcement').textContent())?.includes('Brian called it')) throw new Error('Out-of-turn caller did not anchor the ending.');
  return { startOfTurn: 'callable', duringTurn: 'callable', outOfTurn: 'callable', landscape: 'clear' };
}
