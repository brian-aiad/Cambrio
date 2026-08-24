/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'C:/Users/kingt/Desktop/cambrio/output/playwright/iteration';
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5173/__visual-audit?scene=own-select&players=4');
  await page.waitForTimeout(500);
  await page.locator('.self-zone [data-card-id="p0-card-2"]').click();
  await page.waitForTimeout(180);
  if (await page.locator('.playing-card:not(.face-down)').count() !== 2) throw new Error('Own peek did not reveal exactly one hand card plus the discard.');
  if (!(await page.locator('.interaction-prompt').textContent())?.includes('Memorize')) throw new Error('Own peek does not show the timed memory prompt.');
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
  if (!(await page.locator('.interaction-prompt').textContent())?.includes('Swap positions?')) throw new Error('Black King did not advance to the swap-or-keep choice.');
  await page.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.waitForTimeout(160);
  if (await page.locator('.card-flight').count() !== 2) throw new Error('Black King swap did not launch two exact-position card flights.');
  const kingLabels = await page.locator('.flight-endpoint em').allTextContents();
  if (!kingLabels.includes('Brian TR') || !kingLabels.includes('Alex BL')) throw new Error(`Black King flight endpoints are incomplete: ${kingLabels.join(', ')}`);
  await page.screenshot({ path: `${root}/black-king-swap-flight.png` });
  if (await page.locator('.self-zone [data-card-id="p1-card-2"]').count() !== 1) throw new Error('Black King swap did not preserve the selected self slot.');
  if (await page.locator('.opponent-rail [data-card-id="p0-card-1"]').count() !== 1) throw new Error('Black King swap did not preserve the selected opponent slot.');

  return { ownPeek: 'auto', opponentPeek: 'auto', blindSwap: 'two taps', blackKing: 'reveal then swap' };
}
