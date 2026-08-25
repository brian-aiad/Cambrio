import { config } from 'dotenv';
import { Redis } from '@upstash/redis';
import type { GameState } from '../src/shared/game.js';
import type { ActionAck, RoomView } from '../src/shared/protocol.js';
import type { Membership, RoomRuntime } from '../src/server/rooms.js';

config({ path: '.env.preview.local', override: true, quiet: true });

const { default: realtime } = await import('../api/realtime.ts');
const redisUrl = process.env.KV_REST_API_URL!;
const redisToken = process.env.KV_REST_API_TOKEN!;
if (!redisUrl || !redisToken) throw new Error('Pull the Vercel Preview environment before running this smoke test.');
const redis = new Redis({ url: redisUrl, token: redisToken });
let actionSequence = 0;

interface Client {
  visitorId: string;
  membership?: Membership;
  state?: RoomView;
}

interface ApiResult {
  ack?: ActionAck;
  membership?: Membership;
  state?: RoomView;
  left?: { message: string };
}

const clients: Client[] = Array.from({ length: 8 }, (_, index) => ({ visitorId: `http_smoke_player_${index}_${'x'.repeat(12)}` }));

async function call(client: Client, body: unknown): Promise<ApiResult> {
  const request = new Request('https://cambrio.vercel.app/api/realtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-visitor-id': client.visitorId },
    body: JSON.stringify(body),
  });
  const response = await realtime.fetch(request);
  const result = await response.json() as ApiResult;
  if (result.membership) client.membership = result.membership;
  if (result.state) client.state = result.state;
  return result;
}

async function roomAction(client: Client, action: Record<string, unknown>) {
  return call(client, { operation: 'action', event: 'room:action', membership: client.membership, payload: { ...action, clientActionId: `room-${++actionSequence}` } });
}

async function gameAction(client: Client, action: Record<string, unknown>) {
  if (!client.state?.game) await sync(client);
  return call(client, {
    operation: 'action',
    event: 'game:action',
    membership: client.membership,
    payload: { ...action, clientActionId: `game-${++actionSequence}`, expectedVersion: client.state?.game?.version ?? 0 },
  });
}

async function sync(client: Client) {
  return call(client, { operation: 'sync', membership: client.membership });
}

const created = await roomAction(clients[0], { type: 'ROOM_CREATE', name: 'Brian' });
if (!created.ack?.ok || !created.membership) throw new Error(`Room creation failed: ${created.ack?.message}`);
const code = created.membership.roomCode;

try {
  const names = ['Brian', 'Alex', 'Maya', 'Jordan', 'Sam', 'Chris', 'Taylor', 'Devin'];
  await Promise.all(clients.slice(1).map((client, index) => roomAction(client, { type: 'ROOM_JOIN', code, name: names[index + 1] })));
  await Promise.all(clients.slice(1).map((client) => roomAction(client, { type: 'ROOM_READY', ready: true })));
  await sync(clients[0]);
  if (clients[0].state?.players.length !== 8) throw new Error('The serverless room did not serialize eight concurrent joins.');

  const starts = await Promise.all(Array.from({ length: 12 }, () => roomAction(clients[0], { type: 'ROOM_START' })));
  if (starts.filter((result) => result.ack?.ok).length !== 1) throw new Error('Rapid deal taps started more than one round.');
  await Promise.all(clients.map((client) => sync(client)));

  await Promise.all(clients.map((client) => gameAction(client, { type: 'INITIAL_PEEK_START' })));
  await Promise.all(clients.map((client) => gameAction(client, { type: 'INITIAL_PEEK_END' })));
  await Promise.all(clients.map((client) => sync(client)));
  if (clients.some((client) => client.state?.game?.phase !== 'playing')) throw new Error('The eight private peeks did not settle into one playing state.');
  for (const client of clients) {
    const game = client.state!.game!;
    const leaked = game.players.some((player) => player.cards.some((card) => card.rank || card.suit));
    if (leaked) throw new Error('A serverless projection leaked a concealed hand rank.');
    const semanticId = game.players.some((player) => player.cards.some((card) => /^(?:A|[2-9]|10|J|Q|K)-(?:clubs|diamonds|hearts|spades)$/.test(card.id)));
    if (semanticId) throw new Error('A serverless projection encoded a concealed face in its card ID.');
  }

  let snapshot = await roomSnapshot(code);
  let matchingCard = findMatchingCard(snapshot.game!);
  for (let attempt = 0; !matchingCard && attempt < 12; attempt += 1) {
    const activeId = snapshot.game!.turn!.playerId;
    const active = clients.find((client) => client.membership?.playerId === activeId)!;
    await sync(active);
    const drawn = await gameAction(active, { type: 'DRAW' });
    if (!drawn.ack?.ok) throw new Error(`Unable to draw while finding a stack race: ${drawn.ack?.message}`);
    const discarded = await gameAction(active, { type: 'DISCARD_DRAWN' });
    if (!discarded.ack?.ok) throw new Error(`Unable to discard while finding a stack race: ${discarded.ack?.message}`);
    snapshot = await roomSnapshot(code);
    matchingCard = findMatchingCard(snapshot.game!);
  }
  if (!matchingCard) throw new Error('Could not produce a deterministic matching card for the stack race.');

  await Promise.all(clients.map((client) => sync(client)));
  const generation = clients[0].state!.game!.discardGeneration;
  const race = await Promise.all(clients.map((client) => gameAction(client, { type: 'STACK_ATTEMPT', targetCardId: matchingCard, discardGeneration: generation })));
  if (race.filter((result) => result.ack?.ok && result.ack.outcome === 'stack').length !== 1) throw new Error('The distributed stack race did not produce exactly one winner.');

  const removedMembership = clients[7].membership!;
  const removal = await roomAction(clients[0], { type: 'ROOM_REMOVE', playerId: removedMembership.playerId });
  if (!removal.ack?.ok) throw new Error(`The host could not remove a seat: ${removal.ack?.message}`);
  const removedSync = await call(clients[7], { operation: 'sync', membership: removedMembership });
  if (removedSync.left?.message !== 'The host removed your seat from this table.') throw new Error(`Hosted removal lost its explanation: ${removedSync.left?.message}`);

  console.log(JSON.stringify({
    players: 8,
    concurrentJoins: 'serialized',
    rapidDeals: `${starts.length} requests / 1 round`,
    privateProjections: 'no leaked ranks, suits, or face IDs',
    stackRace: '8 requests / 1 winner',
    hostRemoval: 'removed player receives the exact reason',
    storage: 'Upstash free',
  }));
} finally {
  await redis.del(`cambrio:room:${code}`);
}

async function roomSnapshot(code: string): Promise<RoomRuntime> {
  const stored = await redis.get<{ snapshot: RoomRuntime }>(`cambrio:room:${code}`);
  if (!stored?.snapshot) throw new Error('The Redis room snapshot is missing.');
  return stored.snapshot;
}

function findMatchingCard(game: GameState): string | undefined {
  const discardId = game.discard.at(-1);
  const rank = discardId ? game.cards[discardId]?.rank : undefined;
  if (!rank || !game.stackOpen) return undefined;
  return game.players.flatMap((player) => player.cards).find((cardId) => game.cards[cardId]?.rank === rank);
}
