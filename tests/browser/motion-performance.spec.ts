import { expect, test } from '@playwright/test';

test('draw motion stays within a smooth mobile frame budget', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=awaiting&players=8');
  await page.waitForTimeout(500);

  const frameSample = page.evaluate(() => new Promise<number[]>((resolve) => {
    const frames: number[] = [];
    let previous = performance.now();
    const started = previous;
    const sample = (now: number) => {
      frames.push(now - previous);
      previous = now;
      if (now - started >= 1_250) resolve(frames);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
  await page.locator('.deck-card:not(:disabled)').click();
  const frames = (await frameSample).slice(2).sort((first, second) => first - second);
  const p95 = frames[Math.floor(frames.length * .95)] ?? 0;
  const worst = frames.at(-1) ?? 0;
  const dropped = frames.filter((duration) => duration > 25).length;

  expect(p95, `p95 frame interval was ${p95.toFixed(1)}ms`).toBeLessThanOrEqual(35);
  expect(worst, `worst frame interval was ${worst.toFixed(1)}ms`).toBeLessThanOrEqual(120);
  expect(dropped / frames.length, `${dropped}/${frames.length} frames exceeded 25ms`).toBeLessThanOrEqual(.2);
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
  await expect(page.locator('.drawn-actions')).toHaveCSS('opacity', '1');
});

test('long-distance swaps animate by transform and leave no transient layers', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/__visual-audit?scene=blind-opponent&players=8');
    await page.waitForTimeout(400);
    await page.locator('.opponent-rail [data-card-id="p7-card-3"]').click();
    await expect(page.locator('.card-flight')).toHaveCount(2);
    await expect(page.locator('.table-action-cue')).toContainText('Blind swap');
    await expect(page.locator('.table-action-cue')).toContainText('Devin BR');
    await expect(page.locator('.table-action-cue')).toContainText('Brian TL');
    await expect(page.locator('.player-hand.active-turn')).toHaveCount(1);
    await expect(page.locator('.player-hand.active-turn .seat-name')).toContainText('Alex');
    const origins = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
      transform: (element as HTMLElement).style.transform,
    })));
    await page.waitForTimeout(280);
    const moved = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
      transform: (element as HTMLElement).style.transform,
      bounds: element.getBoundingClientRect().toJSON(),
    })));
    for (const [index, flight] of moved.entries()) {
      expect(flight.left).toBe(origins[index].left);
      expect(flight.top).toBe(origins[index].top);
      expect(flight.transform).not.toBe(origins[index].transform);
      expect(flight.bounds.left).toBeGreaterThanOrEqual(-2);
      expect(flight.bounds.top).toBeGreaterThanOrEqual(-2);
      expect(flight.bounds.right).toBeLessThanOrEqual(viewport.width + 2);
      expect(flight.bounds.bottom).toBeLessThanOrEqual(viewport.height + 2);
    }
    await expect(page.locator('.swap-flight-layer')).toHaveCount(0, { timeout: 2_000 });
    await expect(page.locator('.flight-receiving, .selected')).toHaveCount(0);
  }
});

test('reduced-motion preference removes travel animation without delaying the decision', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=awaiting&players=8');
  await page.locator('.deck-card:not(:disabled)').click();
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
  await expect(page.locator('.drawn-actions')).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: /^discard$/i })).toBeEnabled();
});
