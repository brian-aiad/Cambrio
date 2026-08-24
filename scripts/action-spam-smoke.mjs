import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const server = process.env.CAMBRIO_LOAD_URL ?? 'http://localhost:3001';
const sockets = [];
const latest = new Map();

const connect = (visitorId) => new Promise((resolve, reject) => {
  const socket = io(server, { auth: { visitorId: `${visitorId}-${randomUUID()}` }, transports: ['websocket'] });
  sockets.push(socket);
  socket.on('room:state', (room) => latest.set(socket.id, room));
  socket.once('connect', () => resolve(socket));
  socket.once('connect_error', reject);
});

const emitAck = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(8_000).emit(event, payload, (error, ack) => {
    if (error) reject(error);
    else resolve(ack);
  });
});

const action = async (socket, event, payload, expectedVersion = 0) => {
  const ack = await emitAck(socket, event, { ...payload, clientActionId: randomUUID(), ...(event === 'game:action' ? { expectedVersion } : {}) });
  if (!ack?.ok) throw new Error(`${payload.type}: ${ack?.code ?? 'NO_ACK'} ${ack?.message ?? ''}`);
  return ack;
};

const waitState = (socket, predicate) => new Promise((resolve, reject) => {
  const current = latest.get(socket.id);
  if (current && predicate(current)) return resolve(current);
  const timer = setTimeout(() => { socket.off('room:state', listener); reject(new Error('State timeout')); }, 10_000);
  const listener = (room) => {
    if (!predicate(room)) return;
    clearTimeout(timer);
    socket.off('room:state', listener);
    resolve(room);
  };
  socket.on('room:state', listener);
});

try {
  const [host, guest] = await Promise.all([connect('spam-host'), connect('spam-guest')]);
  await action(host, 'room:action', { type: 'ROOM_CREATE', name: 'Spam Host' });
  const created = await waitState(host, (room) => room.players?.length === 1);
  await action(guest, 'room:action', { type: 'ROOM_JOIN', code: created.code, name: 'Spam Guest' });
  await action(guest, 'room:action', { type: 'ROOM_READY', ready: true });
  await action(host, 'room:action', { type: 'ROOM_START' });
  await waitState(host, (room) => room.game?.phase === 'initial_peek');

  for (const socket of [host, guest]) {
    let room = latest.get(socket.id);
    await action(socket, 'game:action', { type: 'INITIAL_PEEK_START' }, room.game.version);
    room = await waitState(socket, (value) => value.game?.players.find((player) => player.id === value.selfPlayerId)?.cards.filter((card) => card.rank).length === 2);
    await action(socket, 'game:action', { type: 'INITIAL_PEEK_END' }, room.game.version);
  }

  const playing = await waitState(host, (room) => room.game?.phase === 'playing');
  const activeSocket = playing.game.activePlayerId === playing.selfPlayerId ? host : guest;
  const observer = activeSocket === host ? guest : host;
  const activeView = latest.get(activeSocket.id);
  const beforeDeck = activeView.game.deckCount;
  const beforeVersion = activeView.game.version;
  const duplicateDraw = { type: 'DRAW', clientActionId: randomUUID(), expectedVersion: beforeVersion };

  const drawAcks = await Promise.all(Array.from({ length: 25 }, () => emitAck(activeSocket, 'game:action', duplicateDraw)));
  const afterDraw = await waitState(observer, (room) => room.game?.turnStage === 'deciding' && room.game?.deckCount === beforeDeck - 1);
  if (!drawAcks.every((ack) => ack?.ok)) throw new Error('Concurrent duplicate draw did not return consistent acknowledgements.');

  const discardAcks = await Promise.all(Array.from({ length: 25 }, () => emitAck(activeSocket, 'game:action', {
    type: 'DISCARD_DRAWN',
    clientActionId: randomUUID(),
    expectedVersion: afterDraw.game.version,
  })));
  const afterDiscard = await waitState(observer, (room) => room.game?.discard && room.game.activePlayerId !== afterDraw.game.activePlayerId);
  const successfulDiscards = discardAcks.filter((ack) => ack?.ok).length;
  if (successfulDiscards !== 1) throw new Error(`Expected one successful discard from unique-button spam, received ${successfulDiscards}.`);
  if (afterDiscard.game.deckCount !== beforeDeck - 1) throw new Error('Button spam drew more than one card.');

  await new Promise((resolve) => setTimeout(resolve, 10_100));
  const caller = observer;
  const callerView = latest.get(caller.id);
  const duplicateCambio = { type: 'CALL_CAMBIO', clientActionId: randomUUID(), expectedVersion: callerView.game.version };
  const cambioAcks = await Promise.all(Array.from({ length: 20 }, () => emitAck(caller, 'game:action', duplicateCambio)));
  const ending = await waitState(caller, (room) => Boolean(room.game?.ending));
  if (!cambioAcks.every((ack) => ack?.ok)) throw new Error('Concurrent duplicate Cambrio calls did not coalesce.');
  if (ending.game.ending.triggerPlayerId !== ending.selfPlayerId) throw new Error('The wrong player became the Cambrio caller.');

  console.log(JSON.stringify({
    ok: true,
    room: created.code,
    duplicateDrawRequests: drawAcks.length,
    cardsDrawn: beforeDeck - afterDiscard.game.deckCount,
    uniqueDiscardRequests: discardAcks.length,
    successfulDiscards,
    duplicateCambioRequests: cambioAcks.length,
    endingReason: ending.game.ending.reason,
  }));
} finally {
  for (const socket of sockets) socket.disconnect();
}
