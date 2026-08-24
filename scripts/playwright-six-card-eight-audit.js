/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('http://localhost:5173/__visual-audit?scene=all-six&players=8');
    await page.waitForTimeout(500);
    const hands = page.locator('.player-hand');
    if (await hands.count() !== 8 || !await hands.evaluateAll((items) => items.every((hand) => hand.querySelectorAll('.playing-card').length === 6))) throw new Error(`The maximum table did not preserve six cards per player at ${viewport.width}x${viewport.height}.`);
    if (await page.locator('.slot-tag').count() !== 48) throw new Error('The maximum table lost stable position labels.');
    if (!(await page.locator('.stack-hint.limit').textContent())?.includes('6-CARD LIMIT')) throw new Error('The maximum hand does not explain why stacking is unavailable.');
    const geometry = await page.evaluate(() => {
      const box = (selector) => { const bounds = document.querySelector(selector)?.getBoundingClientRect(); return bounds && { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }; };
      const overlap = (first, second) => Boolean(first && second && first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top);
      const self = box('.self-zone .hand-cards');
      const opponents = box('.opponent-rail');
      const table = box('.pile-zone');
      const hint = box('.stack-hint');
      return { pageWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth, viewportHeight: document.documentElement.clientHeight, self, opponents, table, hint, selfOpponentOverlap: overlap(self, opponents), selfTableOverlap: overlap(self, table), hintTableOverlap: overlap(hint, table) };
    });
    if (geometry.pageWidth > geometry.viewportWidth || geometry.selfOpponentOverlap || geometry.selfTableOverlap || geometry.hintTableOverlap || !geometry.table || geometry.table.top < 46 || geometry.table.bottom > geometry.viewportHeight) throw new Error(`Maximum table collision at ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: `${root}/all-six-${viewport.width}x${viewport.height}.png` });
  }
  return { players: 8, cards: 48, viewports: ['320x568', '390x844', '844x390'], collisions: 0 };
}
