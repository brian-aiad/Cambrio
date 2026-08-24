/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const outputRoot = 'C:/Users/kingt/Desktop/cambrio/output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=drawn&players=2');
  await page.waitForTimeout(600);
  await page.locator('[data-card-id="p0-card-0"]').evaluate((element) => (element).click());
  await page.waitForTimeout(90);
  await page.screenshot({ path: `${outputRoot}/drawn-swap-mid-390x844.png` });
  const visibleDecisionLayers = await page.locator('.drawn-panel, .stack-hint').evaluateAll((elements) => elements.filter((element) => Number(window.getComputedStyle(element).opacity) > 0.1).length);
  if (visibleDecisionLayers > 1) throw new Error('Draw and stack decision layers visibly overlap.');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outputRoot}/drawn-swap-complete-390x844.png` });
  const drawnSlot = await page.locator('[data-card-id="drawn-10"]').last().getAttribute('data-slot');
  if (drawnSlot !== '0') throw new Error(`Drawn card moved to slot ${drawnSlot}, expected slot 0.`);
  if (await page.locator('.stack-hint').count() !== 1) throw new Error('The new discard did not open a fresh stack window.');

  await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=4');
  await page.waitForTimeout(600);
  await page.locator('.opponent-rail [data-card-id="p1-card-3"]').evaluate((element) => (element).click());
  await page.waitForTimeout(90);
  await page.screenshot({ path: `${outputRoot}/blind-swap-mid-390x844.png` });
  await page.waitForTimeout(700);
  if (await page.locator('.self-zone [data-card-id="p1-card-3"]').count() !== 1) throw new Error('Opponent card did not arrive in the selected self slot.');
  if (await page.locator('.opponent-rail [data-card-id="p0-card-0"]').count() !== 1) throw new Error('Self card did not arrive in the selected opponent slot.');

  return { drawnSlot, blindSwap: 'complete' };
}
