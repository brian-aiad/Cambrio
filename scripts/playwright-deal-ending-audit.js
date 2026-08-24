/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=initial&players=4');
  await page.waitForTimeout(130);
  const dealOpacity = await page.locator('.peek-hand > .hand-slot').evaluateAll((slots) => slots.map((slot) => Number(window.getComputedStyle(slot).opacity)));
  if (new Set(dealOpacity.map((value) => Math.round(value * 10))).size < 2) throw new Error(`Initial cards did not deal in sequence: ${dealOpacity.join(', ')}`);
  await page.screenshot({ path: `${root}/initial-deal-in-flight.png` });
  await page.waitForTimeout(500);
  const hold = page.locator('.hold-button');
  await hold.dispatchEvent('pointerdown');
  await page.waitForTimeout(180);
  if (await page.locator('.peek-screen.holding').count() !== 1 || await page.locator('.peek-hand [data-peekable] .playing-card:not(.face-down)').count() !== 2) throw new Error('Hold-to-peek did not isolate both bottom cards.');
  if (!(await hold.textContent())?.includes('Memorize bottom two')) throw new Error('Hold state did not reinforce the memory action.');
  await page.screenshot({ path: `${root}/initial-peek-focused.png` });
  await hold.dispatchEvent('pointerup');
  await page.waitForTimeout(250);
  if (await page.locator('.waiting-ready').count() !== 1 || await page.locator('.playing-card:not(.face-down)').count()) throw new Error('Initial peek did not conceal and advance to waiting.');

  await page.goto('http://localhost:5173/__visual-audit?scene=awaiting&players=8');
  await page.waitForTimeout(420);
  await page.locator('.cambio-button').click();
  await page.waitForTimeout(180);
  const announcement = page.locator('.ending-announcement');
  if (await announcement.count() !== 1 || !(await announcement.textContent())?.includes('Brian called it')) throw new Error('Cambrio call announcement is missing the caller.');
  if (await page.locator('.cambio-button').count()) throw new Error('Cambrio remained callable after the ending started.');
  await page.screenshot({ path: `${root}/cambrio-call-announcement-8p.png` });
  await page.waitForTimeout(1_600);
  if (Number(await announcement.evaluate((element) => window.getComputedStyle(element).opacity)) > .05) throw new Error('Cambrio announcement did not clear promptly.');
  if (!(await page.locator('.ending-state').textContent())?.includes('CAMBRIO CALLED')) throw new Error('Persistent ending status disappeared with the announcement.');

  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('http://localhost:5173/__visual-audit?scene=awaiting&players=8');
    await page.waitForTimeout(420);
    await page.locator('.cambio-button').click();
    await page.waitForTimeout(180);
    const bounds = await page.locator('.ending-announcement').boundingBox();
    if (!bounds || bounds.x < 0 || bounds.y < 46 || bounds.x + bounds.width > viewport.width || bounds.y + bounds.height > viewport.height) {
      throw new Error(`Cambrio announcement escaped ${viewport.width}x${viewport.height}: ${JSON.stringify(bounds)}`);
    }
  }
  return { deal: 'staggered', initialPeek: 'bottom pair focused', cambrio: 'announced then persistent status', responsive: '320 portrait and phone landscape' };
}
