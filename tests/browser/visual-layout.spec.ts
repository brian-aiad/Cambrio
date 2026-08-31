import { expect, test, type Page } from '@playwright/test';

const scenes = [
  'initial', 'initial-paused', 'awaiting', 'opponent-turn', 'opponent-drawn', 'paused', 'drawn',
  'own-select', 'own-reveal', 'opponent-select', 'opponent-reveal', 'opponent-reconnect',
  'blind-own', 'blind-opponent', 'black-own', 'black-opponent', 'black-reveal', 'black-reconnect',
  'black-choice', 'transfer', 'ending', 'six', 'zero', 'forfeited', 'all-six', 'six-wrong',
  'results', 'results-tie',
] as const;

const viewports = [
  { name: 'compact portrait', width: 320, height: 568 },
  { name: 'phone portrait', width: 390, height: 844 },
  { name: 'short phone landscape', width: 568, height: 320 },
  { name: 'common phone landscape', width: 667, height: 375 },
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
      '.discard-stack', '.deck-card',
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

test('typing a new name on an invite waits for explicit submission', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('cambrio:name'));
  await page.goto('/room/ZZZZZZZZ');
  const name = page.getByLabel('Your display name');
  await name.fill('Alexandra');
  await page.waitForTimeout(250);
  await expect(name).toHaveValue('Alexandra');
  await expect(name).toBeEnabled();
  await expect(page.getByRole('button', { name: /join room/i })).toBeEnabled();
  await expect(page.locator('.expired-invite, #entry-error')).toHaveCount(0);

  await name.press('Enter');
  await expect(page.locator('.expired-invite')).toContainText(/no longer active/i);
});

test('mobile form focus survives keyboard-like viewport contraction and restoration', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const name = page.getByLabel('Your display name');
  await name.fill('Mobile Player');

  await page.setViewportSize({ width: 390, height: 500 });
  await name.click();
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  await expect(page.getByRole('button', { name: /create private room/i })).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    landingTransform: getComputedStyle(document.querySelector('.landing')!).transform,
  }))).toEqual({ overflow: 0, landingTransform: 'none' });
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

test('the compact player panel keeps sound controls available and restores focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const playerButton = page.getByRole('button', { name: /guest|profile/i });
  await playerButton.click();
  const panel = page.getByRole('dialog', { name: /save your wins|profile/i });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /effects/i })).toBeVisible();
  await expect(panel.getByRole('button', { name: /ambience/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /close player panel/i })).toBeFocused();
  const email = panel.getByPlaceholder('you@example.com');
  const sendLink = panel.getByRole('button', { name: /send link/i });
  await expect(sendLink).toBeDisabled();
  await email.fill('not-an-email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(sendLink).toBeDisabled();
  await email.fill('player@example.com');
  await expect(email).toHaveAttribute('aria-invalid', 'false');
  await expect(sendLink).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(playerButton).toBeFocused();
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

test('compact portrait keeps every opponent readable and follows a distant active seat', async ({ page }) => {
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
    const hands = [...rail.querySelectorAll<HTMLElement>('.player-hand')].map((hand) => hand.getBoundingClientRect());
    return {
      scrollable: rail.scrollWidth > rail.clientWidth,
      pageStayedPut: window.scrollX === 0,
      activeVisible: activeRect.left >= railRect.left - 1 && activeRect.right <= railRect.right + 1,
      allVisible: hands.every((hand) => hand.left >= railRect.left - 1 && hand.right <= railRect.right + 1),
      cardWidth: card.getBoundingClientRect().width,
    };
  });
  expect(metrics.scrollable).toBe(false);
  expect(metrics.pageStayedPut).toBe(true);
  expect(metrics.activeVisible).toBe(true);
  expect(metrics.allVisible).toBe(true);
  expect(metrics.cardWidth).toBeGreaterThanOrEqual(22);
});

test('compact power targeting keeps seats fixed and promotes one opponent at a time', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/__visual-audit?scene=opponent-select&players=8');
  const rail = page.locator('.opponent-rail');
  const metrics = await rail.evaluate((element) => ({ scrollable: element.scrollWidth > element.clientWidth, maxScroll: element.scrollWidth - element.clientWidth }));
  expect(metrics.scrollable).toBe(false);
  await expect(rail.locator('.target-focus-control')).toHaveCount(7);
  await expect(page.locator('.dense-target-panel')).toHaveCount(0);
  const before = await rail.locator('.player-hand').evaluateAll((hands) => hands.map((hand) => {
    const rect = hand.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y) };
  }));
  await rail.locator('.target-focus-control').last().click();
  const panel = page.locator('.dense-target-panel');
  await expect(panel).toContainText('Devin');
  const widths = await panel.locator('.playing-card.target-option').evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
  expect(widths).toHaveLength(4);
  expect(Math.min(...widths)).toBeGreaterThanOrEqual(44);
  await expect(panel).toBeInViewport();
  const after = await rail.locator('.player-hand').evaluateAll((hands) => hands.map((hand) => {
    const rect = hand.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y) };
  }));
  expect(after).toEqual(before);
  await expect(panel.locator('[data-card-id]')).toHaveCount(0);
  await expect(panel.locator('.playing-card').first()).toHaveAccessibleName(/top left card; tap to peek/i);
});

