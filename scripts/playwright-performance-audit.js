/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const cold = await context.newPage();
  await cold.addInitScript(() => {
    window.__cambrioLongTasks = [];
    try {
      new PerformanceObserver((list) => window.__cambrioLongTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: 'longtask', buffered: true });
    } catch {
      // Older mobile WebViews may not expose Long Tasks; navigation timing is
      // still collected below.
    }
  });
  const cdp = await context.newCDPSession(cold);

  try {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 100, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8, connectionType: 'cellular3g' });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cold.goto('http://localhost:4173', { waitUntil: 'networkidle' });
    await cold.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor();
    const load = await cold.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
      return {
        fcp,
        domInteractive: navigation?.domInteractive ?? 0,
        loaded: navigation?.loadEventEnd ?? 0,
        transferBytes: resources.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
        jsBytes: resources.filter((entry) => entry.name.includes('.js')).reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
        requests: resources.length,
        longTasks: window.__cambrioLongTasks ?? [],
      };
    });
    const inputStart = await cold.evaluate(() => performance.now());
    await cold.getByRole('textbox', { name: 'Your display name' }).fill('Speed Test');
    await cold.getByRole('button', { name: 'Create private room' }).waitFor({ state: 'visible' });
    const inputReady = await cold.evaluate((start) => performance.now() - start, inputStart);
    if (load.fcp > 2_500 || load.domInteractive > 2_800) throw new Error(`Cold mobile load missed budget: ${JSON.stringify(load)}.`);
    if (load.jsBytes > 200 * 1024) throw new Error(`Compressed JavaScript exceeded 200KB: ${load.jsBytes}.`);
    if (inputReady > 250) throw new Error(`The first form response took ${inputReady.toFixed(1)}ms.`);

    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const motion = await context.newPage();
    const motionCdp = await context.newCDPSession(motion);
    await motionCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await motion.goto('http://localhost:5173/__visual-audit?scene=awaiting&players=8');
    await motion.waitForTimeout(800);
    const sample = motion.evaluate(() => new Promise((resolve) => {
      const frames = [];
      let previous = performance.now();
      const started = previous;
      const frame = (now) => {
        frames.push(now - previous);
        previous = now;
        if (now - started >= 1_250) resolve(frames);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }));
    await motion.locator('.deck-card:not(:disabled)').click();
    const frames = await sample;
    const settled = frames.slice(2).sort((a, b) => a - b);
    const p95 = settled[Math.floor(settled.length * .95)] ?? 0;
    const worst = settled.at(-1) ?? 0;
    const dropped = settled.filter((duration) => duration > 25).length;
    if (p95 > 30 || worst > 90 || dropped > settled.length * .15) throw new Error(`Draw animation frame budget missed: ${JSON.stringify({ p95, worst, dropped, frames: settled.length })}.`);
    await motion.close();

    return {
      mobileColdLoad: { fcp: Math.round(load.fcp), domInteractive: Math.round(load.domInteractive), loaded: Math.round(load.loaded), requests: load.requests },
      transfer: { totalKB: Math.round(load.transferBytes / 1024), javascriptKB: Math.round(load.jsBytes / 1024) },
      longTasks: load.longTasks.length,
      inputReadyMs: Math.round(inputReady),
      animation: { p95Ms: Number(p95.toFixed(1)), worstMs: Number(worst.toFixed(1)), droppedFrames: dropped, sampledFrames: settled.length },
    };
  } finally {
    await context.close();
  }
}
