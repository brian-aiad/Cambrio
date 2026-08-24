/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('The Playwright browser is unavailable.');
  const names = ['Brian', 'Alex', 'Maya', 'Jordan', 'Sam', 'Chris', 'Taylor', 'Devin'];
  const guestContexts = [];
  const guestPages = [];
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('http://localhost:5173');
    await page.getByRole('textbox', { name: 'Your display name' }).fill(names[0]);
    await page.getByRole('button', { name: 'Create private room' }).click();
    await page.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    const roomUrl = page.url();

    for (const name of names.slice(1)) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      guestContexts.push(context);
      const guest = await context.newPage();
      guestPages.push(guest);
      await guest.goto(roomUrl);
      await guest.getByRole('textbox', { name: 'Your display name' }).fill(name);
      await guest.getByRole('button', { name: 'Join room' }).click();
      await guest.getByRole('button', { name: 'Ready up' }).click();
    }

    await page.getByText('8/8 seated').waitFor();
    const verify = async (viewport) => {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(180);
      const geometry = await page.evaluate(() => {
        const deal = document.querySelector('.deal')?.getBoundingClientRect();
        const tiles = [...document.querySelectorAll('.lobby-player')].map((item) => item.getBoundingClientRect());
        return {
          width: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          deal: deal && { top: deal.top, bottom: deal.bottom, left: deal.left, right: deal.right },
          visibleTiles: tiles.filter((tile) => tile.left >= -1 && tile.right <= window.innerWidth + 1).length,
          tileColumns: new Set(tiles.map((tile) => Math.round(tile.left))).size,
        };
      });
      if (geometry.width > geometry.viewportWidth + 1 || geometry.visibleTiles !== 8 || geometry.tileColumns !== 2 || !geometry.deal || geometry.deal.top < 0 || geometry.deal.bottom > viewport.height) throw new Error(`Full lobby does not fit at ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `output/playwright/iteration/lobby-8p-${viewport.width}x${viewport.height}.png` });
      return geometry;
    };

    const phone = await verify({ width: 320, height: 568 });
    const tallPhone = await verify({ width: 390, height: 844 });
    const deal = page.getByRole('button', { name: 'Deal the cards' });
    await deal.evaluate((button) => { button.click(); button.click(); button.click(); });
    await Promise.all([page, ...guestPages].map((playerPage) => playerPage.getByRole('button', { name: 'Hold to peek' }).waitFor()));
    if (await page.locator('.peek-screen').count() !== 1) throw new Error('Rapid deal taps created an invalid game surface.');
    return { players: 8, columns: 2, phone, tallPhone, rapidDealTaps: 'coalesced' };
  } finally {
    await Promise.all(guestContexts.map((context) => context.close()));
  }
}
