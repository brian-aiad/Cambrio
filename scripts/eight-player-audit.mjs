import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const code = process.argv[2]?.toUpperCase();
const server = process.env.CAMBRIO_LOAD_URL ?? 'http://localhost:3001';
if (!code) throw new Error('Pass a room code: npm run audit:eight -- ABCD2345');

const sockets = [];
const action = (socket, event, payload, expectedVersion = 0) => new Promise((resolve, reject) => {
  socket.timeout(8_000).emit(event, { ...payload, clientActionId: randomUUID(), expectedVersion }, (error, ack) => {
    if (error || !ack?.ok) reject(error ?? new Error(ack?.message ?? 'Action failed'));
    else resolve(ack);
  });
});
const connect = (index) => new Promise((resolve, reject) => {
  const socket = io(server, { auth: { visitorId: `visual-audit-${code}-${index}-${randomUUID()}` }, transports: ['websocket'] });
  sockets.push(socket);
  socket.once('connect_error', reject);
  socket.once('connect', () => resolve(socket));
});

for (let index = 1; index <= 7; index += 1) {
  const socket = await connect(index);
  await action(socket, 'room:action', { type: 'ROOM_JOIN', code, name: `Friend ${index}` });
  await action(socket, 'room:action', { type: 'ROOM_READY', ready: true });
  let completingPeek = false;
  socket.on('room:state', async (room) => {
    const self = room.game?.players.find((player) => player.id === room.selfPlayerId);
    if (room.game?.phase !== 'initial_peek' || self?.initialPeekComplete || completingPeek) return;
    completingPeek = true;
    try {
      await action(socket, 'game:action', { type: 'INITIAL_PEEK_START' }, room.game.version);
      await action(socket, 'game:action', { type: 'INITIAL_PEEK_END' }, room.game.version + 1);
    } finally {
      completingPeek = false;
    }
  });
}

console.log(`Seven audit players joined ${code}. Start the round in the host browser; Ctrl+C stops them.`);
const stop = () => { for (const socket of sockets) socket.disconnect(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
