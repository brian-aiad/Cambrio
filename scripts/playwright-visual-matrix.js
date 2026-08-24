/* eslint-disable @typescript-eslint/no-unused-expressions */
async (page) => {
  const root = 'output/playwright/final';
  const base = 'http://localhost:5173/__visual-audit';
  const slug = (value) => value.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const capture = async (scene, players, viewport, suffix = '', wait = 420) => {
    await page.setViewportSize(viewport);
    await page.goto(`${base}?scene=${scene}&players=${players}`);
    await page.waitForTimeout(wait);
    const name = `${slug(scene)}-${players}p-${viewport.width}x${viewport.height}${suffix}.png`;
    await page.screenshot({ path: `${root}/${name}`, fullPage: scene === 'results' || scene === 'cards' });
  };

  const coreScenes = [
    'initial', 'awaiting', 'drawn', 'own-select', 'own-reveal', 'opponent-select',
    'opponent-reveal', 'blind-own', 'blind-opponent', 'black-own',
    'black-opponent', 'black-reveal', 'transfer', 'ending', 'six', 'zero', 'results',
  ];
  for (const scene of coreScenes) await capture(scene, scene === 'results' ? 2 : 4, { width: 390, height: 844 }, '', scene.includes('reveal') ? 180 : 420);
  await capture('black-choice', 4, { width: 390, height: 844 }, '', 1_850);

  for (let players = 2; players <= 8; players += 1) await capture('awaiting', players, { width: 390, height: 844 });

  const devices = [
    { width: 320, height: 568 },
    { width: 414, height: 896 },
    { width: 844, height: 390 },
    { width: 1440, height: 900 },
  ];
  for (const viewport of devices) {
    await capture('drawn', 2, viewport);
    await capture('awaiting', 8, viewport);
    await capture('opponent-reveal', 4, viewport, '', 180);
    await capture('blind-opponent', 4, viewport);
    await capture('results', 2, viewport);
  }
  await capture('cards', 2, { width: 390, height: 844 });
  await capture('cards', 2, { width: 1440, height: 900 });
  await capture('ending', 8, { width: 320, height: 568 });
  await capture('ending', 8, { width: 844, height: 390 });
  await capture('results', 8, { width: 390, height: 844 });

  return { screenshots: coreScenes.length + 1 + 7 + devices.length * 5 + 5 };
}
