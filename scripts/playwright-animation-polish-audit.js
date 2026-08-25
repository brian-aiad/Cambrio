/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=awaiting&players=8');
  await page.waitForTimeout(400);
  await page.locator('[data-table-zone="deck"]').click();
  await page.waitForTimeout(70);
  if (await page.locator('.swap-flight-layer.draw .card-flight').count() !== 1) throw new Error('Draw launch is missing its deck-to-panel card flight.');
  const earlyControlsOpacity = Number(await page.locator('.drawn-actions').evaluate((element) => window.getComputedStyle(element).opacity));
  if (earlyControlsOpacity > .15) throw new Error(`Draw controls appeared before the card landed (${earlyControlsOpacity}).`);
  await page.waitForTimeout(780);
  if (await page.locator('.swap-flight-layer.draw').count()) throw new Error('Draw flight remained mounted after landing.');
  if (Number(await page.locator('.drawn-actions').evaluate((element) => window.getComputedStyle(element).opacity)) < .95) throw new Error('Draw controls did not become fully available after landing.');

  await page.locator('.discard-drawn').click();
  await page.waitForTimeout(90);
  if (await page.locator('.covered-discard [data-card-id="discard-8"]').count() !== 1) throw new Error('Previous discard disappeared before the new card covered it.');
  if (await page.locator('.current-discard [data-card-id="audit-drawn"]').count() !== 1) throw new Error('Incoming discard did not reserve the top pile position.');
  if (Number(await page.locator('.covered-discard .playing-card').evaluate((element) => window.getComputedStyle(element).opacity)) < .95) throw new Error('Covered discard is not visible during flight.');
  if (Number(await page.locator('.current-discard .playing-card').evaluate((element) => window.getComputedStyle(element).opacity)) > .1) throw new Error('Incoming discard duplicated beneath its moving card.');
  const discardRoute = await page.locator('.card-flight').evaluate((element) => `${element.getAttribute('data-flight-from')} -> ${element.getAttribute('data-flight-to')}`);
  if (discardRoute !== 'Drawn card -> Discard') throw new Error(`Discard route is ${discardRoute}.`);
  await page.screenshot({ path: `${root}/discard-layering-mid-390x844.png` });
  await page.waitForTimeout(900);
  if (await page.locator('.covered-discard, .swap-flight-layer, .flight-receiving').count()) throw new Error('Discard animation left transient layers behind.');
  if (await page.locator('.current-discard .playing-card').count() !== 1) throw new Error('Settled discard pile does not have one authoritative top card.');
  await page.screenshot({ path: `${root}/discard-layering-settled-390x844.png` });

  await page.goto('http://localhost:5173/__visual-audit?scene=drawn&players=4');
  await page.waitForTimeout(400);
  const target = page.locator('.self-zone [data-card-id="p0-card-0"]');
  const before = await target.boundingBox();
  await target.click();
  await page.waitForTimeout(1_450);
  const landed = page.locator('.self-zone [data-card-id="drawn-10"][data-slot="0"]');
  const after = await landed.boundingBox();
  if (!before || !after || Math.abs(before.x - after.x) > .5 || Math.abs(before.y - after.y) > .5 || Math.abs(before.width - after.width) > .5 || Math.abs(before.height - after.height) > .5) throw new Error(`Replacement shifted the memorized TL slot: ${JSON.stringify({ before, after })}`);
  if (await page.locator('.target-option, .flight-receiving, .swap-flight-layer, .covered-discard').count()) throw new Error('Replacement left target or arrival state mounted while idle.');
  const idleBorderOpacity = Number(await landed.evaluate((element) => window.getComputedStyle(element, '::after').opacity));
  if (idleBorderOpacity > .05) throw new Error(`Settled TL card kept a stale action border (${idleBorderOpacity}).`);
  await page.screenshot({ path: `${root}/replacement-settled-no-highlight-390x844.png` });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=8');
  await page.waitForTimeout(350);
  await page.locator('.opponent-rail [data-card-id="p7-card-3"]').click();
  await page.waitForTimeout(100);
  if (await page.locator('.flight-endpoint').count()) throw new Error('Legacy hollow flight endpoints returned.');
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Eight-player exchange does not show both moving cards.');
  const fixedOrigins = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => ({ left: element.style.left, top: element.style.top, transform: element.style.transform })));
  await page.waitForTimeout(280);
  const movedTransforms = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => ({ left: element.style.left, top: element.style.top, transform: element.style.transform })));
  if (movedTransforms.some((state, index) => state.left !== fixedOrigins[index].left || state.top !== fixedOrigins[index].top || state.transform === fixedOrigins[index].transform)) throw new Error('Card exchange is not transform-only or did not visibly move.');
  await page.screenshot({ path: `${root}/eight-player-transform-flight-320x568.png` });
  await page.waitForTimeout(1_050);
  if (await page.locator('.swap-flight-layer, .flight-receiving, .selected').count()) throw new Error('Eight-player exchange left animation or selection artifacts behind.');

  return { draw: 'sequenced', discard: 'layered cover', idleHighlight: 'cleared', eightPlayerFlight: 'transform-only' };
}