test('an opponent draw stays attached to its owner without covering piles or the local hand', async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const active of [1, 7]) {
      await page.goto(`/__visual-audit?scene=opponent-drawn&players=8&active=${active}`);
      await page.waitForTimeout(700);
      const metrics = await page.evaluate(() => {
        const stage = document.querySelector<HTMLElement>('.decision-card-anchor')!.getBoundingClientRect();
        const activeHand = document.querySelector<HTMLElement>('.player-hand.active-turn')!.getBoundingClientRect();
        const obstacles = [
          document.querySelector<HTMLElement>('.deck-card')!.getBoundingClientRect(),
          document.querySelector<HTMLElement>('[data-table-zone="discard"] .playing-card')!.getBoundingClientRect(),
          document.querySelector<HTMLElement>('.self-zone .hand-cards')!.getBoundingClientRect(),
        ];
        const intersects = (first: DOMRect, second: DOMRect) => first.left < second.right - 1 && first.right > second.left + 1 && first.top < second.bottom - 1 && first.bottom > second.top + 1;
        return {
          pageStayedPut: window.scrollX === 0,
          ownerDistance: Math.abs((stage.left + stage.right) / 2 - (activeHand.left + activeHand.right) / 2),
          collisions: obstacles.map((obstacle) => intersects(stage, obstacle)),
        };
      });
      expect(metrics.pageStayedPut).toBe(true);
      expect(metrics.ownerDistance).toBeLessThanOrEqual(viewport.width <= 500 ? 75 : viewport.height <= 500 ? 75 : 22);
      expect(metrics.collisions).toEqual([false, false, false]);
    }
  }
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

test('edge local-seat perspectives preserve authoritative order and a usable local hand', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (let players = 2; players <= 8; players += 1) {
    const viewers = [...new Set([0, Math.floor(players / 2), players - 1])];
    for (const viewer of viewers) {
      await page.goto(`/__visual-audit?scene=opponent-turn&players=${players}&viewer=${viewer}&active=${(viewer + 1) % players}`);
      await expect(page.locator('.visual-audit')).toHaveAttribute('data-viewer-seat', String(viewer));
      await expect(page.locator('.self-zone .hand-slot')).toHaveCount(4);
      await expect(page.locator('.opponent-rail .player-hand')).toHaveCount(players - 1);
      const seats = await page.locator('.opponent-rail .player-hand').evaluateAll((hands) => hands.map((hand) => hand.getAttribute('data-player-seat')));
      expect(seats).toEqual(Array.from({ length: players }, (_, seat) => `player-${seat}`).filter((_, seat) => seat !== viewer));
      const metrics = await layoutMetrics(page);
      expect(metrics.documentOverflow.x).toBeLessThanOrEqual(1);
      expect(metrics.documentOverflow.y).toBeLessThanOrEqual(1);
      expect(metrics.clipped).toEqual([]);
    }
  }
});

