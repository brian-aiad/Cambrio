export default {
  fetch() {
    const redisReady = Boolean(
      (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)
      && (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN),
    );
    return Response.json({ ok: redisReady, service: 'cambrio', transport: 'http-realtime', state: redisReady ? 'redis' : 'unconfigured' }, { status: redisReady ? 200 : 503 });
  },
};
