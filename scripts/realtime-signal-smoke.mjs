import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { config } from 'dotenv';
import { Redis } from '@upstash/redis';

config({ path: '.env.preview.local', quiet: true });

const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
if (!redisUrl || !redisToken) throw new Error('Upstash Realtime smoke credentials are unavailable.');

const redis = new Redis({ url: redisUrl, token: redisToken });
const channel = `cambrio:signal-smoke:${randomUUID()}`;
const revision = Date.now();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 8_000);

try {
  const response = await fetch(`${redisUrl.replace(/\/$/, '')}/subscribe/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`Upstash subscription returned ${response.status}.`);
  const frames = signalFrames(response.body);
  try {
    await nextMatchingFrame(frames, (frame) => Array.isArray(frame) && frame[0] === 'subscribe');

    const started = performance.now();
    await redis.publish(channel, JSON.stringify({ revision }));
    const delivered = await nextMatchingFrame(frames, (frame) => {
      if (!Array.isArray(frame) || frame[0] !== 'message') return false;
      const payload = typeof frame[2] === 'string' ? JSON.parse(frame[2]) : frame[2];
      return payload?.revision === revision;
    });
    if (!delivered) throw new Error('Published room signal did not reach the subscription stream.');
    console.log(JSON.stringify({ ok: true, transport: 'Upstash publish/subscribe SSE', deliveryMs: Math.round(performance.now() - started) }));
  } finally {
    await frames.return(undefined).catch(() => undefined);
  }
} finally {
  clearTimeout(timeout);
  controller.abort();
}

async function* signalFrames(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        try {
          yield JSON.parse(raw);
        } catch {
          const firstComma = raw.indexOf(',');
          const secondComma = raw.indexOf(',', firstComma + 1);
          if (firstComma > 0 && secondComma > firstComma) yield [raw.slice(0, firstComma), raw.slice(firstComma + 1, secondComma), raw.slice(secondComma + 1)];
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function nextMatchingFrame(frames, matches) {
  while (true) {
    const { value, done } = await frames.next();
    if (done) return undefined;
    if (matches(value)) return value;
  }
}
