import { expect, test, type BrowserContext, type Page } from '@playwright/test';

type RememberedCard = { id: string; rank: string; ownerIndex: number };

test('eight real browser contexts show one winner, one unpenalized race loser, and six converged observers', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
      contexts.push(context);
      pages.push(await context.newPage());
    }

    const host = pages[0];
    await host.goto('/');
    await host.getByLabel('Your display name').fill('Storm Host');
    await host.getByRole('button', { name: /create private room/i }).click();
    await expect(host.getByRole('heading', { name: /room/i })).toBeVisible();
    const code = (await host.locator('.lobby-heading h1 span').textContent())!.trim();

    for (let index = 1; index < pages.length; index += 1) {
      const page = pages[index];
      await page.goto(`/room/${code}`);
      await page.getByLabel('Your display name').fill(`Storm ${index + 1}`);
      await page.getByRole('button', { name: /join room/i }).click();
      await expect(page.getByRole('heading', { name: new RegExp(`Room ${code}`, 'i') })).toBeVisible();
      await page.getByRole('button', { name: /ready up/i }).click();
    }
    await expect(host.getByRole('button', { name: /deal the cards/i })).toBeEnabled();
    await host.getByRole('button', { name: /deal the cards/i }).click();
    await Promise.all(pages.map((page) => expect(page.getByRole('button', { name: /hold to peek/i })).toBeVisible()));

    const remembered = (await Promise.all(pages.map(async (page, ownerIndex) => {
      const hold = page.locator('.hold-button');
      await hold.dispatchEvent('pointerdown', { pointerType: 'mouse', button: 0 });
      const peekCards = page.locator('.peek-hand [data-peekable] .playing-card:not(.face-down)');
      await expect(peekCards).toHaveCount(2);
      const cards = await peekCards.evaluateAll((elements, index) => elements.map((element) => {
        const label = element.getAttribute('aria-label') ?? '';
        return { id: element.getAttribute('data-card-id')!, rank: label.split(' ')[0], ownerIndex: index };
      }), ownerIndex);
      await hold.dispatchEvent('pointerup', { pointerType: 'mouse', button: 0 });
      return cards;
    }))).flat() as RememberedCard[];
    await Promise.all(pages.map((page) => expect(page.locator('.game-page')).toBeVisible()));

    const duplicateRank = remembered.find((card, index) => remembered.findIndex((candidate) => candidate.rank === card.rank) !== index)!.rank;
    const [source, target] = remembered.filter((card) => card.rank === duplicateRank).slice(0, 2);
    expect(source.id).not.toBe(target.id);
    let replacementMade = false;
    for (let turn = 0; turn < 8 && !replacementMade; turn += 1) {
      const activeIndex = await findActivePage(pages);
      const active = pages[activeIndex];
      await active.locator('.deck-card:enabled').click();
      await expect(active.locator('.drawn-panel')).toBeVisible();
      if (activeIndex === source.ownerIndex) {
        await active.locator(`.self-zone [data-card-id="${source.id}"]`).click();
        replacementMade = true;
      } else {
        await active.getByRole('button', { name: /^discard$/i }).click();
        const skip = active.getByRole('button', { name: /skip ability/i });
        if (await skip.isVisible().catch(() => false)) await skip.click();
      }
    }
    expect(replacementMade, 'The remembered card owner should receive a turn within one rotation').toBe(true);
    await expect(host.locator(`.discard-stack .playing-card[aria-label^="${duplicateRank} of "]`)).toHaveCount(1);

    const targetSelector = `[data-card-id="${target.id}"]`;
    await Promise.all(pages.map((page) => expect(page.locator(targetSelector)).toBeEnabled()));
    const fireAt = Date.now() + 750;
    const actors = pages.slice(0, 2);
    const outcomes = await Promise.all(actors.map((page) => page.evaluate(({ selector, at }) => new Promise<{ className: string; text: string }>((resolve, reject) => {
      const card = document.querySelector<HTMLElement>(selector);
      if (!card) return reject(new Error(`Storm target ${selector} disappeared before the barrier.`));
      const capture = () => {
        const result = document.querySelector<HTMLElement>('.stack-result');
        if (!result) return false;
        resolve({ className: result.className, text: result.textContent?.trim() ?? '' });
        return true;
      };
      const observer = new MutationObserver(() => { if (capture()) observer.disconnect(); });
      observer.observe(document.body, { childList: true, subtree: true });
      window.setTimeout(() => card.click(), Math.max(0, at - Date.now()));
      window.setTimeout(() => { observer.disconnect(); reject(new Error('No local stack result appeared.')); }, 5_000);
    }), { selector: targetSelector, at: fireAt })));
    expect(outcomes.filter((value) => value.className?.includes('correct'))).toHaveLength(1);
    const losers = outcomes.filter((value) => value.className?.includes('race-lost'));
    expect(losers).toHaveLength(1);
    expect(losers.every((value) => /.+ got there first.*your card stayed in place/i.test(value.text))).toBe(true);
    await Promise.all(actors.map((page) => expect(page.locator('.stack-result.wrong')).toHaveCount(0)));
    await Promise.all(pages.slice(2).map((page) => expect(page.locator('.stack-result')).toHaveCount(0)));
    await Promise.all(pages.map(async (page) => {
      await expect(page.locator(`.player-hand ${targetSelector}`)).toHaveCount(0);
      await expect(page.locator(`.discard-stack ${targetSelector}`)).toHaveCount(1);
    }));
    await pages[1].screenshot({ path: testInfo.outputPath('eight-browser-stack-race-loser.png'), fullPage: true });
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
  }
});

async function findActivePage(pages: Page[]): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (let index = 0; index < pages.length; index += 1) if (await pages[index].locator('.deck-card:enabled').count()) return index;
    await pages[0].waitForTimeout(50);
  }
  throw new Error('No browser observed an enabled draw deck.');
}
