/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=all-six&players=8');
  await page.waitForTimeout(400);
  if (await page.locator('.self-zone .playing-card').count() !== 6) throw new Error('Six-card hand did not render all six stable slots.');
  if (await page.locator('.self-zone .playing-card.interactive').count() !== 6) throw new Error('Six-card player cannot initiate a legal stack.');
  await page.locator('.self-zone [data-card-id="p0-card-0"]').click();
  await page.waitForTimeout(120);
  if (await page.locator('.stack-result.correct').count() !== 1) throw new Error('Matching six-card stack did not succeed.');
  if (await page.locator('.self-zone .playing-card').count() !== 5) throw new Error('Successful six-card stack did not reduce the hand to five.');
  if (await page.locator('.card-flight[data-flight-to="Discard"]').count() !== 1) throw new Error('Successful six-card stack did not travel to discard.');
  await page.screenshot({ path: `${root}/six-card-stack-success-390x844.png` });

  await page.goto('http://localhost:5173/__visual-audit?scene=six-wrong&players=8');
  await page.waitForTimeout(400);
  if (await page.locator('.self-zone .playing-card.interactive').count() !== 6) throw new Error('Six-card miss scene began with stacking disabled.');
  await page.locator('.self-zone [data-card-id="p0-card-0"]').click();
  await page.waitForTimeout(150);
  if (await page.locator('.stack-result.locked').count() !== 1) throw new Error('Six-card miss did not show its current-discard lock.');
  if (await page.locator('.self-zone .playing-card').count() !== 6) throw new Error('Six-card miss exceeded the hand cap.');
  if (await page.locator('.self-zone .playing-card.interactive').count() !== 0) throw new Error('Six-card player can spam guesses after a miss on the same discard.');
  if (!(await page.locator('.stack-hint.limit').textContent())?.includes('next discard')) throw new Error('Six-card miss does not visibly explain when stacking reopens.');
  await page.screenshot({ path: `${root}/six-card-stack-miss-lock-390x844.png` });

  return { sixCardSuccess: '5 cards', sixCardMiss: '6 cards + current-discard lock' };
}
