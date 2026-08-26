import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';
import { ZodError } from 'zod';
import { GameRuleError } from '../src/shared/game.js';
import {
  gameActionSchema,
  roomActionSchema,
  type ActionAck,
  type GameAction,
  type RoomAction,
  type RoomView,
  type ServerNotice,
} from '../src/shared/protocol.js';
import { createPersistence } from '../src/server/persistence.js';
import { RoomManager, type Membership, type RoomRuntime } from '../src/server/rooms.js';
import { AuthService, type ServerIdentity } from '../src/server/auth.js';

type RealtimeRequest =
  | { operation: 'sync'; membership?: Membership; presence?: boolean }
  | { operation: 'action'; event: 'room:action' | 'game:action'; payload: unknown; membership?: Membership };

interface RealtimeResponse {
  ack?: ActionAck;
  connected: true;
  membership?: Membership;
  state?: RoomView;
  notices?: ServerNotice[];
  left?: { message: string };
}

const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : undefined;
const PRESENCE_STALE_MS = 18_000;
const MAX_REQUEST_BYTES = 32 * 1024;

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed.' }, { status: 405 });
    if (!redis) return Response.json({ error: 'Realtime storage is not configured.' }, { status: 503 });
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'Origin not allowed.' }, { status: 403 });
    if (request.headers.get('sec-fetch-site') === 'cross-site') return Response.json({ error: 'Cross-site requests are not allowed.' }, { status: 403 });
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) return Response.json({ error: 'Request too large.' }, { status: 413 });
    let body: RealtimeRequest;
    try {
      body = JSON.parse(rawBody) as RealtimeRequest;
    } catch {
      return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
    }

    try {
      const identity = await identityFromRequest(request);
      const response = body.operation === 'sync'
        ? await synchronize(identity, body.membership, body.presence)
        : await performAction(identity, body);
      return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      const ack = toAck('unknown', error);
      return Response.json({ connected: true, ack } satisfies RealtimeResponse, { status: 200, headers: { 'Cache-Control': 'no-store' } });
    }
  },
};

async function synchronize(identity: ServerIdentity, membership?: Membership, presence = false): Promise<RealtimeResponse> {
  if (!membership) return { connected: true };
  const manager = new RoomManager(createPersistence());
  const room = await manager.get(membership.roomCode);
  if (!room || !ownsSeat(room, membership, identity)) return { connected: true, left: membershipLoss(room, membership) };
  if (presence || nextDeadline(room) <= Date.now()) {
    return withRoomLock(membership.roomCode, async () => {
      const lockedManager = new RoomManager(createPersistence());
      let lockedRoom = await lockedManager.get(membership.roomCode);
      if (!lockedRoom || !ownsSeat(lockedRoom, membership, identity)) return { connected: true, left: membershipLoss(lockedRoom, membership) };
      if (presence) {
        const now = Date.now();
        await lockedManager.heartbeat(membership.roomCode, membership.playerId, now, PRESENCE_STALE_MS);
        lockedRoom = (await lockedManager.get(membership.roomCode))!;
      }
      await lockedManager.tick(Date.now());
      const current = await lockedManager.get(membership.roomCode);
      return current && ownsSeat(current, membership, identity)
        ? { connected: true, membership, state: lockedManager.view(current, membership.playerId) }
        : { connected: true, left: membershipLoss(current, membership) };
    });
  }
  return { connected: true, membership, state: manager.view(room, membership.playerId) };
}

async function performAction(identity: ServerIdentity, body: Extract<RealtimeRequest, { operation: 'action' }>): Promise<RealtimeResponse> {
  const action = body.event === 'room:action' ? roomActionSchema.parse(body.payload) : gameActionSchema.parse(body.payload);
  await enforceActionRate(identity.userId);
  const code = actionCode(action, body.membership);
  const lockKey = code ?? `create:${identity.userId}`;

  return withRoomLock(lockKey, async () => {
    const manager = new RoomManager(createPersistence());
    if (code) {
      const room = await manager.get(code);
      if (body.membership && (!room || !ownsSeat(room, body.membership, identity))) {
        return { connected: true, ack: { clientActionId: action.clientActionId, ok: false, code: 'NOT_IN_ROOM', message: 'Rejoin this room before acting.' } };
      }
      if (body.membership) await manager.heartbeat(body.membership.roomCode, body.membership.playerId, Date.now(), PRESENCE_STALE_MS);
    }

    const result = body.event === 'room:action'
      ? await manager.handleRoomAction(identity, body.membership, action as RoomAction)
      : await manager.handleGameAction(body.membership, action as GameAction);
    const membership = result.membership;
    const notices = resultNotices(result.message, result.effects);
    if (!membership) {
      return { connected: true, ack: { clientActionId: action.clientActionId, ok: true }, notices, left: body.membership ? { message: 'You left the table.' } : undefined };
    }
    await manager.heartbeat(membership.roomCode, membership.playerId, Date.now(), PRESENCE_STALE_MS);
    const room = await manager.get(membership.roomCode);
    return {
      connected: true,
      ack: {
        clientActionId: action.clientActionId,
        ok: true,
        outcome: result.effects?.find((effect) => effect.type === 'stack' || effect.type === 'penalty' || effect.type === 'stack_lock')?.type,
      },
      membership,
      state: room ? manager.view(room, membership.playerId) : undefined,
      notices,
    };
  });
}

