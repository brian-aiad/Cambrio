import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { ZodError } from 'zod';
import { GameRuleError } from '../shared/game.js';
import { gameActionSchema, handleSchema, roomActionSchema, displayNameSchema, type ActionAck, type ServerNotice } from '../shared/protocol.js';
import { AuthService, type ServerIdentity } from './auth.js';
import { createPersistence } from './persistence.js';
import { RoomManager, type Membership } from './rooms.js';

const port = Number(process.env.PORT ?? 3001);
const production = process.env.NODE_ENV === 'production';
const clientOrigin = process.env.CLIENT_ORIGIN || (production ? undefined : 'http://localhost:5173');
const supabaseOrigin = safeOrigin(process.env.SUPABASE_URL);
const persistence = createPersistence();
const auth = new AuthService(persistence);
const rooms = new RoomManager(persistence);
const app = express();
const server = createServer(app);
const corsOptions = clientOrigin ? { origin: clientOrigin, credentials: true } : undefined;
const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
  ...(corsOptions ? { cors: corsOptions } : {}),
  pingInterval: 5_000,
  pingTimeout: 7_000,
  maxHttpBufferSize: 32 * 1024,
  perMessageDeflate: false,
  connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: false },
});

interface SocketData {
  identity: ServerIdentity;
  membership?: Membership;
}
interface ClientToServerEvents {
  'room:action': (payload: unknown, ack?: (result: ActionAck) => void) => void;
  'game:action': (payload: unknown, ack?: (result: ActionAck) => void) => void;
}
interface ServerToClientEvents {
  'room:state': (state: ReturnType<RoomManager['view']>) => void;
  'room:left': (value: { message: string }) => void;
  notice: (notice: ServerNotice) => void;
}

app.use(helmet({
  contentSecurityPolicy: production
    ? {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'", 'https://challenges.cloudflare.com', ...(supabaseOrigin ? [supabaseOrigin] : [])],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
          frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      }
    : false,
}));
if (corsOptions) app.use(cors(corsOptions));
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'cambrio', auth: auth.productionAuth ? 'supabase' : 'development' });
});

app.get('/api/profiles/:handle', async (request, response) => {
  const parsed = handleSchema.safeParse(request.params.handle);
  if (!parsed.success) return response.status(400).json({ error: 'Invalid handle.' });
  const profile = await persistence.getProfileByHandle(parsed.data);
  if (!profile || profile.anonymous) return response.status(404).json({ error: 'Profile not found.' });
  return response.json(profile);
});

app.get('/api/me', async (request, response) => {
  try {
    const identity = await identityFromRequest(request.headers.authorization, request.headers['x-visitor-id'] as string | undefined);
    const stats = await persistence.getStats(identity.userId);
    response.json({ ...identity, stats });
  } catch {
    response.status(401).json({ error: 'Authentication required.' });
  }
});

app.put('/api/me/profile', async (request, response) => {
  try {
    const identity = await identityFromRequest(request.headers.authorization, request.headers['x-visitor-id'] as string | undefined);
    const handle = handleSchema.parse(request.body.handle);
    const displayName = displayNameSchema.parse(request.body.displayName);
    const profile = await auth.saveProfile(identity, { handle, displayName });
    response.json(profile);
  } catch (error) {
    const message = error instanceof Error && error.message === 'HANDLE_TAKEN' ? 'That handle is already taken.' : 'Unable to save profile.';
    response.status(message.includes('taken') ? 409 : 400).json({ error: message });
  }
});

io.use(async (socket, next) => {
  try {
    socket.data.identity = await auth.authenticate(socket.handshake.auth.token, socket.handshake.auth.visitorId);
    next();
  } catch (error) {
    next(error instanceof Error ? error : new Error('Authentication failed.'));
  }
});

