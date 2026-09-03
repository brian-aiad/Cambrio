/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=own-select&players=4');
  await page.waitForTimeout(500);
  await page.locator('.self-zone [data-card-id="p0-card-2"]').click();
  await page.waitForTimeout(180);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 2) throw new Error('Own peek did not reveal exactly one hand card plus the discard.');
  if (!(await page.locator('.interaction-prompt').textContent())?.includes('Memorize')) throw new Error('Own peek does not show the timed memory prompt.');
  if ((await page.locator('.selection-order small').textContent()) !== 'PEEK') throw new Error('A peek target was mislabeled as a swap endpoint.');
  await page.screenshot({ path: `${root}/own-peek-auto-reveal.png` });
  await page.waitForTimeout(1_750);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 1) throw new Error('Own peek did not conceal automatically.');

  await page.goto('http://localhost:5173/__visual-audit?scene=opponent-select&players=4');
  await page.waitForTimeout(500);
  await page.locator('.opponent-rail [data-card-id="p2-card-1"]').click();
  await page.waitForTimeout(180);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 2) throw new Error('Opponent peek did not reveal exactly one target card plus the discard.');
  await page.screenshot({ path: `${root}/opponent-peek-auto-reveal.png` });
  await page.waitForTimeout(1_750);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 1) throw new Error('Opponent peek did not conceal automatically.');

  await page.goto('http://localhost:5173/__visual-audit?scene=blind-own&players=4');
  await page.waitForTimeout(500);
  await page.locator('.self-zone [data-card-id="p0-card-0"]').click();
  await page.waitForTimeout(120);
  if (!(await page.locator('.interaction-prompt').textContent())?.includes("opponent's card")) throw new Error('Blind swap did not advance directly to opponent selection.');
  if (!(await page.locator('.selection-order').textContent())?.includes('1FROM')) throw new Error('Blind swap did not keep a numbered marker on the selected source card.');
  if (!(await page.locator('.sequence-step.done').textContent())?.includes('Your card') || !(await page.locator('.sequence-step.current').textContent())?.includes('Their card')) throw new Error('Blind swap did not show its completed and current visual steps.');
  await page.locator('.opponent-rail [data-card-id="p1-card-3"]').click();
  await page.waitForTimeout(160);
  await page.screenshot({ path: `${root}/blind-swap-complete.png` });
  if (await page.locator('.self-zone [data-card-id="p1-card-3"]').count() !== 1) throw new Error('Blind swap result is not in the chosen self slot.');

  await page.goto('http://localhost:5173/__visual-audit?scene=black-own&players=4');
  await page.waitForTimeout(500);
  await page.locator('.self-zone [data-card-id="p0-card-1"]').click();
  await page.locator('.opponent-rail [data-card-id="p1-card-2"]').click();
  await page.waitForTimeout(180);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 3) throw new Error('Black King did not reveal exactly two targets plus the discard.');
  await page.screenshot({ path: `${root}/black-king-auto-reveal.png` });
  await page.waitForTimeout(1_750);
  if (!(await page.locator('.interaction-prompt').textContent())?.includes('Choose whether these two cards switch places.')) throw new Error('Black King did not advance to the swap-or-keep choice.');
  if (await page.locator('.playing-card:not(.face-down)').count() !== 1) throw new Error('Black King target ranks remained in the rendered choice state after concealment.');
  if (await page.locator('.selection-order').count() !== 2) throw new Error('Black King did not retain both numbered position markers for its decision.');
  await page.getByRole('button', { name: 'Swap cards', exact: true }).click();
  await page.waitForTimeout(160);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Black King swap did not launch two exact-position card flights.');
  const kingRoutes = await page.locator('.card-flight').evaluateAll((elements) => elements.map((element) => `${element.getAttribute('data-flight-from')} -> ${element.getAttribute('data-flight-to')}`));
  if (!kingRoutes.includes('Brian TR -> Alex BL') || !kingRoutes.includes('Alex BL -> Brian TR')) throw new Error(`Black King flight routes are incomplete: ${kingRoutes.join(', ')}`);
  await page.screenshot({ path: `${root}/black-king-swap-flight.png` });
  if (await page.locator('.self-zone [data-card-id="p1-card-2"]').count() !== 1) throw new Error('Black King swap did not preserve the selected self slot.');
  if (await page.locator('.opponent-rail [data-card-id="p0-card-1"]').count() !== 1) throw new Error('Black King swap did not preserve the selected opponent slot.');

  await page.goto('http://localhost:5173/__visual-audit?scene=blind-opponent&players=8');
  await page.waitForTimeout(300);
  if (await page.locator('.opponent-rail .target-cue:visible').count() !== 0) throw new Error('The dense eight-player rail repeated target badges across every card.');
  if (await page.locator('.opponent-rail .target-focus-control').count() !== 7) throw new Error('The dense rail did not expose every legal opponent as a first-step target.');
  if (!(await page.locator('.action-sequence').textContent())?.includes('Their card')) throw new Error('The dense rail has no visual current-step indicator.');
  await page.locator('.opponent-rail .target-focus-control').last().click();
  if (await page.locator('.dense-target-panel .playing-card.target-option').count() !== 4) throw new Error('The dense focus panel did not promote the chosen opponent’s four stable slots.');

  return { ownPeek: 'auto', opponentPeek: 'auto', blindSwap: 'numbered two taps', blackKing: 'numbered reveal then swap', denseEightPlayerTargets: '7 opponents then 4 stable slots' };
}
