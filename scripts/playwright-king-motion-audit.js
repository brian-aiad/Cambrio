/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=black-own&players=4');
  await page.waitForTimeout(450);
  await page.locator('.self-zone [data-card-id="p0-card-1"]').click();
  await page.locator('.opponent-rail [data-card-id="p1-card-2"]').click();
  await page.waitForTimeout(180);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 3) throw new Error('Black King did not reveal exactly two targets plus discard.');
  if (await page.locator('.playing-card.selected:not(.face-down)').count() !== 2) throw new Error('Black King did not focus both selected positions.');
  await page.screenshot({ path: `${root}/black-king-focused-reveal.png` });
  await page.waitForTimeout(1_750);
  if (!(await page.locator('.interaction-prompt').textContent())?.includes('Swap positions?') || await page.locator('.playing-card:not(.face-down)').count() !== 1) throw new Error('Black King did not conceal before the decision.');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.waitForTimeout(100);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Black King swap did not launch both exact-position flights.');
  const routes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => `${element.getAttribute('data-flight-from')} -> ${element.getAttribute('data-flight-to')}`));
  if (!routes.includes('Brian TR -> Alex BL') || !routes.includes('Alex BL -> Brian TR')) throw new Error(`Black King routes are unclear: ${routes.join(', ')}`);
  await page.screenshot({ path: `${root}/black-king-refined-flight.png` });
  await page.waitForTimeout(1_100);
  if (await page.locator('.self-zone [data-card-id="p1-card-2"]').count() !== 1 || await page.locator('.opponent-rail [data-card-id="p0-card-1"]').count() !== 1) throw new Error('Black King cards did not settle in the chosen slots.');
  return { blackKing: 'focused reveal, concealed choice, two flights' };
}