test('representative phone, tablet, and desktop dimensions keep critical states contained', async ({ page }) => {
  test.setTimeout(90_000);
  const representativeViewports = [
    { width: 340, height: 640 },
    { width: 360, height: 640 },
    { width: 360, height: 800 },
    { width: 375, height: 667 },
    { width: 375, height: 812 },
    { width: 393, height: 852 },
    { width: 412, height: 915 },
    { width: 430, height: 932 },
    { width: 480, height: 800 },
    { width: 600, height: 900 },
    { width: 720, height: 400 },
    { width: 740, height: 360 },
    { width: 812, height: 375 },
    { width: 852, height: 393 },
    { width: 915, height: 412 },
    { width: 932, height: 430 },
    { width: 768, height: 1024 },
    { width: 820, height: 1180 },
    { width: 1024, height: 768 },
    { width: 1180, height: 820 },
    { width: 1280, height: 720 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ];
  const criticalScenes = ['awaiting', 'drawn', 'transfer', 'black-opponent', 'results-tie'];
  const pressureViewports = new Set(['340x640', '375x667', '393x852', '600x900', '740x360', '820x1180', '1180x820', '1366x768', '1920x1080']);
  for (const viewport of representativeViewports) {
    await page.setViewportSize(viewport);
    const viewportScenes = pressureViewports.has(`${viewport.width}x${viewport.height}`) ? criticalScenes : ['awaiting'];
    for (const scene of viewportScenes) {
      await page.goto(`/__visual-audit?scene=${scene}&players=8`);
      await page.waitForTimeout(180);
      const metrics = await layoutMetrics(page);
      expect(metrics.documentOverflow.x, `${scene} overflows horizontally at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(1);
      if (!scene.startsWith('results')) {
        expect(metrics.documentOverflow.y, `${scene} scrolls at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(1);
        expect(metrics.clipped, `${scene} clips at ${viewport.width}×${viewport.height}`).toEqual([]);
      }
    }
  }
});

test('short landscape keeps opponent seats, local slots, piles, and contextual prompts physically separate', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  for (const scene of ['awaiting', 'all-six', 'black-opponent']) {
    await page.goto(`/__visual-audit?scene=${scene}&players=8&viewer=4&active=4`);
    const metrics = await page.evaluate(() => {
      const bounds = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].map((element) => element.getBoundingClientRect());
      const intersects = (first: DOMRect, second: DOMRect) => first.left < second.right - 1 && first.right > second.left + 1 && first.top < second.bottom - 1 && first.bottom > second.top + 1;
      const opponents = bounds('.opponent-rail .playing-card');
      const local = bounds('.self-zone .playing-card');
      const prompts = bounds('.interaction-prompt');
      const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const primary = bounds('.discard-stack, .deck-card, .self-zone .hand-cards, .opponent-rail');
      return {
        localOpponentCollisions: local.flatMap((card) => opponents.map((opponent) => intersects(card, opponent))).filter(Boolean).length,
        promptTargetCollisions: prompts.flatMap((prompt) => opponents.map((opponent) => intersects(prompt, opponent))).filter(Boolean).length,
        primaryContained: primary.every((rect) => rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1),
      };
    });
    expect(metrics.localOpponentCollisions, `${scene} overlaps local and opponent cards`).toBe(0);
    expect(metrics.promptTargetCollisions, `${scene} covers a legal opponent target`).toBe(0);
    expect(metrics.primaryContained, `${scene} clips primary gameplay UI`).toBe(true);
  }
});

test('Black King choices stay legible and preserve the stack window on compact phones', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/__visual-audit?scene=black-choice&players=8&viewer=0&active=0');
    const prompt = page.locator('.power-choice');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Swap cards' })).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Keep positions' })).toBeVisible();
    await expect(prompt).toContainText(/stack (window remains|stays) open/i);
    const metrics = await layoutMetrics(page);
    expect(metrics.documentOverflow.x).toBeLessThanOrEqual(1);
    expect(metrics.documentOverflow.y).toBeLessThanOrEqual(1);
    expect(metrics.clipped).toEqual([]);
  }
});

test('transfer recipients and personal results remain visually and semantically anchored', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=transfer&players=8&viewer=0&active=0');
  const recipient = page.locator('.transfer-recipient');
  await expect(recipient).toHaveCount(1);
  await expect(recipient.locator('.recipient-label')).toContainText('RECEIVES');
  await expect(recipient.locator('.seat-name')).toHaveAttribute('aria-label', /receives your card/i);

  await page.goto('/__visual-audit?scene=results&players=8&viewer=4');
  const personalResult = page.locator('.result-row.self-result');
  await expect(personalResult).toHaveCount(1);
  await expect(personalResult).toHaveAttribute('aria-current', 'true');
  await expect(personalResult).toContainText('(you)');
});

test('six-card landscape keeps TL TR BL BR and extra slots in the stable two-row model', async ({ page }) => {
  await page.setViewportSize({ width: 568, height: 320 });
  await page.goto('/__visual-audit?scene=all-six&players=8&viewer=4&active=4');
  const slots = await page.locator('.self-zone .hand-slot').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { slot: Number((element as HTMLElement).dataset.slot), x: Math.round(rect.x), y: Math.round(rect.y) };
  }));
  expect(slots).toHaveLength(6);
  expect(slots[0].x).toBe(slots[2].x);
  expect(slots[1].x).toBe(slots[3].x);
  expect(slots[0].y).toBe(slots[1].y);
  expect(slots[2].y).toBe(slots[3].y);
  expect(slots[2].y).toBeGreaterThan(slots[0].y);
  expect(slots[4].x).toBeGreaterThan(slots[1].x);
  expect(slots[5].y).toBe(slots[2].y);
});

