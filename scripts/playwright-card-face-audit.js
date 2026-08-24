/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'output/playwright/iteration';
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('http://localhost:5173/__visual-audit?scene=cards&players=2');
  await page.waitForTimeout(500);
  const cards = page.locator('.card-gallery .playing-card');
  if (await cards.count() !== 52) throw new Error('Card gallery does not contain all 52 faces.');
  const defects = await cards.evaluateAll((elements) => elements.flatMap((element, index) => {
    const surface = element.querySelector('.card-front')?.getBoundingClientRect();
    const corner = element.querySelector('.corner')?.getBoundingClientRect();
    const center = element.querySelector('.center-suit')?.getBoundingClientRect();
    const suitCount = element.querySelectorAll('svg.suit-mark').length;
    const vectorParts = element.querySelectorAll('svg.suit-mark path, svg.suit-mark circle').length;
    if (!surface || !corner || !center) return [`${index}:missing face region`];
    const inside = (box) => box.left >= surface.left - .5 && box.top >= surface.top - .5 && box.right <= surface.right + .5 && box.bottom <= surface.bottom + .5;
    return suitCount === 2 && vectorParts >= 2 && inside(corner) && inside(center) ? [] : [`${index}:suits=${suitCount},parts=${vectorParts},corner=${inside(corner)},center=${inside(center)}`];
  }));
  if (defects.length) throw new Error(`Card face geometry failed: ${defects.join('; ')}`);
  await page.screenshot({ path: `${root}/all-52-vector-faces.png`, fullPage: true });
  await page.getByRole('button', { name: 'Q of hearts' }).screenshot({ path: `${root}/queen-heart-final.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/__visual-audit?scene=results&players=2');
  await page.waitForTimeout(500);
  const miniCards = page.locator('.result-cards .playing-card');
  if (await miniCards.count() !== 11) throw new Error('Results fixture does not contain the expected eleven mini cards.');
  if (await miniCards.locator('svg.center-suit').count() !== 11) throw new Error('A mini result card lost its vector center suit.');
  await page.screenshot({ path: `${root}/results-vector-faces-390x844.png`, fullPage: true });

  return { faces: 52, vectorSuits: 'all', miniCards: 11 };
}