io.on('connection', (socket) => {
  if (socket.recovered && socket.data.membership) {
    const membership = socket.data.membership;
    void rooms.reconnect(membership.roomCode, membership.playerId).then(() => broadcast(membership.roomCode));
  }
  const packetTimes: number[] = [];
  const actionTimes = new Map<string, number>();
  const packetRateLimited = () => {
    const now = Date.now();
    while (packetTimes.length && packetTimes[0] < now - 10_000) packetTimes.shift();
    packetTimes.push(now);
    return packetTimes.length > 200;
  };
  const rateLimited = (clientActionId: string) => {
    const now = Date.now();
    for (const [id, receivedAt] of actionTimes) {
      if (receivedAt < now - 10_000) actionTimes.delete(id);
    }
    // Idempotent retries share one clientActionId and are one logical decision.
    // A connection still cannot bypass the limit by sending unique IDs.
    if (!actionTimes.has(clientActionId)) actionTimes.set(clientActionId, now);
    return actionTimes.size > 40;
  };
  socket.on('room:action', async (payload, ack) => {
    let clientActionId = 'unknown';
    try {
      if (packetRateLimited()) throw new GameRuleError('RATE_LIMIT', 'Too many actions. Pause for a moment.');
      const action = roomActionSchema.parse(payload);
      clientActionId = action.clientActionId;
      if (rateLimited(clientActionId)) throw new GameRuleError('RATE_LIMIT', 'Too many actions. Pause for a moment.');
      const previousMembership = socket.data.membership;
      const result = await rooms.handleRoomAction(socket.data.identity, previousMembership, action);
      if (previousMembership && previousMembership.roomCode !== result.membership?.roomCode) socket.leave(roomChannel(previousMembership.roomCode));
      socket.data.membership = result.membership;
      if (result.membership) await socket.join(roomChannel(result.membership.roomCode));
      ack?.({ clientActionId, ok: true });
      if (result.message) socket.emit('notice', { kind: 'info', message: result.message });
      await broadcast(result.membership?.roomCode ?? previousMembership?.roomCode);
    } catch (error) {
      ack?.(toAck(clientActionId, error));
    }
  });

  socket.on('game:action', async (payload, ack) => {
    let clientActionId = 'unknown';
    try {
      if (packetRateLimited()) throw new GameRuleError('RATE_LIMIT', 'Too many actions. Pause for a moment.');
      const action = gameActionSchema.parse(payload);
      clientActionId = action.clientActionId;
      if (rateLimited(clientActionId)) throw new GameRuleError('RATE_LIMIT', 'Too many actions. Pause for a moment.');
      const result = await rooms.handleGameAction(socket.data.membership, action);
      const outcome = result.effects?.find((effect) => effect.type === 'stack' || effect.type === 'penalty' || effect.type === 'stack_lock')?.type;
      for (const effect of result.effects ?? []) {
        if (effect.message) io.to(roomChannel(socket.data.membership!.roomCode)).emit('notice', { kind: effect.type, message: effect.message, playerId: effect.playerId });
      }
      await broadcast(socket.data.membership?.roomCode);
      // State is emitted before acknowledgement so a chained interaction (the
      // initial peek release in particular) reads the newly authoritative version.
      ack?.({ clientActionId, ok: true, outcome });
    } catch (error) {
      ack?.(toAck(clientActionId, error));
    }
  });

  socket.on('disconnect', async () => {
    const membership = socket.data.membership;
    if (!membership) return;
    const otherSockets = await io.in(roomChannel(membership.roomCode)).fetchSockets();
    const sameSeatConnected = otherSockets.some((candidate) => candidate.id !== socket.id && candidate.data.membership?.playerId === membership.playerId);
    if (!sameSeatConnected) await rooms.disconnect(membership.roomCode, membership.playerId);
    await broadcast(membership.roomCode);
  });
});

async function broadcast(code?: string): Promise<void> {
  if (!code) return;
  const room = await rooms.get(code);
  if (!room) return;
  const sockets = await io.in(roomChannel(code)).fetchSockets();
  for (const socket of sockets) {
    const playerId = socket.data.membership?.playerId;
    if (!playerId) continue;
    try {
      socket.emit('room:state', rooms.view(room, playerId));
    } catch {
      socket.data.membership = undefined;
      await socket.leave(roomChannel(code));
      socket.emit('room:left', { message: 'The host removed your seat from this table.' });
    }
  }
}

setInterval(async () => {
  const changed = await rooms.tick();
  for (const code of changed) await broadcast(code);
}, 500).unref();

if (production) {
  const clientDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
  app.use(express.static(clientDirectory));
  app.get('*path', (_request, response) => response.sendFile(path.join(clientDirectory, 'index.html')));
}

server.listen(port, '0.0.0.0', () => {
  console.log(`Cambrio server listening on http://0.0.0.0:${port}`);
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing realtime connections.`);
  const forcedExit = setTimeout(() => process.exit(1), 10_000);
  forcedExit.unref();
  io.close(() => server.close(() => process.exit(0)));
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

function roomChannel(code: string): string {
  return `room:${code}`;
}

function safeOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function identityFromRequest(authorization?: string, visitorId?: string): Promise<ServerIdentity> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  return auth.authenticate(token, visitorId);
}

function toAck(clientActionId: string, error: unknown): ActionAck {
  if (error instanceof GameRuleError) return { clientActionId, ok: false, code: error.code, message: error.message };
  if (error instanceof ZodError) return { clientActionId, ok: false, code: 'INVALID_ACTION', message: error.issues[0]?.message ?? 'Invalid action.' };
  console.error(error);
  return { clientActionId, ok: false, code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' };
}
