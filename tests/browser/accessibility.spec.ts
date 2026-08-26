import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const routes = [
  { name: 'home', path: '/' },
  { name: 'initial peek', path: '/__visual-audit?scene=initial&players=8' },
  { name: 'active table', path: '/__visual-audit?scene=awaiting&players=8' },
  { name: 'draw decision', path: '/__visual-audit?scene=drawn&players=8' },
  { name: 'black king choice', path: '/__visual-audit?scene=black-choice&players=8' },
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
