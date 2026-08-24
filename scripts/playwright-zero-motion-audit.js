/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=zero&players=4');
  await page.waitForTimeout(420);
  if (await page.locator('.cambio-button').count()) throw new Error('Cambrio remained callable after zero-card ending began.');
  await page.locator('[data-table-zone="deck"]').click();
  await page.waitForTimeout(80);
  if (await page.locator('.swap-flight-layer.discard .card-flight').count() !== 1) throw new Error('A zero-card turn did not animate its forced deck-to-discard move.');
  if (!(await page.locator('.flight-endpoint em').textContent())?.includes('Deck')) throw new Error('Forced discard did not identify the deck as its source.');
  if (!(await page.locator('.table-action-cue').textContent())?.includes('Deck')) throw new Error('Forced discard confirmation is unclear.');
  await page.screenshot({ path: 'output/playwright/iteration/zero-card-forced-discard.png' });
  await page.waitForTimeout(1_000);
  if ((await page.locator('[data-table-zone="discard"] .playing-card').getAttribute('data-card-id')) !== 'audit-drawn') throw new Error('Forced draw did not settle on discard.');
  if (await page.locator('.self-zone .playing-card').count() !== 0) throw new Error('A zero-card player regained inventory.');
  return { zeroCardTurn: 'deck to discard', inventory: 0 };
}
