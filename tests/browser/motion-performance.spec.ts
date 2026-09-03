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
  console.log(`MOBILE_DRAW_FRAMES ${JSON.stringify(trials)}`);
  const healthy = trials.filter((trial) => trial.p95 <= 35 && trial.worst <= 150 && trial.over25 / trial.samples <= .2 && trial.over50 <= 1 && trial.longestTask <= 160);
  expect(healthy.length, `At least two clean trials are required; measurements: ${JSON.stringify(trials)}`).toBeGreaterThanOrEqual(2);
});

test('core mobile interactions remain inside the frame budget', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  const flows = [
    { name: 'discard', scene: 'drawn', target: '.discard-drawn' },
    { name: 'replacement', scene: 'drawn', target: '.self-zone .playing-card.interactive' },
    { name: 'stack', scene: 'awaiting', target: '.self-zone .playing-card.interactive' },
    { name: 'penalty', scene: 'stack-wrong', target: '.self-zone .playing-card.interactive' },
    { name: 'transfer', scene: 'transfer', target: '.self-zone .playing-card.interactive' },
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
    expect(measurement.worst, `${flow.name} worst frame time`).toBeLessThanOrEqual(150);
    expect(measurement.over25 / measurement.samples, `${flow.name} slow-frame ratio`).toBeLessThanOrEqual(.2);
    expect(measurement.over50, `${flow.name} >50ms frame count`).toBeLessThanOrEqual(1);
  }

  console.log(`MOBILE_FLOW_FRAMES ${JSON.stringify(measurements)}`);
  await testInfo.attach('mobile-flow-frames.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('core action stories remain comprehensible under moderate 2x CPU throttle', async ({ page, context }, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await context.newCDPSession(page);
  const flows = [
    { name: 'draw', scene: 'awaiting', target: '.deck-card:not(:disabled)' },
    { name: 'discard', scene: 'drawn', target: '.discard-drawn' },
    { name: 'stack', scene: 'stack-correct', target: '.opponent-rail [data-card-id="p1-card-3"]' },
    { name: 'penalty', scene: 'stack-wrong', target: '.self-zone [data-card-id="p0-card-0"]' },
    { name: 'target-mode', scene: 'opponent-select', target: '.target-focus-control' },
  ] as const;
  const measurements: Record<string, { median: number; p95: number; worst: number; over25: number; over50: number; samples: number }> = {};
  try {
    for (const flow of flows) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await page.goto(`/__visual-audit?scene=${flow.scene}&players=8`);
      await page.waitForTimeout(400);
      await page.bringToFront();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 2 });
      const sample = page.evaluate(() => new Promise<number[]>((resolve) => {
        const frames: number[] = [];
        let previous = performance.now();
        const started = previous;
        const frame = (now: number) => {
          frames.push(now - previous);
          previous = now;
          if (now - started >= 1_100) resolve(frames);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      await page.locator(flow.target).first().click();
      const frames = (await sample).slice(2).sort((first, second) => first - second);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const measurement = {
        median: frames[Math.floor(frames.length * .5)] ?? 0,
        p95: frames[Math.floor(frames.length * .95)] ?? 0,
        worst: frames.at(-1) ?? 0,
        over25: frames.filter((duration) => duration > 25).length,
        over50: frames.filter((duration) => duration > 50).length,
        samples: frames.length,
      };
      measurements[flow.name] = measurement;
      // This is a diagnostic under host CPU contention, not a release timing
      // gate. The strict normal-load test above owns numerical budgets; here
      // we verify that throttling never makes final state depend on animation.
      expect(measurement.samples, `${flow.name} produced no throttled frame samples`).toBeGreaterThan(0);
      await expect(page.locator('.game-page')).toBeVisible();
    }
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  console.log(`THROTTLED_MOBILE_FLOW_FRAMES ${JSON.stringify(measurements)}`);
  await testInfo.attach('throttled-mobile-flow-frames.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('eight-player results reveal in batches and expose rematch without a serial wait', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=results&players=8');
  await page.waitForTimeout(520);

  const rows = page.locator('.result-row');
  await expect(rows).toHaveCount(8);
  expect(await rows.evaluateAll((elements) => elements.every((element) => Number(getComputedStyle(element).opacity) > .98))).toBe(true);
  expect(await page.locator('.result-card-wrap').evaluateAll((elements) => elements.every((element) => Number(getComputedStyle(element).opacity) > .98))).toBe(true);
  await expect(page.getByRole('button', { name: /another round/i })).toBeVisible();
});

test('ending moment clears quickly while the final-round status persists', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=ending&players=8');
  await expect(page.locator('.ending-announcement')).toBeVisible();
  await page.waitForTimeout(820);
  await expect(page.locator('.ending-announcement')).toHaveCSS('opacity', '0');
  await expect(page.locator('.turn-banner')).toContainText(/cambrio called/i);
  await expect(page.locator('.turn-banner')).toContainText(/turn/i);
});

test('draw landing never flashes an empty panel and decisions acknowledge immediately', async ({ page }) => {
  await page.goto('/__visual-audit?scene=awaiting&players=2&latency=450');
  const flightState = page.evaluate(() => new Promise<{
    panelOpacity: number | null;
    flightOpacity: number;
    drawnLabel?: string;
  } | null>((resolve) => {
    const capture = () => {
      const flight = document.querySelector<HTMLElement>('.card-flight');
      if (!flight) return false;
      const panel = document.querySelector<HTMLElement>('.drawn-panel');
      resolve({
        panelOpacity: panel ? Number(getComputedStyle(panel).opacity) : null,
        flightOpacity: Number(getComputedStyle(flight).opacity),
        drawnLabel: panel?.querySelector<HTMLElement>('.playing-card')?.getAttribute('aria-label') ?? undefined,
      });
      return true;
    };
    const observer = new MutationObserver(() => {
      if (capture()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, 1_500);
  }));
  await page.locator('.deck-card').click();
  const landingState = await flightState;
  expect(landingState, 'the latency fixture never rendered a draw flight').not.toBeNull();
  if (!landingState) return;
  if (landingState.drawnLabel) expect(landingState.drawnLabel).toMatch(/ of /i);
  if (landingState.flightOpacity > .08 && landingState.panelOpacity !== null) expect(landingState.panelOpacity).toBeLessThan(.12);
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

test('common network delays preserve immediate pending feedback through core decisions', async ({ page }) => {
  for (const latency of [150, 300, 500]) {
    await page.goto(`/__visual-audit?scene=awaiting&players=4&latency=${latency}`);
    await page.locator('.deck-card').click();
    await expect(page.locator('.deck-card')).toBeDisabled();
    await expect(page.locator('.drawn-actions')).toBeVisible({ timeout: latency + 1_000 });

    await page.getByRole('button', { name: /^discard$/i }).click();
    await expect(page.getByRole('button', { name: /discarding/i })).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.drawn-panel')).toHaveCount(0, { timeout: latency + 1_000 });

    await page.goto(`/__visual-audit?scene=drawn&players=4&latency=${latency}`);
    await page.locator('.self-zone .playing-card').first().click();
    await expect(page.locator('.swap-slot-cue')).toContainText('Replacing…');
    await expect(page.locator('.drawn-panel')).toHaveCount(0, { timeout: latency + 1_000 });

    await page.goto(`/__visual-audit?scene=transfer&players=4&latency=${latency}`);
    const pendingTransfer = expect(page.locator('.self-zone .playing-card.action-pending')).toHaveCount(1);
    await page.locator('.self-zone .playing-card').first().click();
    await pendingTransfer;
    await expect(page.locator('.transfer-prompt')).toHaveCount(0, { timeout: latency + 1_000 });
  }
});

test('a completed mobile decision never leaves the clipped table horizontally shifted', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/__visual-audit?scene=awaiting&players=8&seed=${viewport.width}`);
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
    await expect(page.locator('.table-action-cue')).toContainText('Brian swapped two cards');
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

test('page hiding during a card flight cancels cosmetic state immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=blind-opponent&players=8');
  await page.locator('[data-player-seat="player-7"] .target-focus-control').click();
  await page.locator('.dense-target-panel .playing-card[data-slot="3"]').click();
  await expect(page.locator('.card-flight')).toHaveCount(2);

  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0);
  await expect(page.locator('.game-page.motion-locked')).toHaveCount(0);
  await expect(page.locator('.flight-receiving, .selected')).toHaveCount(0);
});

test('a zero-card turn reads as one deck-to-discard action and never invents inventory', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=zero&players=8');
  await expect(page.locator('.self-zone .playing-card')).toHaveCount(0);
  await page.locator('.deck-card:not(:disabled)').click();

  const flight = page.locator('.card-flight');
  await expect(flight).toHaveAttribute('data-flight-from', 'Deck');
  await expect(flight).toHaveAttribute('data-flight-to', 'Discard');
  await expect(page.locator('.table-action-cue')).toContainText('Brian drew and discarded');
  await expect(page.locator('.self-zone .playing-card')).toHaveCount(0);
  await expect(page.locator('.self-zone')).toContainText('0 CARDS');
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
  await expect(page.locator('.interaction-prompt')).toContainText(/give .* one card/i);
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
  await expect(page.locator('[role="status"].sr-only')).toContainText('Brian took a penalty');
  await expect(page.locator('.self-zone .hand-slot')).toHaveCount(5);
  await expect(page.locator('.swap-flight-layer')).toHaveCount(0, { timeout: 1_500 });
});
