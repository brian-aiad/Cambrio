import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const baseUrl = process.env.CAMBRIO_AUDIT_URL ?? 'https://cambrio.vercel.app';
const runLabel = process.env.CAMBRIO_AUDIT_LABEL ?? `sync-${Date.now()}`;
const outputRoot = `output/hosted-sync/${runLabel}`;
const viewport = { width: 390, height: 844 };
const transitions = [];

await mkdir(`${outputRoot}/frames`, { recursive: true });
const browser = await chromium.launch({ headless: true });
const contexts = await Promise.all(['north', 'south'].map(() => browser.newContext({
  viewport,
  recordVideo: { dir: `${outputRoot}/video`, size: viewport },
  reducedMotion: 'no-preference',
  // Vercel's production CSP intentionally blocks Vite's development-only
  // inline React refresh preamble. Keep the site policy strict and bypass it
  // only inside this isolated local recording browser.
  bypassCSP: baseUrl.startsWith('http://localhost'),
})));
const pages = await Promise.all(contexts.map((context) => context.newPage()));
const [north, south] = pages;

for (const [index, context] of contexts.entries()) {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true, title: `${runLabel}-${index === 0 ? 'north' : 'south'}` });
}

try {
  await north.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await north.getByLabel('Your display name').fill('Sync North');
  await north.getByRole('button', { name: /create private room/i }).click();
  await north.waitForURL(/\/room\/[A-HJ-NP-Z2-9]{8}$/);
  const code = north.url().split('/').at(-1);

  await south.goto(`${baseUrl}/room/${code}`, { waitUntil: 'domcontentloaded' });
  await south.getByLabel('Your display name').fill('Sync South');
  await south.getByRole('button', { name: /join room/i }).click();
  await south.getByRole('button', { name: /ready up/i }).click();
  await north.getByRole('button', { name: /deal the cards/i }).click();
  await Promise.all(pages.map(completeInitialPeek));
  await Promise.all(pages.map((page) => page.locator('.game-page').waitFor({ timeout: 20_000 })));

  for (let turn = 0; turn < 6; turn += 1) {
    const actor = await activePage(pages);
    const observer = actor === north ? south : north;
    const actorName = actor === north ? 'Sync North' : 'Sync South';
    const sampleFrames = turn === 0;

    const drawStarted = performance.now();
    const drawFrames = sampleFrames ? sampleTransitionFrames(pages, `${outputRoot}/frames/draw`, 1_200) : Promise.resolve();
    await actor.locator('.deck-card:not(:disabled)').click();
    await actor.locator('.drawn-panel').waitFor({ timeout: 10_000 });
    const actorDrawMs = performance.now() - drawStarted;
    await observer.locator('.opponent-decision-stage').waitFor({ timeout: 10_000 });
    const observerDrawMs = performance.now() - drawStarted;
    await drawFrames;

    const discardStarted = performance.now();
    const discardFrames = sampleFrames ? sampleTransitionFrames(pages, `${outputRoot}/frames/discard`, 1_200) : Promise.resolve();
    await actor.getByRole('button', { name: /^discard$/i }).click();
    await actor.locator('.card-flight[data-flight-to="Discard"]').waitFor({ timeout: 10_000 });
    const actorDiscardMs = performance.now() - discardStarted;
    await observer.locator(`.card-flight[data-flight-from="${actorName}'s draw"][data-flight-to="Discard"]`).waitFor({ timeout: 10_000 });
    const observerDiscardMs = performance.now() - discardStarted;
    await discardFrames;

    const skip = actor.getByRole('button', { name: /skip ability/i });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await waitForNextTurn(pages, actorName);
    transitions.push({
      turn: turn + 1,
      actor: actorName,
      draw: roundedTiming(actorDrawMs, observerDrawMs),
      discard: roundedTiming(actorDiscardMs, observerDiscardMs),
    });
  }

  const summary = {
    baseUrl,
    viewport: `${viewport.width}x${viewport.height}`,
    frameIntervalMs: 80,
    transitions,
    aggregates: {
      actorDrawMs: aggregate(transitions.map((item) => item.draw.actorMs)),
      observerDrawMs: aggregate(transitions.map((item) => item.draw.observerMs)),
      drawScreenGapMs: aggregate(transitions.map((item) => item.draw.screenGapMs)),
      actorDiscardMs: aggregate(transitions.map((item) => item.discard.actorMs)),
      observerDiscardMs: aggregate(transitions.map((item) => item.discard.observerMs)),
      discardScreenGapMs: aggregate(transitions.map((item) => item.discard.screenGapMs)),
    },
  };
  await writeFile(`${outputRoot}/metrics.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} finally {
  await Promise.all(contexts.map((context, index) => context.tracing.stop({ path: `${outputRoot}/${index === 0 ? 'north' : 'south'}.zip` }).catch(() => undefined)));
  await Promise.all(contexts.map((context) => context.close()));
  await browser.close();
}

async function completeInitialPeek(page) {
  const hold = page.getByRole('button', { name: /hold to peek/i });
  await hold.waitFor({ timeout: 20_000 });
  await hold.focus();
  await page.keyboard.down('Space');
  await page.locator('.peek-hand .playing-card:not(.face-down)').first().waitFor({ timeout: 10_000 });
  await page.keyboard.up('Space');
}

async function activePage(candidates) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const page of candidates) {
      if (await page.locator('.deck-card:not(:disabled)').count()) return page;
    }
    await candidates[0].waitForTimeout(50);
  }
  throw new Error('No browser received the active turn within five seconds.');
}

async function waitForNextTurn(candidates, previousActor) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (const page of candidates) {
      const banner = page.locator('.turn-banner.your-turn');
      if (await banner.isVisible().catch(() => false)) {
        const owner = page === candidates[0] ? 'Sync North' : 'Sync South';
        if (owner !== previousActor) return;
      }
    }
    await candidates[0].waitForTimeout(50);
  }
  throw new Error('The next turn did not synchronize within ten seconds.');
}

async function sampleTransitionFrames(candidates, prefix, durationMs) {
  const started = performance.now();
  let frame = 0;
  while (performance.now() - started <= durationMs) {
    const timestamp = String(Math.round(performance.now() - started)).padStart(4, '0');
    await Promise.all(candidates.map((page, index) => page.screenshot({ path: `${prefix}-${index === 0 ? 'north' : 'south'}-${timestamp}-${String(frame).padStart(2, '0')}.png` })));
    frame += 1;
    const remaining = 80 - ((performance.now() - started) % 80);
    if (remaining > 1) await candidates[0].waitForTimeout(remaining);
  }
}

function roundedTiming(actorMs, observerMs) {
  return {
    actorMs: Math.round(actorMs),
    observerMs: Math.round(observerMs),
    screenGapMs: Math.round(observerMs - actorMs),
  };
}

function aggregate(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * .95) - 1],
    max: sorted.at(-1),
  };
}
