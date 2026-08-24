import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const roomCount = Number(process.env.CAMBRIO_LOAD_ROOMS ?? 12);
const playersPerRoom = 8;
const server = process.env.CAMBRIO_LOAD_URL ?? 'http://localhost:3001';
const sockets = [];
const startedAt = performance.now();

const connect = (visitorId) => new Promise((resolve, reject) => {
  const socket = io(server, { auth: { visitorId }, transports: ['websocket'] });
  sockets.push(socket);
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
});
const action = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(8_000).emit(event, { ...payload, clientActionId: randomUUID(), expectedVersion: 0 }, (error, ack) => {
    if (error || !ack?.ok) reject(error ?? new Error(ack?.message ?? 'Action failed'));
    else resolve(ack);
  });
});
const waitState = (socket, predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.off('room:state', listener); reject(new Error('State timeout')); }, 10_000);
  const listener = (value) => {
    if (!predicate(value)) return;
    clearTimeout(timer);
    socket.off('room:state', listener);
    resolve(value);
  };
  socket.on('room:state', listener);
});

try {
  const rooms = await Promise.all(Array.from({ length: roomCount }, async (_, roomIndex) => {
    const roomSockets = await Promise.all(Array.from({ length: playersPerRoom }, (_, playerIndex) => connect(`load-${roomIndex}-${playerIndex}-${randomUUID()}`)));
    const host = roomSockets[0];
    const createdState = waitState(host, (value) => value.players?.length === 1);
    await action(host, 'room:action', { type: 'ROOM_CREATE', name: `Host ${roomIndex}` });
    const created = await createdState;
    await Promise.all(roomSockets.slice(1).map((socket, playerIndex) => action(socket, 'room:action', { type: 'ROOM_JOIN', code: created.code, name: `P${roomIndex}-${playerIndex + 1}` })));
    await Promise.all(roomSockets.slice(1).map((socket) => action(socket, 'room:action', { type: 'ROOM_READY', ready: true })));
    const dealtState = waitState(host, (value) => value.game?.phase === 'initial_peek' && value.players?.length === playersPerRoom);
    await action(host, 'room:action', { type: 'ROOM_START' });
    const dealt = await dealtState;
    if (dealt.game.players.flatMap((player) => player.cards).some((card) => card.rank)) throw new Error('Hidden card leaked');
    await Promise.all(roomSockets.map(async (socket) => {
      await action(socket, 'game:action', { type: 'INITIAL_PEEK_START' });
      await action(socket, 'game:action', { type: 'INITIAL_PEEK_END' });
    }));
    return created.code;
  }));
  console.log(JSON.stringify({ ok: true, rooms: rooms.length, sockets: sockets.length, playersPerRoom, durationMs: Math.round(performance.now() - startedAt) }));
} finally {
  for (const socket of sockets) socket.disconnect();
}

