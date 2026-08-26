import { expect, test, type Page } from '@playwright/test';

const scenes = [
  'initial', 'initial-paused', 'awaiting', 'opponent-turn', 'paused', 'drawn',
  'own-select', 'own-reveal', 'opponent-select', 'opponent-reveal',
  'blind-own', 'blind-opponent', 'black-own', 'black-opponent', 'black-reveal',
  'black-choice', 'transfer', 'ending', 'six', 'zero', 'all-six', 'six-wrong',
  'results', 'results-tie',
] as const;

const viewports = [
  { name: 'compact portrait', width: 320, height: 568 },
  { name: 'phone portrait', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const documentOverflow = {
      x: document.documentElement.scrollWidth - viewport.width,
      y: document.documentElement.scrollHeight - viewport.height,
    };
    const clipped: string[] = [];
    const selectors = [
      '.game-status', '.opponent-rail', '.table-center', '.self-zone .hand-cards',
      '.cambio-button', '.interaction-prompt', '.pause-recovery-trigger',
      '.hold-button', '.peek-meta',
    ];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.left < -1 || rect.right > viewport.width + 1 || rect.top < -1 || rect.bottom > viewport.height + 1) {
          clipped.push(`${selector}:${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.right)},${Math.round(rect.bottom)}`);
        }
      }
    }
    return { viewport, documentOverflow, clipped };
  });
}

for (const viewport of viewports) {
  test(`all table states fit the ${viewport.name} viewport`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const scene of scenes) {
      await page.goto(`/__visual-audit?scene=${scene}&players=8`);
      await page.waitForTimeout(scene.includes('reveal') ? 100 : scene.startsWith('initial') ? 700 : 300);
      const metrics = await layoutMetrics(page);
      expect(metrics.documentOverflow.x, `${scene} has horizontal document overflow`).toBeLessThanOrEqual(1);
      if (!scene.startsWith('results')) {
        expect(metrics.documentOverflow.y, `${scene} scrolls outside a fixed game viewport`).toBeLessThanOrEqual(1);
        expect(metrics.clipped, `${scene} has clipped primary UI: ${metrics.clipped.join(' | ')}`).toEqual([]);
      }
    }
  });
}

test('landing page has no horizontal overflow and keeps primary controls tappable', async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /know your cards/i })).toBeVisible();
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      controls: [...document.querySelectorAll<HTMLElement>('button, input')].filter((element) => getComputedStyle(element).display !== 'none').map((element) => ({
        label: element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName,
        height: element.getBoundingClientRect().height,
      })),
    }));
    expect(metrics.overflow).toBeLessThanOrEqual(1);
    for (const control of metrics.controls) expect(control.height, `${control.label} is shorter than 44px`).toBeGreaterThanOrEqual(44);
  }
});

test('compact landing puts a direct table action in the first screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const entry = page.getByRole('link', { name: /create or join a table/i });
  await expect(entry).toBeInViewport();
  await entry.click();
  await expect(page.locator('#join-table')).toBeInViewport();
  await expect(page.getByLabel('Your display name')).toBeInViewport();
});

test('entry form explains requirements and normalizes pasted room codes', async ({ page }) => {
  await page.goto('/');
  const name = page.getByLabel('Your display name');
  await expect(page.locator('#display-name-hint')).toContainText('Use 2–20 characters');
  await name.fill('Brian');
  await expect(page.locator('#display-name-hint')).toContainText('Ready as Brian');
  const code = page.getByLabel('Room code');
  await code.fill('a b-c d 2 3 4 5');
  await expect(code).toHaveValue('ABCD2345');
  await expect(page.getByRole('button', { name: /^join$/i })).toBeEnabled();
});

test('the how-to-play guide stays usable at every supported viewport', async ({ page }) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const helpButton = page.getByRole('button', { name: /how to play cambrio/i });
    await helpButton.click();
    const guide = page.getByRole('dialog', { name: /remember\. trade\. stack\./i });
    await expect(guide).toBeVisible();
    await expect(page.getByRole('button', { name: /close how to play/i })).toBeFocused();
    await expect(guide).toContainText('Draw privately');
    await expect(guide).toContainText('first correct tap wins');
    await expect(guide).toContainText('red Kings are −1');
    const bounds = await guide.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(-1);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 1);
    expect(bounds.top).toBeGreaterThanOrEqual(-1);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);
    await page.keyboard.press('Escape');
    await expect(guide).toHaveCount(0);
    await expect(helpButton).toBeFocused();
  }
});

