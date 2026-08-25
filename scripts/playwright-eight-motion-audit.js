/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=8');
    await page.waitForTimeout(450);
    await page.locator('.opponent-rail [data-card-id="p7-card-3"]').click();
    await page.waitForTimeout(80);
    if (await page.locator('.card-flight').count() !== 2) throw new Error(`Eight-player swap failed to launch at ${viewport.width}x${viewport.height}.`);
    const routes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => `${element.getAttribute('data-flight-from')} -> ${element.getAttribute('data-flight-to')}`));
    if (!routes.includes('Brian TL -> Devin BR') || !routes.includes('Devin BR -> Brian TL')) throw new Error(`Far-seat routes are unclear: ${routes.join(', ')}`);
    const pathDistances = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => Number(element.getAttribute('data-flight-distance'))));
    if (pathDistances.some((distance) => distance < 55)) throw new Error(`Far-seat paths are too short at ${viewport.width}x${viewport.height}: ${pathDistances.join(', ')}px.`);
    await page.waitForTimeout(420);
    const middle = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, x: box.x, y: box.y }; }));
    if (middle.some((box) => box.left < -2 || box.top < -2 || box.right > viewport.width + 2 || box.bottom > viewport.height + 2)) throw new Error(`Flight escaped ${viewport.width}x${viewport.height}: ${JSON.stringify(middle)}`);
    await page.screenshot({ path: `${root}/eight-swap-refined-${viewport.width}x${viewport.height}.png` });
    await page.waitForTimeout(750);
    if (await page.locator('.self-zone [data-card-id="p7-card-3"]').count() !== 1 || await page.locator('.opponent-rail [data-card-id="p0-card-0"]').count() !== 1) throw new Error(`Far-seat swap did not settle at ${viewport.width}x${viewport.height}.`);
  }
  return { players: 8, viewports: ['390x844', '320x568', '844x390'], endpoints: 'Brian TL and Devin BR' };
}
