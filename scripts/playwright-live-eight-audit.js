/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const outputRoot = 'output/playwright/live';
  const roomNames = ['Brian', 'Alex', 'Maya', 'Jordan', 'Sam', 'Chris', 'Taylor', 'Devin'];
  const guestContexts = [];
  const pages = [page];

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:5173');
    await page.getByRole('textbox', { name: 'Your display name' }).fill(roomNames[0]);
    await page.getByRole('button', { name: 'Create private room' }).click();
    await page.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    const roomUrl = page.url();

    for (const name of roomNames.slice(1)) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      guestContexts.push(context);
      const guest = await context.newPage();
      pages.push(guest);
      await guest.goto(roomUrl);
      await guest.getByRole('textbox', { name: 'Your display name' }).fill(name);
      await guest.getByRole('button', { name: 'Join room' }).click();
      await guest.getByRole('button', { name: 'Ready up' }).click();
    }

    const queueContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    guestContexts.push(queueContext);
    const queuePage = await queueContext.newPage();
    await queuePage.goto(roomUrl);
    await queuePage.getByRole('textbox', { name: 'Your display name' }).fill('Nora');
    await queuePage.getByRole('button', { name: 'Join room' }).click();
    await queuePage.getByRole('heading', { name: 'Table is full.' }).waitFor();
    if (await queuePage.getByText('#1', { exact: true }).count() !== 1) throw new Error('The full-table waiting view has no queue position.');
    await queuePage.waitForTimeout(420);
    await queuePage.screenshot({ path: `${outputRoot}/real-full-table-queue-390x844.png` });

    await page.getByText('8/8 seated').waitFor();
    const profileFits = await page.locator('.profile-chip span').evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    if (!profileFits || (await page.locator('.profile-chip span').textContent()) !== 'Guest') throw new Error('The mobile lobby truncates the Guest profile label.');
    await page.screenshot({ path: `${outputRoot}/real-8p-lobby-390x844.png`, fullPage: true });
    await page.getByRole('button', { name: 'Deal the cards' }).click();
    await Promise.all(pages.map(async (playerPage) => {
      const hold = playerPage.getByRole('button', { name: 'Hold to peek' });
      await hold.waitFor();
      await hold.click();
      await playerPage.locator('.game-page').waitFor();
    }));
    await queuePage.getByRole('heading', { name: 'Round in progress.' }).waitFor();
    await queuePage.getByRole('button', { name: 'Leave queue' }).click();
    await queuePage.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor();
    if (queuePage.url() !== 'http://localhost:5173/') throw new Error(`Leaving the active queue kept the stale room URL: ${queuePage.url()}`);

    for (const playerPage of pages) await playerPage.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(250);
    if (await page.locator('.toast').count()) throw new Error('A lobby toast survived into the live game and covered the local hand.');
    if (await page.locator('.opponent-rail .player-hand').count() !== 7) throw new Error('The live eight-player table does not show seven opponents.');
    const portraitOverflow = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      visibleHands: [...document.querySelectorAll('.opponent-rail .player-hand')].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.left >= -1 && box.right <= window.innerWidth + 1;
      }).length,
    }));
    if (portraitOverflow.bodyWidth > portraitOverflow.viewportWidth + 1 || portraitOverflow.visibleHands !== 7) throw new Error(`Eight-player portrait overflow: ${JSON.stringify(portraitOverflow)}`);
    await page.screenshot({ path: `${outputRoot}/real-8p-playing-320x568.png` });

    let observedSwapFlights = 0;
    for (let turn = 0; turn < 6; turn += 1) {
      let activePage;
      for (let attempt = 0; attempt < 30 && !activePage; attempt += 1) {
        for (const candidate of pages) {
          if (await candidate.locator('.deck-card:not(:disabled)').count()) {
            activePage = candidate;
            break;
          }
        }
        if (!activePage) await page.waitForTimeout(100);
      }
      if (!activePage) throw new Error(`No active deck found for live turn ${turn + 1}.`);

      if (turn === 0) {
        const before = await activePage.locator('.deck-card:not(:disabled)').boundingBox();
        await activePage.waitForTimeout(650);
        const after = await activePage.locator('.deck-card:not(:disabled)').boundingBox();
        if (!before || !after || Math.abs(before.x - after.x) > .5 || Math.abs(before.y - after.y) > .5) throw new Error('The live draw target moves while waiting for a tap.');
      }

      await activePage.locator('.deck-card:not(:disabled)').click();
      await activePage.locator('.drawn-panel').waitFor();
      if (turn % 2 === 0) {
        await activePage.locator('.self-zone .playing-card.interactive').first().click();
        await page.waitForTimeout(220);
        const flightCounts = await Promise.all(pages.map((playerPage) => playerPage.locator('.swap-flight-layer.replace .card-flight').count()));
        const visibleObservers = flightCounts.filter((count) => count === 2).length;
        if (visibleObservers !== pages.length) throw new Error(`A two-way hand replacement was not animated for every player: ${flightCounts.join(',')}`);
        observedSwapFlights += visibleObservers;
      } else {
        await activePage.getByRole('button', { name: 'Discard', exact: true }).click();
        await activePage.waitForTimeout(180);
        const skip = activePage.getByRole('button', { name: 'Skip ability' });
        if (await skip.isVisible().catch(() => false)) await skip.click();
      }
      await page.waitForTimeout(1_400);
    }

    const reconnectPage = pages[4];
    await reconnectPage.context().setOffline(true);
    await reconnectPage.getByText('Reconnecting').waitFor();
    if (await reconnectPage.locator('.fatal-mark').count()) throw new Error('A temporary transport loss replaced the table with a fatal screen.');
    await reconnectPage.context().setOffline(false);
    await reconnectPage.getByText('Live').waitFor({ timeout: 10_000 });
    await reconnectPage.reload();
    await reconnectPage.locator('.game-page').waitFor();
    if (await reconnectPage.locator('.opponent-rail .player-hand').count() !== 7) throw new Error('A reconnected live player did not return to the same eight-player table.');

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(250);
    const landscapeOverflow = await page.evaluate(() => ({ width: document.body.scrollWidth, viewport: window.innerWidth, height: document.body.scrollHeight }));
    if (landscapeOverflow.width > landscapeOverflow.viewport + 1) throw new Error(`Eight-player landscape overflow: ${JSON.stringify(landscapeOverflow)}`);
    await page.screenshot({ path: `${outputRoot}/real-8p-playing-844x390.png` });

    return { players: pages.length, queueLifecycle: true, realTurns: 6, observedSwapFlights, portraitOverflow, landscapeOverflow, reconnect: true };
  } finally {
    await Promise.all(guestContexts.map((context) => context.close()));
  }
}
