import { expect, test } from '@playwright/test';

test('draw motion stays within a smooth mobile frame budget', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  const trials: Array<{ median: number; p95: number; worst: number; over25: number; over50: number; samples: number; longestTask: number }> = [];

  for (let trial = 0; trial < 3; trial += 1) {
    await page.goto('/__visual-audit?scene=awaiting&players=8');
    await page.waitForTimeout(350);
    const frameSample = page.evaluate(() => new Promise<{ frames: number[]; longTasks: number[] }>((resolve) => {
      const frames: number[] = [];
      const longTasks: number[] = [];
      const observer = 'PerformanceObserver' in window ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))) : undefined;
      try { observer?.observe({ entryTypes: ['longtask'] }); } catch { /* Long Tasks are optional in some WebViews. */ }
      let previous = performance.now();
      const started = previous;
      const sample = (now: number) => {
        frames.push(now - previous);
        previous = now;
        if (now - started >= 1_250) {
          observer?.disconnect();
          resolve({ frames, longTasks });
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    await page.locator('.deck-card:not(:disabled)').click();
    const sample = await frameSample;
    const frames = sample.frames.slice(2).sort((first, second) => first - second);
    trials.push({
      median: frames[Math.floor(frames.length * .5)] ?? 0,
      p95: frames[Math.floor(frames.length * .95)] ?? 0,
      worst: frames.at(-1) ?? 0,
      over25: frames.filter((duration) => duration > 25).length,
      over50: frames.filter((duration) => duration > 50).length,
      samples: frames.length,
      longestTask: Math.max(0, ...sample.longTasks),
    });
    await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
    await expect(page.locator('.drawn-actions')).toHaveCSS('opacity', '1');
  }

  await testInfo.attach('mobile-frame-trials.json', { body: JSON.stringify(trials, null, 2), contentType: 'application/json' });
  const healthy = trials.filter((trial) => trial.p95 <= 35 && trial.worst <= 120 && trial.over25 / trial.samples <= .2 && trial.longestTask <= 120);
  expect(healthy.length, `At least two clean trials are required; measurements: ${JSON.stringify(trials)}`).toBeGreaterThanOrEqual(2);
});

test('core mobile interactions remain inside the frame budget', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  const flows = [
    { name: 'replacement', scene: 'drawn', target: '.self-zone .playing-card.interactive' },
    { name: 'stack', scene: 'awaiting', target: '.self-zone .playing-card.interactive' },
    { name: 'penalty', scene: 'stack-wrong', target: '.self-zone .playing-card.interactive' },
    { name: 'power-target', scene: 'opponent-select', target: '.target-focus-control' },
  ] as const;
  const measurements: Record<string, { median: number; p95: number; worst: number; over25: number; over50: number; samples: number; longestTask: number }> = {};

  for (const flow of flows) {
    await page.goto(`/__visual-audit?scene=${flow.scene}&players=8`);
    await page.waitForTimeout(260);
    const frameSample = page.evaluate(() => new Promise<{ frames: number[]; longTasks: number[] }>((resolve) => {
      const frames: number[] = [];
      const longTasks: number[] = [];
      const observer = 'PerformanceObserver' in window ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration))) : undefined;
      try { observer?.observe({ entryTypes: ['longtask'] }); } catch { /* Long Tasks are optional in some WebViews. */ }
      let previous = performance.now();
      const started = previous;
      const sample = (now: number) => {
        frames.push(now - previous);
        previous = now;
        if (now - started >= 1_100) {
          observer?.disconnect();
          resolve({ frames, longTasks });
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    await page.locator(flow.target).first().click();
    const sample = await frameSample;
    const frames = sample.frames.slice(2).sort((first, second) => first - second);
    const measurement = {
      median: frames[Math.floor(frames.length * .5)] ?? 0,
      p95: frames[Math.floor(frames.length * .95)] ?? 0,
      worst: frames.at(-1) ?? 0,
      over25: frames.filter((duration) => duration > 25).length,
      over50: frames.filter((duration) => duration > 50).length,
      samples: frames.length,
      longestTask: Math.max(0, ...sample.longTasks),
    };
    measurements[flow.name] = measurement;
    expect(measurement.p95, `${flow.name} p95 frame time`).toBeLessThanOrEqual(35);
    expect(measurement.worst, `${flow.name} worst frame time`).toBeLessThanOrEqual(120);
    expect(measurement.over25 / measurement.samples, `${flow.name} slow-frame ratio`).toBeLessThanOrEqual(.2);
  }

  console.log(`MOBILE_FLOW_FRAMES ${JSON.stringify(measurements)}`);
  await testInfo.attach('mobile-flow-frames.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('draw landing never flashes an empty panel and decisions acknowledge immediately', async ({ page }) => {
  await page.goto('/__visual-audit?scene=awaiting&players=2&latency=450');
  await page.locator('.deck-card').click();
  await expect(page.locator('.card-flight')).toHaveCount(1);
  const landingState = await page.evaluate(() => ({
    panelOpacity: Number(getComputedStyle(document.querySelector<HTMLElement>('.drawn-panel')!).opacity),
    flightOpacity: Number(getComputedStyle(document.querySelector<HTMLElement>('.card-flight')!).opacity),
    drawnLabel: document.querySelector<HTMLElement>('.drawn-panel .playing-card')?.getAttribute('aria-label'),
  }));
  expect(landingState.drawnLabel).toMatch(/ of /i);
  if (landingState.flightOpacity > .08) expect(landingState.panelOpacity).toBeLessThan(.12);
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0, { timeout: 2_000 });
  await expect(page.locator('.drawn-actions')).toHaveCSS('opacity', '1');

  await page.getByRole('button', { name: /^discard$/i }).click();
  await expect(page.getByRole('button', { name: /discarding/i })).toBeVisible();
  await expect(page.locator('.turn-banner')).toContainText('Sending discard…');
  await expect(page.locator('.card-flight[data-flight-to="Discard"]')).toHaveCount(1);

  await page.goto('/__visual-audit?scene=drawn&players=2&latency=450');
  await page.locator('.self-zone .playing-card').first().click();
  await expect(page.locator('.swap-slot-cue')).toContainText('Replacing…');
  await expect(page.locator('.turn-banner')).toContainText('Replacing card…');
  await expect(page.locator('.card-flight')).toHaveCount(2);
});

test('a completed mobile decision never leaves the clipped table horizontally shifted', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/__visual-audit?scene=awaiting&players=8');
    await page.locator('.deck-card:not(:disabled)').click();
    await page.getByRole('button', { name: /^discard$/i }).click();
    await page.waitForTimeout(120);
    const geometry = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.game-page')!;
      const hands = [...document.querySelectorAll<HTMLElement>('.opponent-rail .player-hand')].map((hand) => hand.getBoundingClientRect());
      const cue = document.querySelector<HTMLElement>('.table-action-cue')?.getBoundingClientRect();
      const piles = document.querySelector<HTMLElement>('.pile-zone')?.getBoundingClientRect();
      return {
        tableScrollLeft: table.scrollLeft,
        tableLeft: table.getBoundingClientRect().left,
        tableRight: table.getBoundingClientRect().right,
        allHandsVisible: hands.every((hand) => hand.left >= -1 && hand.right <= innerWidth + 1),
        cueOverlapsPiles: Boolean(cue && piles && cue.left < piles.right && cue.right > piles.left && cue.top < piles.bottom && cue.bottom > piles.top),
      };
    });
    expect(geometry.tableScrollLeft, `${viewport.width}px table retained a hidden horizontal offset`).toBe(0);
    expect(geometry.tableLeft).toBeGreaterThanOrEqual(-1);
    expect(geometry.tableRight).toBeLessThanOrEqual(viewport.width + 1);
    expect(geometry.allHandsVisible, `${viewport.width}px clipped an opponent after the decision`).toBe(true);
    if (viewport.height > 680) expect(geometry.cueOverlapsPiles, 'the activity cue covered the central card landing').toBe(false);
  }
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
    if (viewport.width <= 500) {
      await page.locator('[data-player-seat="player-7"] .target-focus-control').click();
      await page.locator('.dense-target-panel .playing-card[data-slot="3"]').click();
    } else {
      await page.locator('.opponent-rail [data-card-id="p7-card-3"]').click();
    }
    await expect(page.locator('.card-flight')).toHaveCount(2);
    const origins = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
      transform: window.getComputedStyle(element).transform,
    })));
    await page.waitForTimeout(180);
    const moved = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => ({
      left: (element as HTMLElement).style.left,
      top: (element as HTMLElement).style.top,
      transform: window.getComputedStyle(element).transform,
      bounds: element.getBoundingClientRect().toJSON(),
    })));
    await expect(page.locator('.table-action-cue')).toContainText('Blind swap');
    await expect(page.locator('.table-action-cue')).toContainText('Devin BR');
    await expect(page.locator('.table-action-cue')).toContainText('Brian TL');
    await expect(page.locator('.player-hand.active-turn')).toHaveCount(1);
    await expect(page.locator('.player-hand.active-turn .seat-name')).toContainText('Alex');
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

