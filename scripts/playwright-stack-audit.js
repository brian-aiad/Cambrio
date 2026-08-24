/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=stack-wrong&players=4');
  await page.waitForTimeout(600);
  await page.locator('.self-zone [data-card-id="p0-card-0"]').evaluate((element) => (element).click());
  await page.waitForTimeout(130);
  await page.screenshot({ path: `${root}/stack-wrong-feedback-390x844.png` });
  if (await page.locator('.self-zone .playing-card').count() !== 5) throw new Error('Wrong stack did not add exactly one penalty card.');
  if (await page.locator('.stack-result.wrong').count() !== 1) throw new Error('Wrong stack feedback is not visible.');
  if (await page.locator('.self-zone .hand-slot[data-slot="4"] .playing-card').count() !== 1) throw new Error('Penalty card did not enter the stable +1 slot.');

  await page.goto('http://localhost:5173/__visual-audit?scene=stack-correct&players=4');
  await page.waitForTimeout(600);
  await page.locator('.opponent-rail [data-card-id="p1-card-3"]').evaluate((element) => (element).click());
  await page.waitForTimeout(130);
  await page.screenshot({ path: `${root}/stack-correct-transfer-390x844.png` });
  if (await page.locator('.card-flight').count() !== 1) throw new Error('Successful stack did not animate the selected card to discard.');
  if (!(await page.locator('.flight-endpoint em').textContent())?.includes('Alex BR')) throw new Error('Successful stack did not label its exact source slot.');
  if (await page.locator('.table-action-cue').count() !== 0) throw new Error('Stack flight added a redundant swap caption over the stack result.');
  if (await page.locator('[aria-label="Alex\'s cards"] .playing-card').count() !== 3) throw new Error('Successful stack did not remove the exact opponent card.');
  if (await page.locator('.stack-result.correct').count() !== 1) throw new Error('Successful stack feedback is not visible.');
  if (await page.locator('.stack-hint').evaluateAll((elements) => elements.some((element) => Number(window.getComputedStyle(element).opacity) > 0.1))) throw new Error('Stack window stayed visibly open after a successful stack.');
  if (!(await page.locator('.interaction-prompt').textContent())?.includes('give away')) throw new Error('Opponent stack did not enter the mandatory transfer flow.');
  await page.waitForTimeout(650);
  if ((await page.locator('.flight-front strong').textContent()) !== '8') throw new Error('Successful stack flight did not reveal the matching rank on its way to discard.');
  await page.screenshot({ path: `${root}/stack-correct-arrival-390x844.png` });

  return { wrongStack: 'penalty in +1', correctStack: 'closed with transfer' };
}