test('a discarded power preserves the concurrent stack race and table-wide Cambrio call', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=opponent-select&players=8&viewer=0&active=0');
  await expect(page.locator('.game-page')).toHaveClass(/stack-mode/);
  await expect(page.getByRole('button', { name: /call cambrio/i })).toBeVisible();

  const localStack = page.locator('.self-zone .playing-card').first();
  await expect(localStack).toHaveAttribute('aria-label', /tap to attempt stack/i);
  await localStack.click();
  await expect(page.locator('.self-zone .playing-card')).toHaveCount(3);
  await expect(page.locator('.interaction-prompt')).toContainText(/Choose an opponent/i);

  await page.goto('/__visual-audit?scene=transfer&players=8&viewer=0&active=0');
  const callDuringTransfer = page.getByRole('button', { name: /call cambrio/i });
  await expect(callDuringTransfer).toBeVisible();
  await callDuringTransfer.click();
  await expect(page.locator('.ending-announcement')).toContainText('CAMBRIO');
  await expect(page.locator('.transfer-prompt')).toBeVisible();
});

test('network latency serializes conflicting local intents', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=awaiting&players=4&latency=450');
  const deck = page.locator('.deck-card');
  const cambrio = page.getByRole('button', { name: /call cambrio/i });
  await deck.click();
  await expect(deck).toHaveAttribute('aria-busy', 'true');
  await expect(cambrio).toBeDisabled();
  await expect(page.locator('.self-zone .playing-card').first()).toBeDisabled();
  await expect(page.locator('.drawn-panel')).toBeVisible();

  await page.goto('/__visual-audit?scene=awaiting&players=4&latency=450');
  const pendingCall = page.locator('.cambio-button');
  await pendingCall.click();
  await expect(pendingCall).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.deck-card')).toBeDisabled();
  await expect(page.locator('.self-zone .playing-card').first()).toBeDisabled();
  await expect(page.locator('.ending-announcement')).toBeVisible();
});

test('reconnect resolves revoked private reveals without exposing faces or stranding the power', async ({ page }) => {
  await page.goto('/__visual-audit?scene=opponent-reconnect&players=4');
  await expect(page.locator('.turn-banner')).toContainText(/disconnected/i);
  await expect(page.locator('.player-hand .playing-card:not(.face-down)')).toHaveCount(0);
  await expect(page.locator('.interaction-prompt')).toHaveCount(0, { timeout: 2_000 });
  await expect(page.locator('.turn-banner')).toContainText(/alex/i);

  await page.goto('/__visual-audit?scene=black-reconnect&players=4');
  await expect(page.locator('.turn-banner')).toContainText(/disconnected/i);
  await expect(page.locator('.player-hand .playing-card:not(.face-down)')).toHaveCount(0);
  await expect(page.locator('.interaction-prompt')).toContainText(/choose whether these two cards switch places/i, { timeout: 2_000 });
  await expect(page.locator('.player-hand .playing-card:not(.face-down)')).toHaveCount(0);
});

test('forfeiting preserves the seat order and communicates an intentional empty hand', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=forfeited&players=8&viewer=4&active=4');
  const seats = await page.locator('.opponent-rail .player-hand').evaluateAll((hands) => hands.map((hand) => hand.getAttribute('data-player-seat')));
  expect(seats).toEqual(['player-0', 'player-1', 'player-2', 'player-3', 'player-5', 'player-6', 'player-7']);
  const forfeited = page.locator('[data-player-seat="player-0"]');
  await expect(forfeited).toHaveClass(/forfeited-hand/);
  await expect(forfeited.locator('.out-badge')).toContainText('FORFEITED');
  await expect(forfeited.locator('.out-badge')).toContainText('Hand removed');
});

