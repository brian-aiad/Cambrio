import { Redis } from '@upstash/redis';
import { AuthService, type ServerIdentity } from '../src/server/auth.js';
import { createPersistence } from '../src/server/persistence.js';
import { RoomManager, type Membership, type RoomRuntime } from '../src/server/rooms.js';
import { roomCodeSchema, roomSignalChannel } from '../src/shared/protocol.js';

const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : undefined;
const MAX_REQUEST_BYTES = 2 * 1024;

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    if (!redis || !redisUrl || !redisToken) return Response.json({ error: 'Live signals are not configured.' }, { status: 503 });
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
    if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'Cross-site requests are not allowed.' }, { status: 403 });
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });

    let membership: Membership | undefined;
    try {
      const parsed = JSON.parse(rawBody) as { membership?: Membership };
      const code = roomCodeSchema.parse(parsed.membership?.roomCode);
      if (!parsed.membership?.playerId || typeof parsed.membership.waiting !== 'boolean') throw new Error('INVALID_MEMBERSHIP');
      membership = { ...parsed.membership, roomCode: code };
    } catch {
      return Response.json({ error: 'Invalid room membership.' }, { status: 400 });
    }

    let identity: ServerIdentity;
    try {
      identity = await identityFromRequest(request);
    } catch {
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    }
    const manager = new RoomManager(createPersistence());
    const room = await manager.get(membership.roomCode);
    if (!room || !ownsSeat(room, membership, identity)) return Response.json({ error: 'Room membership is no longer active.' }, { status: 403 });

    const upstream = await fetch(`${redisUrl.replace(/\/$/, '')}/subscribe/${encodeURIComponent(roomSignalChannel(membership.roomCode))}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${redisToken}`, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) return Response.json({ error: 'Live signal stream could not start.' }, { status: 502 });
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  },
};

async function identityFromRequest(request: Request): Promise<ServerIdentity> {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) return new AuthService(createPersistence()).authenticate(token, request.headers.get('x-visitor-id') ?? undefined);
  const visitorId = request.headers.get('x-visitor-id')?.match(/^[a-zA-Z0-9_-]{10,64}$/)?.[0];
  if (!visitorId) throw new Error('AUTH_REQUIRED');
  const userId = `web_${visitorId}`;
  const profile = await createPersistence().getProfileByUser(userId);
  return profile ?? { userId, anonymous: true };
}

function ownsSeat(room: RoomRuntime, membership: Membership, identity: ServerIdentity): boolean {
  const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === membership.playerId);
  return Boolean(player && player.userId === identity.userId);
}