test('turn affordances always identify the owner, action, deck state, and timer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=awaiting&players=8');
  await expect(page.locator('.turn-banner')).toContainText('Your turn');
  await expect(page.locator('.self-zone .you-label')).toContainText('YOUR TURN');
  await expect(page.locator('.deck-pile > span')).toHaveText('DRAW');
  await expect(page.locator('.deck-card')).toBeEnabled();
  await expect(page.locator('.countdown')).toHaveCSS('background-image', /conic-gradient/);

  await page.goto('/__visual-audit?scene=opponent-turn&players=8');
  await expect(page.locator('.turn-banner')).toContainText("Alex's turn");
  await expect(page.locator('.player-hand.active-turn .seat-name')).toContainText('Alex');
  await expect(page.locator('.deck-pile > span')).toHaveText('DECK');
  await expect(page.locator('.deck-card')).toBeDisabled();
});

test('compact opponent rail keeps cards readable and follows a distant active seat', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/__visual-audit?scene=opponent-turn&players=8&active=7');
  await page.waitForTimeout(700);
  await expect(page.locator('.turn-banner')).toContainText("Devin's turn");
  const metrics = await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>('.opponent-rail')!;
    const active = rail.querySelector<HTMLElement>('.player-hand.active-turn')!;
    const card = active.querySelector<HTMLElement>('.hand-slot')!;
    const railRect = rail.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    return {
      scrollable: rail.scrollWidth > rail.clientWidth,
      moved: rail.scrollLeft > 0,
      activeVisible: activeRect.left >= railRect.left - 1 && activeRect.right <= railRect.right + 1,
      cardWidth: card.getBoundingClientRect().width,
    };
  });
  expect(metrics.scrollable).toBe(true);
  expect(metrics.moved).toBe(true);
  expect(metrics.activeVisible).toBe(true);
  expect(metrics.cardWidth).toBeGreaterThanOrEqual(26);
});

test('six-card opponent hands preserve every target without vertical clipping', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/__visual-audit?scene=all-six&players=8');
    const clipped = await page.locator('.opponent-rail .player-hand').evaluateAll((hands) => hands.map((hand) => {
      const cards = hand.querySelector<HTMLElement>('.hand-cards')!.getBoundingClientRect();
      const handBox = hand.getBoundingClientRect();
      return cards.top < handBox.top - 1 || cards.bottom > handBox.bottom + 1;
    }));
    expect(clipped.some(Boolean), `opponent penalty cards clip at ${viewport.width}x${viewport.height}`).toBe(false);
    await expect(page.locator('.opponent-rail .player-hand').first().locator('.hand-slot')).toHaveCount(6);
  }
});

test('every supported player count preserves four stable starting slots', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (let players = 2; players <= 8; players += 1) {
    await page.goto(`/__visual-audit?scene=awaiting&players=${players}`);
    await page.waitForTimeout(250);
    await expect(page.locator('.opponent-rail .player-hand')).toHaveCount(players - 1);
    await expect(page.locator('.self-zone .hand-slot')).toHaveCount(4);
    const slotSets = await page.locator('.player-hand .hand-cards').evaluateAll((hands) => hands.map((hand) =>
      [...hand.querySelectorAll<HTMLElement>('.playing-card[data-slot]')].map((card) => Number(card.dataset.slot)).sort((a, b) => a - b),
    ));
    for (const slots of slotSets) expect(slots).toEqual([0, 1, 2, 3]);
    const metrics = await layoutMetrics(page);
    expect(metrics.documentOverflow.x).toBeLessThanOrEqual(1);
    expect(metrics.documentOverflow.y).toBeLessThanOrEqual(1);
    expect(metrics.clipped).toEqual([]);
  }
});

test('the card gallery renders one accessible face for all 52 unique cards', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/__visual-audit?scene=cards');
  const cards = page.locator('.card-gallery .playing-card');
  await expect(cards).toHaveCount(52);
  const labels = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
  expect(new Set(labels).size).toBe(52);
  expect(labels.every((label) => Boolean(label && /of (clubs|diamonds|hearts|spades)/i.test(label)))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
