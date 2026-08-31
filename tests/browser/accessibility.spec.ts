import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const routes = [
  { name: 'home', path: '/' },
  { name: 'initial peek', path: '/__visual-audit?scene=initial&players=8' },
  { name: 'active table', path: '/__visual-audit?scene=awaiting&players=8' },
  { name: 'draw decision', path: '/__visual-audit?scene=drawn&players=8' },
  { name: 'opponent power targeting', path: '/__visual-audit?scene=opponent-select&players=8' },
  { name: 'mandatory transfer', path: '/__visual-audit?scene=transfer&players=8' },
  { name: 'black king choice', path: '/__visual-audit?scene=black-choice&players=8' },
  { name: 'paused table', path: '/__visual-audit?scene=paused&players=8' },
  { name: 'zero-card ending', path: '/__visual-audit?scene=zero&players=8' },
  { name: 'forfeited seat', path: '/__visual-audit?scene=forfeited&players=8' },
  { name: 'results', path: '/__visual-audit?scene=results-tie&players=8' },
] as const;

for (const route of routes) {
  test(`${route.name} has no automatically detectable WCAG A/AA violations`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(route.path);
    await page.waitForTimeout(route.name === 'initial peek' ? 700 : 250);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations, results.violations.map((violation) =>
      `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  ${node.target.join(' ')} — ${node.failureSummary}`).join('\n')}`,
    ).join('\n\n')).toEqual([]);
  });
}

test('how-to-play guide has no automatically detectable WCAG A/AA violations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: /how to play cambrio/i }).click();
  await expect(page.getByRole('dialog', { name: /remember\. trade\. stack\./i })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, results.violations.map((violation) =>
    `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => `  ${node.target.join(' ')} — ${node.failureSummary}`).join('\n')}`,
  ).join('\n\n')).toEqual([]);
});

test('keyboard-only power targeting reaches a named legal card and activates it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/__visual-audit?scene=opponent-select&players=8');
  const firstOpponent = page.locator('.target-focus-control').first();
  await expect(firstOpponent).toBeVisible();

  for (let press = 0; press < 20; press += 1) {
    if (await firstOpponent.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(firstOpponent).toBeFocused();
  await expect(firstOpponent).toHaveAccessibleName(/Alex.*choose this opponent/i);
  await page.keyboard.press('Enter');
  const firstLegalTarget = page.locator('.dense-target-panel .playing-card.target-option').first();
  await expect(firstLegalTarget).toBeVisible();
  await firstLegalTarget.focus();
  await expect(firstLegalTarget).toBeFocused();
  await expect(firstLegalTarget).toHaveAccessibleName(/tap to peek/i);
  await page.keyboard.press('Enter');
  await expect(page.locator('.opponent-rail .playing-card:not(.face-down)')).toHaveCount(1);
});

test('forced-colors mode preserves focus and non-color target instructions', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await page.goto('/__visual-audit?scene=black-opponent&players=8');
  const target = page.locator('.opponent-rail .playing-card.target-option').first();
  for (let press = 0; press < 20; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  await expect(target).toHaveAccessibleName(/swap target 2/i);
  expect(await target.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await expect(page.locator('.interaction-prompt')).toContainText(/choose an opponent/i);
});
