import { test } from '@playwright/test';
import runLiveEightAudit from '../../scripts/playwright-live-eight-audit.js';

test('self-contained eight-player gameplay continuity audit', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const result = await runLiveEightAudit(page);
  await testInfo.attach('eight-player-audit.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});
