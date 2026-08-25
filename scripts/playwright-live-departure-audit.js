/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const outputRoot = 'output/playwright/departures';
  const alexContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mayaContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const alex = await alexContext.newPage();
  const maya = await mayaContext.newPage();
  const players = [page, alex, maya];

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:5173');
    await page.getByRole('textbox', { name: 'Your display name' }).fill('Brian');
    await page.getByRole('button', { name: 'Create private room' }).click();
    await page.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    const roomUrl = page.url();

    for (const [guest, name] of [[alex, 'Alex'], [maya, 'Maya']]) {
      await guest.goto(roomUrl);
      await guest.getByRole('textbox', { name: 'Your display name' }).fill(name);
      await guest.getByRole('button', { name: 'Join room' }).click();
      await guest.getByRole('button', { name: 'Ready up' }).click();
    }
    await page.getByRole('button', { name: 'Deal the cards' }).click();

    // A departure during the private opening peek must freeze every timer and
    // still give the host an intentional path forward.
    await mayaContext.setOffline(true);
    await page.getByRole('button', { name: /Manage pause/ }).waitFor({ timeout: 25_000 });
    if (await page.getByRole('button', { name: 'Hold to peek' }).count()) throw new Error('Opening cards stayed interactive while a seat was disconnected.');
    await page.getByRole('button', { name: /Manage pause/ }).click();
    await page.getByRole('dialog').waitFor();
    if (await page.getByRole('button', { name: 'Forfeit hand' }).count() !== 1) throw new Error('The initial-peek recovery dialog did not identify the one missing seat.');
    await page.waitForTimeout(240);
    await page.screenshot({ path: `${outputRoot}/initial-peek-pause-390x844.png` });
    await page.getByRole('button', { name: 'Keep waiting' }).click();
    await mayaContext.setOffline(false);
    await maya.getByText('Live').waitFor({ timeout: 12_000 });
    await page.getByRole('button', { name: 'Hold to peek' }).waitFor({ timeout: 12_000 });

    await Promise.all(players.map(async (playerPage) => {
      await playerPage.getByRole('button', { name: 'Hold to peek' }).click();
      await playerPage.locator('.game-page').waitFor();
    }));

    // Two simultaneous losses must remain paused after only one seat returns.
    await Promise.all([alexContext.setOffline(true), mayaContext.setOffline(true)]);
    await page.getByRole('button', { name: /Manage pause 2/ }).waitFor({ timeout: 25_000 });
    if (await page.locator('.playing-card.interactive').count()) throw new Error('Cards stayed interactive during a two-seat pause.');
    if (await page.locator('.cambio-button').count()) throw new Error('Cambrio stayed callable during a two-seat pause.');
    await page.getByRole('button', { name: /Manage pause 2/ }).click();
    const names = await page.locator('.pause-player-list strong').allTextContents();
    if (names.slice().sort().join(',') !== 'Alex,Maya') throw new Error(`The paused seats were unclear: ${names.join(',')}`);
    await page.waitForTimeout(240);
    await page.screenshot({ path: `${outputRoot}/two-player-pause-390x844.png` });
    await page.getByRole('button', { name: 'Keep waiting' }).click();

    await alexContext.setOffline(false);
    await alex.getByText('Live').waitFor({ timeout: 12_000 });
    await page.getByRole('button', { name: /Manage pause 1/ }).waitFor({ timeout: 12_000 });
    if (await page.locator('.turn-banner.paused').count() !== 1) throw new Error('The round resumed before every missing seat returned.');
    await page.getByRole('button', { name: /Manage pause 1/ }).click();
    if (await page.locator('.pause-player-list strong').textContent() !== 'Maya') throw new Error('The recovered seat remained in the host recovery list.');
    await page.getByRole('button', { name: 'Forfeit hand' }).click();
    await page.locator('.turn-banner.paused').waitFor({ state: 'detached', timeout: 12_000 });

    // A removed offline browser must not silently recover the deleted seat.
    await mayaContext.setOffline(false);
    await maya.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor({ timeout: 15_000 });
    await maya.getByText('The host removed your seat from this table.').waitFor();
    if (maya.url() !== 'http://localhost:5173/') throw new Error(`Removed seat kept its private-room URL: ${maya.url()}`);

    // Voluntary host departure transfers host authority. The remaining player
    // can continue explicitly instead of being trapped behind a ghost seat.
    await page.locator('.profile-chip').click();
    await page.getByRole('button', { name: 'Leave table' }).click();
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await page.getByRole('heading', { name: 'Know your cards. Trust your read.' }).waitFor();
    await alex.getByRole('button', { name: /Manage pause 1/ }).waitFor({ timeout: 12_000 });
    await alex.getByRole('button', { name: /Manage pause 1/ }).click();
    if (await alex.locator('.pause-player-list strong').textContent() !== 'Brian') throw new Error('Host transfer did not expose the departed host to the new host.');
    await alex.getByRole('button', { name: 'Forfeit hand' }).click();
    await alex.locator('.results-page').waitFor({ timeout: 12_000 });
    await alex.waitForTimeout(600);
    if (await alex.locator('.result-row').count() !== 3) throw new Error('Departure results lost a player row.');
    if (await alex.locator('.result-row .score').filter({ hasText: 'Forfeit' }).count() !== 2) throw new Error('Forfeited departures were not scored clearly.');
    await alex.screenshot({ path: `${outputRoot}/host-transfer-results-390x844.png` });

    return {
      initialPeekPause: true,
      multipleDisconnects: true,
      partialReconnectStayedPaused: true,
      offlineRemoval: true,
      hostTransfer: true,
      finalRows: 3,
    };
  } finally {
    await Promise.all([alexContext.close(), mayaContext.close()]);
  }
}
