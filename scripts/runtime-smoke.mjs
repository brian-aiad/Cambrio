import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const host = io('http://localhost:3001', { auth: { visitorId: 'runtime-host-12345' } });
const guest = io('http://localhost:3001', { auth: { visitorId: 'runtime-guest-12345' } });
const connected = (socket) => new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});
const act = (socket, event, payload) => new Promise((resolve) => socket.emit(event, { ...payload, clientActionId: randomUUID() }, resolve));
const state = (socket, predicate = () => true) => new Promise((resolve) => {
  const listener = (value) => {
    if (!predicate(value)) return;
    socket.off('room:state', listener);
    resolve(value);
  };
  socket.on('room:state', listener);
});

try {
  await Promise.all([connected(host), connected(guest)]);
  const hostState = state(host);
  const create = await act(host, 'room:action', { type: 'ROOM_CREATE', name: 'Brian' });
  const room = await hostState;
  const guestState = state(guest);
  const join = await act(guest, 'room:action', { type: 'ROOM_JOIN', code: room.code, name: 'Alex' });
  await guestState;
  await act(guest, 'room:action', { type: 'ROOM_READY', ready: true });
  const dealtState = state(host, (value) => value.game?.phase === 'initial_peek');
  const start = await act(host, 'room:action', { type: 'ROOM_START' });
  const dealt = await dealtState;
  const summary = {
    create: create.ok,
    join: join.ok,
    start: start.ok,
    code: room.code,
    players: dealt.players.length,
    phase: dealt.phase,
    gamePhase: dealt.game?.phase,
    discard: dealt.game?.discard ?? null,
    leakedRanks: dealt.game?.players.flatMap((player) => player.cards).some((card) => card.rank) ?? false,
  };
  console.log(JSON.stringify(summary));
  if (!summary.create || !summary.join || !summary.start || summary.players !== 2 || summary.gamePhase !== 'initial_peek' || summary.discard !== null || summary.leakedRanks) {
    process.exitCode = 1;
  }
} finally {
  host.disconnect();
  guest.disconnect();
}
