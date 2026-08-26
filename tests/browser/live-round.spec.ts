import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

async function isolatedPage(browser: Browser, viewport = { width: 390, height: 844 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  return { context, page };
}

async function enterName(page: Page, name: string) {
  await page.getByLabel('Your display name').fill(name);
}

async function completeInitialPeek(page: Page) {
  const hold = page.getByRole('button', { name: /hold to peek/i });
  await hold.focus();
  await page.keyboard.down('Space');
  const revealed = page.locator('.peek-hand .playing-card:not(.face-down)');
  await expect(revealed).toHaveCount(2);
  expect((await revealed.evaluateAll((cards) => cards.map((card) => Number((card as HTMLElement).dataset.slot)).sort()))).toEqual([2, 3]);
  await page.keyboard.up('Space');
  await expect(page.locator('.peek-hand .playing-card:not(.face-down)')).toHaveCount(0);
  await expect(page.locator('.waiting-ready, .game-page')).toBeVisible();
}

async function playSafeTurn(pages: Page[]) {
  let active: Page | undefined;
  for (const page of pages) {
    if (await page.locator('.turn-banner.your-turn').isVisible().catch(() => false)) {
      active = page;
      break;
    }
  }
  if (!active) throw new Error('No browser owns the active turn.');
  await active.locator('.deck-card').click();
  await expect(active.locator('.drawn-panel')).toBeVisible();
  await active.getByRole('button', { name: /^discard$/i }).click();
  const skip = active.getByRole('button', { name: /skip ability/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

test('two real browsers complete home, lobby, peek, ending, results, and rematch', async ({ browser }) => {
  const host = await isolatedPage(browser);
  const guest = await isolatedPage(browser);
  const waiter = await isolatedPage(browser, { width: 320, height: 568 });
  try {
    await host.page.goto('/');
    await enterName(host.page, 'Host Player');
    await host.page.getByLabel('Your display name').press('Enter');
    await expect(host.page).toHaveURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    const code = host.page.url().split('/').at(-1)!;
    await expect(host.page.getByRole('heading', { name: new RegExp(code) })).toBeVisible();
    await host.page.getByRole('button', { name: /how to play cambrio/i }).click();
    await expect(host.page.getByRole('dialog', { name: /remember\. trade\. stack\./i })).toBeVisible();
    await host.page.keyboard.press('Escape');
    await expect(host.page.getByRole('dialog', { name: /remember\. trade\. stack\./i })).toHaveCount(0);

    await guest.page.addInitScript(() => localStorage.setItem('cambrio:name', 'Guest Player'));
    await guest.page.goto(`/room/${code}`);
    await expect(guest.page.getByText(/guest player \(you\)/i)).toBeVisible();
    await guest.page.getByRole('button', { name: /ready up/i }).click();
    await expect(host.page.getByRole('button', { name: /deal the cards/i })).toBeEnabled();
    await host.page.getByRole('button', { name: /deal the cards/i }).click();

    await Promise.all([completeInitialPeek(host.page), completeInitialPeek(guest.page)]);
    await expect(host.page.locator('.game-page')).toBeVisible();
    await host.page.getByRole('button', { name: /how to play cambrio/i }).click();
    await expect(host.page.getByText('Fast, public, and risky')).toBeVisible();
    await host.page.keyboard.press('Escape');
    await expect(host.page.locator('.game-page')).toBeVisible();

    await waiter.page.goto(`/room/${code}`);
    await enterName(waiter.page, 'Next Player');
    await waiter.page.getByRole('button', { name: /join room/i }).click();
    await expect(waiter.page.getByRole('heading', { name: /round in progress/i })).toBeVisible();
    await expect(waiter.page.getByText('#1')).toBeVisible();
    await expect(waiter.page.getByText('2', { exact: true })).toBeVisible();

    await host.page.getByRole('button', { name: /call cambrio/i }).click();
    await expect(host.page.getByText(/cambrio called/i)).toBeVisible();

    for (let turn = 0; turn < 6; turn += 1) {
      if (await host.page.locator('.results-page').isVisible().catch(() => false)) break;
      await playSafeTurn([host.page, guest.page]);
    }
    await expect(host.page.locator('.results-page')).toBeVisible();
    await expect(guest.page.locator('.results-page')).toBeVisible();
    await expect(host.page.locator('.result-row')).toHaveCount(2);
    await host.page.getByRole('button', { name: /return to lobby/i }).click();
    await expect(host.page.getByRole('heading', { name: new RegExp(code) })).toBeVisible();
    await expect(guest.page.getByRole('button', { name: /ready up/i })).toBeVisible();
    await expect(waiter.page.getByRole('button', { name: /ready up/i })).toBeVisible();
    await expect(host.page.locator('.lobby-player')).toHaveCount(3);
  } finally {
    await Promise.all([host.context.close(), guest.context.close(), waiter.context.close()]);
  }
});

test('eight seats and a ninth-browser queue fit compact phones and deal without overflow', async ({ browser }) => {
  test.setTimeout(90_000);
  const browsers = await Promise.all(Array.from({ length: 9 }, () => isolatedPage(browser, { width: 320, height: 568 })));
  const players = browsers.slice(0, 8);
  const waiter = browsers[8].page;
  try {
    const host = players[0].page;
    await host.goto('/');
    await enterName(host, 'Host');
    await host.getByRole('button', { name: /create private room/i }).click();
    await expect(host).toHaveURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
    const code = host.url().split('/').at(-1)!;

    await Promise.all(players.slice(1).map(async ({ page }, index) => {
      await page.goto(`/room/${code}`);
      await enterName(page, `Player ${index + 2}`);
      await page.getByRole('button', { name: /join room/i }).click();
      await page.getByRole('button', { name: /ready up/i }).click();
    }));

    await expect(host.locator('.lobby-player')).toHaveCount(8);
    await expect(host.getByText('8/8 seated')).toBeVisible();
    await expect(host.getByRole('button', { name: /deal the cards/i })).toBeInViewport();
    const lobbyOverflow = await host.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(lobbyOverflow).toBeLessThanOrEqual(1);

    await waiter.goto(`/room/${code}`);
    await enterName(waiter, 'Player 9');
    await waiter.getByRole('button', { name: /join room/i }).click();
    await expect(waiter.getByRole('heading', { name: /table is full/i })).toBeVisible();
    await expect(waiter.getByText('#1')).toBeVisible();
    await expect(waiter.getByText('8', { exact: true })).toBeVisible();
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
    ]) {
      await waiter.setViewportSize(viewport);
      const queueOverflow = await waiter.evaluate(() => ({
        x: document.documentElement.scrollWidth - window.innerWidth,
        y: document.documentElement.scrollHeight - window.innerHeight,
      }));
      expect(queueOverflow.x, `queue overflows ${viewport.width}x${viewport.height} horizontally`).toBeLessThanOrEqual(1);
      expect(queueOverflow.y, `queue overflows ${viewport.width}x${viewport.height} vertically`).toBeLessThanOrEqual(1);
      await expect(waiter.getByRole('button', { name: /leave queue/i })).toBeInViewport();
    }
    await waiter.getByRole('button', { name: /leave queue/i }).click();
    await expect(waiter.getByRole('button', { name: /create private room/i })).toBeVisible();

    await host.getByRole('button', { name: /deal the cards/i }).click();
    await Promise.all(players.map(({ page }) => completeInitialPeek(page)));
    await expect(host.locator('.game-page')).toBeVisible();
    const tableOverflow = await host.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(tableOverflow.x).toBeLessThanOrEqual(1);
    expect(tableOverflow.y).toBeLessThanOrEqual(1);
  } finally {
    await Promise.all(browsers.map(({ context }) => context.close()));
  }
});
