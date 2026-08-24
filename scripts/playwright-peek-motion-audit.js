/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });
  for (const sample of [
    { scene: 'own-select', target: '.self-zone [data-card-id="p0-card-2"]', shot: 'own-peek-focus.png' },
    { scene: 'opponent-select', target: '.opponent-rail [data-card-id="p2-card-1"]', shot: 'opponent-peek-focus.png' },
  ]) {
    await page.goto(`http://localhost:5173/__visual-audit?scene=${sample.scene}&players=4`);
    await page.waitForTimeout(420);
    await page.locator(sample.target).click();
    await page.waitForTimeout(180);
    if (await page.locator('.playing-card:not(.face-down)').count() !== 2) throw new Error(`${sample.scene} revealed the wrong number of cards.`);
    if (!(await page.locator('.interaction-prompt').textContent())?.includes('Memorize')) throw new Error(`${sample.scene} is missing the timed prompt.`);
    if (await page.locator('.game-page.reveal-focus-mode').count() !== 1) throw new Error(`${sample.scene} did not focus the private reveal.`);
    const dimmed = await page.locator('.player-hand .playing-card:not(.selected)').first().evaluate((element) => Number(window.getComputedStyle(element).opacity));
    if (dimmed > .65) throw new Error(`${sample.scene} did not visually isolate the target.`);
    await page.screenshot({ path: `${root}/${sample.shot}` });
    await page.waitForTimeout(1_750);
    if (await page.locator('.playing-card:not(.face-down)').count() !== 1 || await page.locator('.reveal-focus-mode').count()) throw new Error(`${sample.scene} did not conceal and restore the table.`);
  }
  return { ownPeek: 'focused then concealed', opponentPeek: 'focused then concealed' };
}
