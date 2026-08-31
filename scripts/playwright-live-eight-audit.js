/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const outputRoot = 'output/playwright/live';
  const roomNames = ['Brian', 'Alex', 'Maya', 'Jordan', 'Sam', 'Chris', 'Taylor', 'Devin'];
  const guestContexts = [];
  const pages = [page];
  const baseUrl = await page.evaluate(() => window.location.origin === 'null' ? 'http://localhost:5173' : window.location.origin);

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl);
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
    const knownCards = [];
    for (const [playerIndex, playerPage] of pages.entries()) {
      const hold = playerPage.locator('.hold-button');
      await hold.waitFor();
      await hold.dispatchEvent('pointerdown', { pointerId: playerIndex + 1, pointerType: 'touch', isPrimary: true });
      await playerPage.locator('.peek-hand .playing-card:not(.face-down)').first().waitFor();
      const cards = await playerPage.locator('.peek-hand .playing-card:not(.face-down)[data-card-id]').evaluateAll((elements) => elements.map((element) => ({
        id: element.getAttribute('data-card-id'),
        rank: element.getAttribute('aria-label')?.split(' of ')[0],
      })).filter((card) => card.id && card.rank));
      await hold.dispatchEvent('pointerup', { pointerId: playerIndex + 1, pointerType: 'touch', isPrimary: true });
      await playerPage.locator('.waiting-ready, .game-page').first().waitFor();
      knownCards.push(cards);
    }
    await Promise.all(pages.map((playerPage) => playerPage.locator('.game-page').waitFor()));
    await queuePage.getByRole('heading', { name: 'Round in progress.' }).waitFor();
    await queuePage.getByRole('button', { name: 'Leave queue' }).click();
    await queuePage.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor();
    if (queuePage.url() !== `${baseUrl}/`) throw new Error(`Leaving the active queue kept the stale room URL: ${queuePage.url()}`);

    for (const playerPage of pages) await playerPage.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(250);
    if (await page.locator('.toast').count()) throw new Error('A lobby toast survived into the live game and covered the local hand.');
    if (await page.locator('.opponent-rail .player-hand').count() !== 7) throw new Error('The live eight-player table does not show seven opponents.');
    const portraitGeometries = await Promise.all(pages.map((playerPage) => playerPage.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      bodyHeight: document.body.scrollHeight,
      viewportHeight: window.innerHeight,
      visibleHands: [...document.querySelectorAll('.opponent-rail .player-hand')].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.left >= -1 && box.right <= window.innerWidth + 1;
      }).length,
    }))));
    const badPortrait = portraitGeometries.find((geometry) => geometry.bodyWidth > geometry.viewportWidth + 1 || geometry.visibleHands !== 7);
    if (badPortrait) throw new Error(`Eight-player portrait overflow: ${JSON.stringify(portraitGeometries)}`);
    await page.screenshot({ path: `${outputRoot}/real-8p-playing-320x568.png` });
    for (const playerPage of pages) await playerPage.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(180);

    let observedSwapFlights = 0;
    let opponentStack = false;
    let penalty = false;
    let transfer = false;
    let stackActorCue;
    const turnOwners = [];
    for (let turn = 0; turn < 24 && (turn < 8 || !opponentStack || !penalty); turn += 1) {
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
      turnOwners.push(roomNames[pages.indexOf(activePage)]);

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
        const observed = Array(pages.length).fill(false);
        for (let sample = 0; sample < 18 && observed.some((value) => !value); sample += 1) {
          const counts = await Promise.all(pages.map((playerPage) => playerPage.locator('.swap-flight-layer.replace .card-flight').count()));
          counts.forEach((count, index) => { if (count === 2) observed[index] = true; });
          if (observed.some((value) => !value)) await page.waitForTimeout(80);
        }
        if (observed.some((value) => !value)) throw new Error(`A two-way hand replacement was not animated for every player: ${observed.join(',')}`);
        observedSwapFlights += observed.filter(Boolean).length;
      } else {
        await activePage.getByRole('button', { name: 'Discard', exact: true }).click();
      }

      await page.waitForTimeout(120);
      const discardRank = (await page.locator('[data-table-zone="discard"] .current-discard .playing-card:not(.face-down)').getAttribute('aria-label'))?.split(' of ')[0];
      const availableKnown = [];
      for (let ownerIndex = 0; ownerIndex < pages.length; ownerIndex += 1) {
        for (const card of knownCards[ownerIndex]) {
          if (await pages[ownerIndex].locator(`.self-zone [data-card-id='${card.id}']`).count()) availableKnown.push({ ...card, ownerIndex });
        }
      }
      let stackResolvedThisDiscard = false;
      const matching = discardRank && availableKnown.find((card) => card.rank === discardRank);
      if (!opponentStack && matching) {
        for (let stackerIndex = 0; stackerIndex < pages.length; stackerIndex += 1) {
          if (stackerIndex === matching.ownerIndex) continue;
          const target = pages[stackerIndex].locator(`.opponent-rail [data-card-id='${matching.id}'].interactive`);
          if (!await target.count()) continue;
          await target.click();
          await pages[stackerIndex].locator('.transfer-prompt').waitFor({ state: 'attached' });
          stackActorCue = await page.locator('.table-action-cue.stack').innerText();
          if (!stackActorCue.toLowerCase().includes(roomNames[stackerIndex].toLowerCase())) throw new Error(`Opponent stack named the card owner instead of the actor: ${stackActorCue}`);
          await pages[stackerIndex].locator('.self-zone .playing-card.interactive').first().click();
          await pages[stackerIndex].locator('.transfer-prompt').waitFor({ state: 'detached' });
          opponentStack = true;
          transfer = true;
          stackResolvedThisDiscard = true;
          break;
        }
      }
      if (!penalty && !stackResolvedThisDiscard && discardRank) {
        const mismatch = availableKnown.find((card) => card.rank !== discardRank);
        if (mismatch) {
          const target = pages[mismatch.ownerIndex].locator(`.self-zone [data-card-id='${mismatch.id}'].interactive`);
          if (await target.count()) {
            await target.click();
            await pages[mismatch.ownerIndex].locator('.stack-result.wrong').waitFor();
            await page.locator('.table-action-cue.penalty').waitFor();
            penalty = true;
          }
        }
      }
      await activePage.waitForTimeout(120);
      const skip = activePage.getByRole('button', { name: 'Skip ability' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.waitForTimeout(1_400);
    }
    if (new Set(turnOwners).size !== 8) throw new Error(`A full rotation did not give every seat one turn: ${turnOwners.join(' -> ')}`);
    if (!opponentStack || !transfer) throw new Error('The controlled full round never completed an opponent-card stack and mandatory transfer.');
    if (!penalty) throw new Error('The controlled full round never completed a known-wrong stack penalty.');

    const reconnectPage = pages[4];
    await reconnectPage.context().setOffline(true);
    // Socket.IO detects an offline WebSocket on its heartbeat; the hosted HTTP
    // transport detects it on the next two polls. Cover both without flaking.
    await reconnectPage.getByText('Reconnecting').waitFor({ timeout: 45_000 });
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

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Call Cambrio' }).click();
    await Promise.all(pages.map((playerPage) => playerPage.getByText('CAMBRIO CALLED').waitFor()));
    await page.waitForTimeout(260);
    await page.screenshot({ path: `${outputRoot}/real-8p-final-round-390x844.png` });

    let finalTurns = 0;
    // A Cambrio caller may be ahead of the current actor. The authoritative
    // queue can therefore include the path to the caller plus one full final
    // rotation (up to 15 turns in an eight-player room).
    for (; finalTurns < 18; finalTurns += 1) {
      if (await page.locator('.results-page').count()) break;
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
      if (!activePage) {
        if (await page.locator('.results-page').count()) break;
        throw new Error(`The eight-player final rotation stalled before turn ${finalTurns + 1}.`);
      }
      await activePage.locator('.deck-card:not(:disabled)').click();
      await activePage.getByRole('button', { name: 'Discard', exact: true }).click();
      await activePage.waitForTimeout(120);
      const skip = activePage.getByRole('button', { name: 'Skip ability' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.waitForTimeout(180);
    }

    await Promise.all(pages.map((playerPage) => playerPage.locator('.results-page').waitFor()));
    for (const playerPage of pages) {
      if (await playerPage.locator('.result-row').count() !== 8) throw new Error('An eight-player result projection omitted a seat.');
      if (await playerPage.locator('.result-cards .playing-card.face-down').count()) throw new Error('A result projection retained a hidden card.');
    }
    await page.screenshot({ path: `${outputRoot}/real-8p-results-390x844.png`, fullPage: true });
    await page.getByRole('button', { name: /return to lobby|play another round/i }).click();
    await Promise.all(pages.map((playerPage) => playerPage.getByRole('heading', { name: 'Players' }).waitFor()));
    if (await page.locator('.table-action-cue, .swap-flight-layer, .stack-result').count()) throw new Error('A transient game layer survived the eight-player rematch transition.');
    await page.screenshot({ path: `${outputRoot}/real-8p-rematch-390x844.png`, fullPage: true });

    return { players: pages.length, queueLifecycle: true, realTurns: turnOwners.length, turnOwners, observedSwapFlights, opponentStack, stackActorCue, penalty, transfer, portraitGeometries, landscapeOverflow, reconnect: true, cambrio: true, finalTurns, results: true, rematch: true };
  } finally {
    await Promise.all(guestContexts.map((context) => context.close()));
  }
}
