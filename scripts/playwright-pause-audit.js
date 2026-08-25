/* eslint-disable @typescript-eslint/no-unused-expressions, no-undef */
async (page) => {
  const root = 'output/playwright/pause';
  const checks = [];
  const capture = async (scene, players, viewport) => {
    await page.setViewportSize(viewport);
    await page.goto(`http://localhost:5173/__visual-audit?scene=${scene}&players=${players}`);
    await page.waitForTimeout(180);
    const result = await page.evaluate(() => {
      const deck = document.querySelector('.deck-card');
      return {
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        pausedTitle: document.querySelector('.turn-banner.paused strong')?.textContent,
        pausedTimer: document.querySelector('.countdown.paused')?.getAttribute('aria-label'),
        pauseBanner: Boolean(document.querySelector('.pause-banner')),
        visiblePauseBanner: Boolean(document.querySelector('.pause-banner')?.getClientRects().length),
        interactiveCards: document.querySelectorAll('.playing-card.interactive').length,
        drawDisabled: deck instanceof HTMLButtonElement ? deck.disabled : true,
        cambioButtons: document.querySelectorAll('.cambio-button').length,
        holdButtons: document.querySelectorAll('.hold-button').length,
      };
    });
    if (result.width > result.viewport + 1) throw new Error(`Pause scene overflowed ${viewport.width}x${viewport.height}.`);
    const unsafeTable = scene === 'paused' && (!result.pausedTitle?.includes('disconnected') || !result.pausedTimer || result.interactiveCards || !result.drawDisabled || result.cambioButtons);
    const unsafePeek = scene === 'initial-paused' && (!result.pauseBanner || result.holdButtons);
    if (unsafeTable || unsafePeek) {
      throw new Error(`Pause controls are unsafe: ${JSON.stringify(result)}`);
    }
    if (scene === 'initial-paused' && !result.pauseBanner) throw new Error('The initial-peek pause has no reconnect status.');
    if (scene === 'paused' && viewport.height > 680 && !result.visiblePauseBanner) throw new Error('The tall table has no central pause signal.');
    if (scene === 'paused' && viewport.height <= 680 && result.visiblePauseBanner) throw new Error('The compact pause signal covers the table on a short phone.');
    await page.screenshot({ path: `${root}/${scene}-${players}p-${viewport.width}x${viewport.height}.png` });
    checks.push({ scene, players, viewport: `${viewport.width}x${viewport.height}`, ...result });
  };

  await capture('paused', 2, { width: 390, height: 844 });
  await capture('paused', 8, { width: 390, height: 844 });
  await capture('paused', 8, { width: 320, height: 568 });
  await capture('paused', 8, { width: 844, height: 390 });
  await capture('initial-paused', 8, { width: 390, height: 844 });
  return checks;
}
