/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const findActivePage = async (pages) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      for (const candidate of pages) if (await candidate.locator('.deck-card:not(:disabled)').count()) return candidate;
      await pages[0].waitForTimeout(100);
    }
    throw new Error('No active turn appeared after the opening peek.');
  };
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:5173');
    await page.mouse.up();
    await page.getByRole('textbox', { name: 'Your display name' }).fill('Brian');
    await page.getByRole('button', { name: 'Create private room' }).click();
    await page.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    const roomUrl = page.url();
    await guest.goto(roomUrl);
    await guest.getByRole('textbox', { name: 'Your display name' }).fill('Alex');
    await guest.getByRole('button', { name: 'Join room' }).click();
    await guest.getByRole('button', { name: 'Ready up' }).click();
    await page.getByRole('button', { name: 'Deal the cards' }).click();

    // Simulate a phone losing network during the held opening peek, then being
    // reloaded from the room link. The second page must receive card backs only.
    const hold = page.getByRole('button', { name: 'Hold to peek' });
    await hold.hover();
    await page.mouse.down();
    await page.locator('.peek-screen.holding').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.peek-hand .playing-card:not(.face-down)').length === 2);
    if (await page.locator('.peek-hand .playing-card:not(.face-down)').count() !== 2) throw new Error('The held opening peek did not reveal exactly two cards.');
    await page.context().setOffline(true);
    await page.reload({ timeout: 2_500 }).catch(() => undefined);
    await guest.getByText('Game paused').waitFor({ timeout: 25_000 });
    await page.context().setOffline(false);
    await page.goto(roomUrl);
    await page.getByRole('button', { name: 'Hold to peek' }).waitFor({ timeout: 12_000 });
    if (await page.locator('.peek-hand .playing-card:not(.face-down)').count()) throw new Error('A hard reload restored private opening faces without another hold.');
    const semanticIds = await page.locator('.peek-hand .playing-card.face-down[data-card-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-card-id')).filter((id) => /^(?:A|[2-9]|10|J|Q|K)-/.test(id ?? '')));
    if (semanticIds.length) throw new Error('A hard reload restored semantic hidden-card identifiers.');

    await Promise.all([page, guest].map(async (playerPage) => {
      await playerPage.getByRole('button', { name: 'Hold to peek' }).click();
      await playerPage.locator('.game-page').waitFor();
    }));

    // Reload after drawing but before deciding. The exact private draw and deck
    // count must survive once, with no second draw and no loss of the turn.
    const active = await findActivePage([page, guest]);
    const beforeCount = Number(await active.locator('.deck-card small').textContent());
    await active.locator('.deck-card:not(:disabled)').click();
    await active.locator('.drawn-panel').waitFor();
    const drawnLabel = await active.locator('.drawn-panel .playing-card').getAttribute('aria-label');
    const afterDrawCount = Number(await active.locator('.deck-card small').textContent());
    if (afterDrawCount !== beforeCount - 1) throw new Error(`Drawing changed the deck by ${beforeCount - afterDrawCount} cards.`);
    await active.reload();
    await active.locator('.drawn-panel').waitFor({ timeout: 12_000 });
    const restoredLabel = await active.locator('.drawn-panel .playing-card').getAttribute('aria-label');
    const restoredCount = Number(await active.locator('.deck-card small').textContent());
    if (restoredLabel !== drawnLabel || restoredCount !== afterDrawCount) throw new Error(`Reload changed the pending decision: ${drawnLabel}/${afterDrawCount} -> ${restoredLabel}/${restoredCount}.`);
    if (await active.locator('.deck-card:not(:disabled)').count()) throw new Error('Reload allowed a second draw during the same turn.');
    await active.getByRole('button', { name: 'Discard', exact: true }).click();
    await active.locator('.drawn-panel').waitFor({ state: 'detached' });

    return { openingFacesRevoked: true, sameSeatRestored: true, drawnDecisionRestored: drawnLabel, duplicateDraws: 0 };
  } finally {
    await guestContext.close();
  }
}