test('resizing during a card flight cancels stale geometry and reveals the authoritative layout', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=blind-opponent&players=8');
  await page.locator('[data-player-seat="player-7"] .target-focus-control').click();
  await page.locator('.dense-target-panel .playing-card[data-slot="3"]').click();
  await expect(page.locator('.card-flight')).toHaveCount(2);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
  await expect(page.locator('.game-page.motion-locked')).toHaveCount(0);
  await expect(page.locator('.flight-receiving, .selected')).toHaveCount(0);
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - innerWidth,
    y: document.documentElement.scrollHeight - innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);
});

test('reduced-motion preference removes travel animation without delaying the decision', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=awaiting&players=8');
  await page.locator('.deck-card:not(:disabled)').click();
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
  await expect(page.locator('.drawn-actions')).toHaveCSS('opacity', '1');
  await expect(page.getByRole('button', { name: /^discard$/i })).toBeEnabled();

  await page.goto('/__visual-audit?scene=stack-wrong&players=8');
  await page.locator('.self-zone [data-card-id="p0-card-0"]').click();
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
  await expect(page.locator('.stack-result')).toContainText(/no match.*penalty card/i);
  await expect(page.locator('.self-zone .hand-slot')).toHaveCount(5);

  await page.goto('/__visual-audit?scene=transfer&players=8');
  await expect(page.locator('.interaction-prompt')).toContainText(/give one card/i);
  await expect(page.locator('.self-zone .playing-card.target-option')).toHaveCount(4);

  await page.goto('/__visual-audit?scene=black-choice&players=8');
  await expect(page.locator('.interaction-prompt')).toContainText(/choose whether these two cards switch places/i);
  await page.getByRole('button', { name: /keep positions/i }).click();
  await expect(page.locator('.interaction-prompt')).toHaveCount(0);

  await page.goto('/__visual-audit?scene=ending&players=8');
  await expect(page.locator('.turn-banner')).toContainText(/cambrio called/i);
  await expect(page.locator('.turn-banner')).toContainText(/turns? after this one/i);
  await page.goto('/__visual-audit?scene=results-tie&players=8');
  await expect(page.locator('.results-page')).toContainText(/win/i);
});

test('a wrong stack visibly deals its penalty from the deck to the exact stable slot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=stack-wrong&players=8');
  await page.locator('.self-zone [data-card-id="p0-card-0"]').click();
  const flight = page.locator('.card-flight');
  await expect(flight).toHaveCount(1);
  await expect(flight).toHaveAttribute('data-flight-from', 'Deck');
  await expect(flight).toHaveAttribute('data-flight-to', 'Brian +1');
  await expect(page.locator('[role="status"].sr-only')).toContainText('Brian received a penalty card');
  await expect(page.locator('.self-zone .hand-slot')).toHaveCount(5);
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0, { timeout: 1_500 });
});
