/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'C:/Users/kingt/Desktop/cambrio/output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=initial&players=2');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${root}/initial-peek-ready-390x844.png` });
  const hold = page.locator('.hold-button');
  const box = await hold.boundingBox();
  if (!box) throw new Error('Initial peek hold control is missing.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(180);
  if (await page.locator('.peek-hand .playing-card:not(.face-down)').count() !== 2) throw new Error('Initial peek did not reveal exactly BL and BR.');
  const visibleSlots = await page.locator('.peek-hand .playing-card:not(.face-down)').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-slot')));
  if (visibleSlots.join(',') !== '2,3') throw new Error(`Initial peek revealed the wrong positions: ${visibleSlots.join(',')}`);
  await page.screenshot({ path: `${root}/initial-peek-held-390x844.png` });
  await page.mouse.up();
  await page.waitForTimeout(180);
  if (await page.locator('.peek-hand .playing-card:not(.face-down)').count() !== 0) throw new Error('Initial cards stayed visible after release.');
  if (!(await page.locator('.waiting-ready').textContent())?.includes('Waiting')) throw new Error('Initial peek did not complete after release.');
  return { revealedSlots: ['BL', 'BR'], concealedOnRelease: true };
}
