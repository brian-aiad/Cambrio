import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const server = process.env.CAMBRIO_LOAD_URL ?? 'http://localhost:3001';
const visitorId = `reconnect-guest-${randomUUID()}`;
const sockets = [];

const connect = (identity) => new Promise((resolve, reject) => {
  const socket = io(server, {
    auth: { visitorId: identity },
    transports: ['websocket'],
    reconnectionDelay: 40,
    reconnectionDelayMax: 100,
  });
  sockets.push(socket);
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
});

const action = (socket, type, payload) => new Promise((resolve, reject) => {
  socket.timeout(5_000).emit('room:action', { type, ...payload, clientActionId: randomUUID() }, (error, ack) => {
    if (error || !ack?.ok) reject(error ?? new Error(ack?.message ?? `${type} failed`));
    else resolve(ack);
  });
});

const nextState = (socket, predicate) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { socket.off('room:state', listener); reject(new Error('Timed out waiting for room state.')); }, 5_000);
  const listener = (room) => {
    if (!predicate(room)) return;
    clearTimeout(timeout);
    socket.off('room:state', listener);
    resolve(room);
  };
  socket.on('room:state', listener);
});

try {
  const host = await connect(`reconnect-host-${randomUUID()}`);
  const createdState = nextState(host, (room) => room.players?.length === 1);
  await action(host, 'ROOM_CREATE', { name: 'HOST PLAYER' });
  const created = await createdState;

  const guest = await connect(visitorId);
  const joinedState = nextState(guest, (room) => room.code === created.code && room.players?.length === 2);
  await action(guest, 'ROOM_JOIN', { code: created.code, name: 'guest player' });
  const joined = await joinedState;
  const originalSeat = joined.selfPlayerId;

  const reconnected = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Guest did not reconnect.')), 5_000);
    guest.once('connect', () => { clearTimeout(timeout); resolve(); });
  });
  guest.io.engine.close();
  await reconnected;

  const recoveredState = nextState(guest, (room) => room.code === created.code && room.players?.length === 2);
  await action(host, 'ROOM_READY', { ready: true });
  const recovered = await recoveredState;
  if (recovered.selfPlayerId !== originalSeat) throw new Error('Reconnect created a new seat.');
  if (recovered.players.filter((player) => player.id === originalSeat).length !== 1) throw new Error('Reconnect duplicated the player.');
  if (recovered.players.find((player) => player.id === originalSeat)?.name !== 'Guest Player') throw new Error('Reconnect changed the normalized display name.');

  console.log(JSON.stringify({ ok: true, room: created.code, players: recovered.players.length, sameSeat: true, duplicateSeats: false }));
} finally {
  for (const socket of sockets) socket.disconnect();
}
