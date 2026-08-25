/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=drawn&players=2');
  await page.waitForTimeout(500);
  await page.locator('[data-card-id="p0-card-0"]').click();
  await page.waitForTimeout(80);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('A drawn-card replacement did not launch both physical card movements.');
  const replacementRoutes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => `${element.getAttribute('data-flight-from')} -> ${element.getAttribute('data-flight-to')}`));
  if (!replacementRoutes.includes('Brian TL -> Discard') || !replacementRoutes.includes('Drawn card -> Brian TL')) throw new Error(`Replacement routes are unclear: ${replacementRoutes.join(', ')}`);
  if (!(await page.locator('.table-action-cue').textContent())?.includes('Drawn card')) throw new Error('Replacement confirmation did not identify the incoming card.');
  await page.screenshot({ path: `${root}/drawn-replacement-mid-390x844.png` });
  await page.waitForTimeout(620);
  const faces = await page.locator('.flight-front strong').allTextContents();
  if (!faces.includes('A') || !faces.includes('10')) throw new Error(`Replacement flights did not preserve both known faces: ${faces.join(', ')}`);
  if (Number(await page.locator('.card-flight.face-conceal .flight-front').evaluate((element) => window.getComputedStyle(element).opacity)) > .1) throw new Error('Incoming drawn card did not turn face-down before landing.');
  await page.waitForTimeout(620);
  if (await page.locator('.self-zone [data-card-id="drawn-10"][data-slot="0"]').count() !== 1) throw new Error('Drawn card did not land in Brian TL.');

  await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=4');
  await page.waitForTimeout(500);
  await page.locator('.opponent-rail [data-card-id="p1-card-3"]').click();
  await page.waitForTimeout(80);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Blind swap did not launch two card flights.');
  const blindRoutes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => `${element.getAttribute('data-flight-from')} -> ${element.getAttribute('data-flight-to')}`));
  if (!blindRoutes.includes('Brian TL -> Alex BR') || !blindRoutes.includes('Alex BR -> Brian TL')) throw new Error(`Blind swap routes are unclear: ${blindRoutes.join(', ')}`);
  await page.screenshot({ path: `${root}/blind-swap-refined-mid-390x844.png` });
  await page.waitForTimeout(1200);
  if (await page.locator('.self-zone [data-card-id="p1-card-3"]').count() !== 1 || await page.locator('.opponent-rail [data-card-id="p0-card-0"]').count() !== 1) throw new Error('Blind swap did not settle into authoritative slots.');
  return { replacement: 'two directional flights', blindSwap: 'Brian TL and Alex BR' };
}