async function withRoomLock<T>(code: string, operation: () => Promise<T>): Promise<T> {
  if (!redis) throw new Error('REALTIME_UNAVAILABLE');
  const key = `cambrio:lock:${code.toUpperCase()}`;
  const owner = nanoid();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const acquired = await redis.set(key, owner, { nx: true, px: 5_000 });
    if (acquired) {
      try {
        return await operation();
      } finally {
        await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [key],
          [owner],
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 7));
  }
  throw new GameRuleError('RATE_LIMIT', 'The table is resolving another move. Try again.');
}

async function enforceActionRate(userId: string): Promise<void> {
  if (!redis) return;
  const bucket = Math.floor(Date.now() / 10_000);
  const key = `cambrio:rate:${userId}:${bucket}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 12);
  if (count > 60) throw new GameRuleError('RATE_LIMIT', 'Too many actions. Pause for a moment.');
}

async function identityFromRequest(request: Request): Promise<ServerIdentity> {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    const persistence = createPersistence();
    return new AuthService(persistence).authenticate(token, request.headers.get('x-visitor-id') ?? undefined);
  }
  const visitorId = request.headers.get('x-visitor-id')?.match(/^[a-zA-Z0-9_-]{10,64}$/)?.[0];
  if (!visitorId) throw new Error('AUTH_REQUIRED');
  // Preserve the legacy visitor namespace for unsigned hosted sessions so an
  // in-progress guest room survives a deployment that adds token support.
  const userId = `web_${visitorId}`;
  const profile = await createPersistence().getProfileByUser(userId);
  return profile ?? { userId, anonymous: true };
}

function actionCode(action: RoomAction | GameAction, membership?: Membership): string | undefined {
  if (action.type === 'ROOM_JOIN') return action.code;
  if (action.type === 'ROOM_CREATE') return undefined;
  return membership?.roomCode;
}

function ownsSeat(room: RoomRuntime, membership: Membership, identity: ServerIdentity): boolean {
  const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === membership.playerId);
  return Boolean(player && player.userId === identity.userId);
}

function membershipLoss(room: RoomRuntime | undefined, membership: Membership): { message: string } {
  const seatStillExists = room && [...room.players, ...room.waiting].some((candidate) => candidate.id === membership.playerId);
  return {
    message: room && !seatStillExists
      ? 'The host removed your seat from this table.'
      : 'This room expired or your seat is no longer available.',
  };
}

function nextDeadline(room: RoomRuntime): number {
  if (!room.game || room.game.phase === 'results' || room.pause) return Infinity;
  if (room.game.phase === 'initial_peek') return room.initialPeekDeadlineAt ?? Infinity;
  return room.game.transfer?.deadlineAt ?? room.game.turn?.deadlineAt ?? Infinity;
}

function resultNotices(message?: string, effects: Array<{ type: string; message?: string; playerId?: string }> = []): ServerNotice[] | undefined {
  const notices = effects.flatMap((effect) => effect.message ? [{ kind: effect.type, message: effect.message, playerId: effect.playerId } as ServerNotice] : []);
  if (message) notices.unshift({ kind: 'info', message });
  return notices.length ? notices : undefined;
}

function toAck(clientActionId: string, error: unknown): ActionAck {
  if (error instanceof GameRuleError) return { clientActionId, ok: false, code: error.code, message: error.message };
  if (error instanceof ZodError) return { clientActionId, ok: false, code: 'INVALID_ACTION', message: error.issues[0]?.message ?? 'Invalid action.' };
  console.error(error);
  return { clientActionId, ok: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' };
}
