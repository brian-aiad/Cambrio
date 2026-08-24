/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const outputRoot = 'output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=drawn&players=2');
  await page.waitForTimeout(600);
  await page.locator('[data-card-id="p0-card-0"]').evaluate((element) => (element).click());
  await page.waitForTimeout(90);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('A hand replacement did not launch both physical card movements.');
  const replacementLabels = await page.locator('.flight-endpoint em').allTextContents();
  if (!replacementLabels.includes('Brian TL') || !replacementLabels.includes('Drawn card')) throw new Error(`Hand replacement endpoints are incomplete: ${replacementLabels.join(', ')}`);
  await page.screenshot({ path: `${outputRoot}/drawn-swap-mid-390x844.png` });
  const visibleDecisionLayers = await page.locator('.drawn-panel, .stack-hint').evaluateAll((elements) => elements.filter((element) => Number(window.getComputedStyle(element).opacity) > 0.1).length);
  if (visibleDecisionLayers > 1) throw new Error('Draw and stack decision layers visibly overlap.');
  await page.waitForTimeout(700);
  const replacementFaces = await page.locator('.flight-front strong').allTextContents();
  if (!replacementFaces.includes('A') || !replacementFaces.includes('10')) throw new Error(`Replacement flights lost a known face: ${replacementFaces.join(', ')}`);
  if (Number(await page.locator('.card-flight.face-conceal .flight-front').evaluate((element) => window.getComputedStyle(element).opacity)) > .1) throw new Error('The drawn card did not conceal before entering the hand.');
  await page.screenshot({ path: `${outputRoot}/drawn-swap-complete-390x844.png` });
  const drawnSlot = await page.locator('[data-card-id="drawn-10"]').last().getAttribute('data-slot');
  if (drawnSlot !== '0') throw new Error(`Drawn card moved to slot ${drawnSlot}, expected slot 0.`);
  if (await page.locator('.stack-hint').count() !== 1) throw new Error('The new discard did not open a fresh stack window.');

  await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=4');
  await page.waitForTimeout(600);
  await page.locator('.opponent-rail [data-card-id="p1-card-3"]').evaluate((element) => (element).click());
  await page.waitForTimeout(90);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Blind swap did not launch two spatial card flights.');
  const endpointLabels = await page.locator('.flight-endpoint em').allTextContents();
  if (!endpointLabels.includes('Brian TL') || !endpointLabels.includes('Alex BR')) throw new Error(`Blind swap endpoint labels are incomplete: ${endpointLabels.join(', ')}`);
  if (await page.locator('.table-action-cue').evaluate((element) => Number(window.getComputedStyle(element).opacity) > 0.1)) throw new Error('Swap caption covered the opening card movement.');
  await page.screenshot({ path: `${outputRoot}/blind-swap-mid-390x844.png` });
  await page.waitForTimeout(700);
  if (!(await page.locator('.table-action-cue').textContent())?.includes('Alex BR')) throw new Error('Swap confirmation does not identify the exact opponent slot.');
  if (await page.locator('.self-zone [data-card-id="p1-card-3"]').count() !== 1) throw new Error('Opponent card did not arrive in the selected self slot.');
  if (await page.locator('.opponent-rail [data-card-id="p0-card-0"]').count() !== 1) throw new Error('Self card did not arrive in the selected opponent slot.');

  await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=8');
  await page.waitForTimeout(600);
  await page.locator('.opponent-rail [data-card-id="p7-card-3"]').evaluate((element) => (element).click());
  await page.waitForTimeout(90);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Eight-player swap did not launch both card flights.');
  const eightLabels = await page.locator('.flight-endpoint em').allTextContents();
  if (!eightLabels.includes('Brian TL') || !eightLabels.includes('Devin BR')) throw new Error(`Eight-player endpoints are ambiguous: ${eightLabels.join(', ')}`);
  const earlyBoxes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y }; }));
  await page.screenshot({ path: `${outputRoot}/blind-swap-8p-launch-390x844.png` });
  await page.waitForTimeout(430);
  const middleBoxes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y }; }));
  if (middleBoxes.some((box, index) => Math.hypot(box.x - earlyBoxes[index].x, box.y - earlyBoxes[index].y) < 70)) throw new Error('Eight-player card flights did not visibly travel across the table.');
  await page.screenshot({ path: `${outputRoot}/blind-swap-8p-crossing-390x844.png` });
  await page.waitForTimeout(700);
  if (await page.locator('.self-zone [data-card-id="p7-card-3"]').count() !== 1) throw new Error('Far opponent card did not land in Brian TL.');
  if (await page.locator('.opponent-rail [data-card-id="p0-card-0"]').count() !== 1) throw new Error('Brian card did not land in Devin BR.');

  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=8');
    await page.waitForTimeout(500);
    await page.locator('.opponent-rail [data-card-id="p7-card-3"]').evaluate((element) => (element).click());
    await page.waitForTimeout(520);
    const boxes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => { const box = element.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; }));
    if (boxes.length !== 2 || boxes.some((box) => box.left < -2 || box.top < -2 || box.right > viewport.width + 2 || box.bottom > viewport.height + 2)) throw new Error(`Swap flight escaped ${viewport.width}x${viewport.height}: ${JSON.stringify(boxes)}`);
    await page.screenshot({ path: `${outputRoot}/blind-swap-8p-${viewport.width}x${viewport.height}.png` });
    await page.waitForTimeout(700);
  }

  return { drawnSlot, blindSwap: 'two spatial flights', eightPlayerSwap: 'exact endpoints', responsiveFlights: ['320x568', '844x390'] };
}