test('dense power focus preserves comfortable targets at 390px and with six-card hands', async ({ page }) => {
  for (const fixture of [
    { width: 390, height: 844, query: '' },
    { width: 320, height: 568, query: '&cards=6' },
  ]) {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    await page.goto(`/__visual-audit?scene=opponent-select&players=8${fixture.query}`);
    const rail = page.locator('.opponent-rail');
    expect(await rail.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
    await rail.locator('.target-focus-control').last().click();
    const panel = page.locator('.dense-target-panel');
    const widths = await panel.locator('.playing-card.target-option').evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
    expect(widths.length).toBe(fixture.query ? 6 : 4);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(44);
    await expect(panel).toBeInViewport();
    await expect(rail.locator('.player-hand').last()).toBeInViewport();
  }
});

test('dense mobile guidance stays beside the table controls without covering cards or piles', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/__visual-audit?scene=opponent-select&players=8&names=long');
    const geometry = await page.evaluate(() => {
      const prompt = document.querySelector<HTMLElement>('.interaction-prompt')!.getBoundingClientRect();
      const localCards = document.querySelector<HTMLElement>('.self-zone .hand-cards')!.getBoundingClientRect();
      const piles = document.querySelector<HTMLElement>('.pile-zone')!.getBoundingClientRect();
      const intersects = (first: DOMRect, second: DOMRect) => first.left < second.right - 1 && first.right > second.left + 1 && first.top < second.bottom - 1 && first.bottom > second.top + 1;
      return {
        prompt: { left: prompt.left, top: prompt.top, right: prompt.right, bottom: prompt.bottom },
        localCollision: intersects(prompt, localCards),
        pileCollision: intersects(prompt, piles),
        contained: prompt.left >= 0 && prompt.right <= innerWidth && prompt.top >= 0 && prompt.bottom <= innerHeight,
      };
    });
    expect(geometry.localCollision, `${viewport.width}px guidance ${JSON.stringify(geometry.prompt)} covers the local hand`).toBe(false);
    expect(geometry.pileCollision, `${viewport.width}px guidance ${JSON.stringify(geometry.prompt)} covers the center piles`).toBe(false);
    expect(geometry.contained, `${viewport.width}px guidance ${JSON.stringify(geometry.prompt)} leaves the viewport`).toBe(true);
  }
});

test('maximum-length player names truncate without changing seat geometry and remain accessible', async ({ page }) => {
  for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/__visual-audit?scene=opponent-turn&players=8&viewer=4&active=7&names=long');
    const names = await page.locator('.opponent-rail .seat-name').evaluateAll((elements) => elements.map((element) => {
      const label = element.getAttribute('aria-label');
      const visibleName = element.querySelector<HTMLElement>('.seat-identity b')!;
      const seat = element.closest<HTMLElement>('.player-hand')!;
      return {
        label,
        contained: element.getBoundingClientRect().left >= seat.getBoundingClientRect().left - 1 && element.getBoundingClientRect().right <= seat.getBoundingClientRect().right + 1,
        ellipsis: getComputedStyle(visibleName).textOverflow,
      };
    }));
    expect(names.every((name) => Boolean(name.label && name.label.length > 15))).toBe(true);
    expect(names.every((name) => name.contained)).toBe(true);
    expect(names.every((name) => name.ellipsis === 'ellipsis')).toBe(true);
    const metrics = await layoutMetrics(page);
    expect(metrics.documentOverflow.x).toBeLessThanOrEqual(1);
    expect(metrics.clipped).toEqual([]);
  }
});

test('mobile gameplay copy never clips inside its rendered control or status region', async ({ page }) => {
  const mobileViewports = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 568, height: 320 },
  ];
  const pressureScenes = [
    'awaiting', 'drawn', 'opponent-select', 'blind-opponent', 'black-opponent',
    'black-choice', 'transfer', 'ending', 'six-wrong', 'paused', 'results-tie',
  ];
  const selectors = [
    '.turn-banner strong', '.turn-banner span',
    '.interaction-prompt strong', '.prompt-copy > span',
    '.stack-result-copy strong', '.stack-result-copy small',
    '.dense-target-panel header strong',
    '.ending-announcement strong', '.ending-announcement small',
    '.results-hero h1', '.results-hero > p:last-child',
    '.table-action-cue strong', '.table-action-cue small',
  ];

  for (const viewport of mobileViewports) {
    await page.setViewportSize(viewport);
    for (const scene of pressureScenes) {
      await page.goto(`/__visual-audit?scene=${scene}&players=8&names=long`);
      await page.waitForTimeout(scene === 'ending' ? 120 : 40);
      const clipped = await page.locator(selectors.join(',')).evaluateAll((elements) => elements.flatMap((element) => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return [];
        const horizontal = node.scrollWidth > node.clientWidth + 1;
        const vertical = node.scrollHeight > node.clientHeight + 1;
        return horizontal || vertical ? [{
          selector: node.className || node.tagName,
          text: node.textContent?.trim(),
          client: `${node.clientWidth}x${node.clientHeight}`,
          scroll: `${node.scrollWidth}x${node.scrollHeight}`,
        }] : [];
      }));
      expect(clipped, `${scene} clips gameplay copy at ${viewport.width}x${viewport.height}`).toEqual([]);
    }
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
