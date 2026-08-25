/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const outputRoot = 'output/playwright/live';
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const waitingContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  const waiting = await waitingContext.newPage();
  const pages = [page, guest];

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:5173');
    await page.getByRole('textbox', { name: 'Your display name' }).fill('Brian');
    await page.getByRole('button', { name: 'Create private room' }).click();
    await page.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    await guest.goto(page.url());
    await guest.getByRole('textbox', { name: 'Your display name' }).fill('Alex');
    await guest.getByRole('button', { name: 'Join room' }).click();
    await guest.getByRole('button', { name: 'Ready up' }).click();
    await page.getByRole('button', { name: 'Deal the cards' }).click();

    await Promise.all(pages.map(async (playerPage) => {
      await playerPage.getByRole('button', { name: 'Hold to peek' }).click();
      await playerPage.locator('.game-page').waitFor();
    }));
    for (const playerPage of pages) {
      const hiddenIds = await playerPage.locator('.playing-card.face-down[data-card-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-id')));
      if (!hiddenIds.length || hiddenIds.some((id) => /^(?:A|[2-9]|10|J|Q|K)-(?:clubs|diamonds|hearts|spades)$/.test(id ?? ''))) {
        throw new Error('A live browser received a semantic card ID for a concealed card.');
      }
    }

    await waiting.goto(page.url());
    await waiting.getByRole('textbox', { name: 'Your display name' }).fill('Maya');
    await waiting.getByRole('button', { name: 'Join room' }).click();
    await waiting.getByRole('heading', { name: 'Round in progress.' }).waitFor();
    if (await waiting.getByText('#1', { exact: true }).count() !== 1) throw new Error('The first waiting player does not have a clear queue position.');
    if (await waiting.getByText('2', { exact: true }).count() < 1) throw new Error('The waiting screen does not show the active player count.');
    await waiting.screenshot({ path: `${outputRoot}/real-waiting-player-390x844.png` });

    const caller = (await page.locator('.cambio-button').isEnabled()) && await page.locator('.turn-banner.your-turn').count() ? page : guest;
    await caller.getByRole('button', { name: 'Call Cambrio' }).click();
    await Promise.all(pages.map((playerPage) => playerPage.getByText('CAMBRIO CALLED').waitFor()));
    await caller.waitForTimeout(420);
    if (Number(await caller.locator('.ending-state').evaluate((element) => window.getComputedStyle(element).opacity)) < .9) throw new Error('The Cambrio ending state did not finish its entrance clearly.');
    if (await caller.locator('.toast').count()) throw new Error('A redundant Cambrio toast overlaps the game-native ending state.');
    await caller.screenshot({ path: `${outputRoot}/real-cambrio-called-390x844.png` });

    let finalTurns = 0;
    for (; finalTurns < 8; finalTurns += 1) {
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
        throw new Error(`The Cambrio ending stalled before final turn ${finalTurns + 1}.`);
      }
      await activePage.locator('.deck-card:not(:disabled)').click();
      await activePage.getByRole('button', { name: 'Discard', exact: true }).click();
      await activePage.waitForTimeout(180);
      const skip = activePage.getByRole('button', { name: 'Skip ability' });
      if (await skip.isVisible().catch(() => false)) await skip.click();
      await page.waitForTimeout(250);
    }

    await Promise.all(pages.map((playerPage) => playerPage.locator('.results-page').waitFor()));
    await page.waitForTimeout(320);
    for (const playerPage of pages) {
      if (await playerPage.locator('.result-row').count() !== 2) throw new Error('The live result table does not contain both players.');
      if (await playerPage.locator('.result-cards .playing-card.face-down').count()) throw new Error('A result card stayed hidden after reveal.');
      if (await playerPage.locator('.score').count() !== 2) throw new Error('The live result table is missing a score.');
      if (await playerPage.locator('.toast').count()) throw new Error('A stale game notice covers the live result screen.');
    }
    await page.screenshot({ path: `${outputRoot}/real-round-results-390x844.png` });
    await page.getByRole('button', { name: 'Return to lobby' }).click();
    await Promise.all([...pages, waiting].map((playerPage) => playerPage.getByRole('heading', { name: 'Players' }).waitFor()));
    await page.waitForTimeout(320);
    if (await guest.getByRole('button', { name: 'Ready up' }).count() !== 1) throw new Error('The guest cannot ready for a rematch.');
    if (await waiting.getByRole('button', { name: 'Ready up' }).count() !== 1) throw new Error('The promoted waiting player cannot ready for a rematch.');
    if (await page.getByText('3/8 seated').count() !== 1) throw new Error('The rematch did not promote the waiting player.');
    if (await page.locator('.toast').count()) throw new Error('The rematch confirmation covers the lobby controls.');
    await page.screenshot({ path: `${outputRoot}/real-rematch-lobby-390x844.png`, fullPage: true });

    await page.getByRole('button', { name: 'Remove Maya' }).click();
    await waiting.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor();
    await waiting.getByText('The host removed your seat from this table.').waitFor();
    await page.getByText('2/8 seated').waitFor();
    if (waiting.url() !== 'http://localhost:5173/') throw new Error(`Host removal kept the stale room URL: ${waiting.url()}`);

    await guest.getByRole('button', { name: 'Guest' }).click();
    await guest.getByRole('button', { name: 'Leave table' }).click();
    await guest.getByText('Leave this table?').waitFor();
    await guest.screenshot({ path: `${outputRoot}/real-leave-confirmation-390x844.png` });
    await guest.getByRole('button', { name: 'Leave', exact: true }).click();
    await guest.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor();
    await page.getByText('1/8 seated').waitFor();
    if (guest.url() !== 'http://localhost:5173/') throw new Error(`Leaving the table kept the stale room URL: ${guest.url()}`);

    return { players: 2, opaqueHiddenIds: true, waitingPromotion: true, hostRemoval: true, cambioCalled: true, finalTurns, resultsRevealed: true, rematchLobby: true, leaveFlow: true };
  } finally {
    await waitingContext.close();
    await guestContext.close();
  }
}
