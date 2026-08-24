import { describe, expect, it, vi } from 'vitest';
import type { GameAction, RoomAction } from '../shared/protocol.js';
import type { ServerIdentity } from './auth.js';
import { MemoryPersistence } from './persistence.js';
import { RoomManager, type Membership } from './rooms.js';

const host: ServerIdentity = { userId: 'host-user', anonymous: true };
const guest: ServerIdentity = { userId: 'guest-user', anonymous: true };
let actionNumber = 0;

const roomAction = <T extends Omit<RoomAction, 'clientActionId'>>(action: T) => ({ ...action, clientActionId: `room-${++actionNumber}` }) as RoomAction;
const gameAction = <T extends Omit<GameAction, 'clientActionId' | 'expectedVersion'>>(action: T, version: number) => ({ ...action, clientActionId: `game-${++actionNumber}`, expectedVersion: version }) as GameAction;

async function startedRoom() {
  const persistence = new MemoryPersistence();
  const manager = new RoomManager(persistence);
  const created = await manager.handleRoomAction(host, undefined, roomAction({ type: 'ROOM_CREATE', name: 'Host' }));
  const hostMembership = created.membership!;
  const joined = await manager.handleRoomAction(guest, undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Guest' }));
  const guestMembership = joined.membership!;
  await manager.handleRoomAction(guest, guestMembership, roomAction({ type: 'ROOM_READY', ready: true }));
  await manager.handleRoomAction(host, hostMembership, roomAction({ type: 'ROOM_START' }));
  return { persistence, manager, hostMembership, guestMembership };
}

async function completePeek(manager: RoomManager, membership: Membership) {
  const room = (await manager.get(membership.roomCode))!;
  const version = room.game!.version;
  await manager.handleGameAction(membership, gameAction({ type: 'INITIAL_PEEK_START' }, version));
  await manager.handleGameAction(membership, gameAction({ type: 'INITIAL_PEEK_END' }, version + 1));
}

describe('RoomManager integration', () => {
  it('creates, joins, readies, deals, and restores a checkpoint', async () => {
    const { persistence, manager, hostMembership, guestMembership } = await startedRoom();
    const room = (await manager.get(hostMembership.roomCode))!;
    expect(room.phase).toBe('game');
    expect(room.game?.discard).toEqual([]);
    expect(manager.view(room, hostMembership.playerId).game?.players.flatMap((player) => player.cards).some((card) => card.rank)).toBe(false);

    const restoredManager = new RoomManager(persistence);
    const restored = await restoredManager.get(hostMembership.roomCode);
    expect(restored?.players).toHaveLength(2);
    expect(restoredManager.view(restored!, guestMembership.playerId).code).toBe(hostMembership.roomCode);
  });

  it('records a completed forfeit result exactly once', async () => {
    const { persistence, manager, hostMembership, guestMembership } = await startedRoom();
    await completePeek(manager, hostMembership);
    await completePeek(manager, guestMembership);
    await manager.handleRoomAction(host, hostMembership, roomAction({ type: 'ROOM_REMOVE', playerId: guestMembership.playerId }));
    const room = (await manager.get(hostMembership.roomCode))!;
    expect(room.phase).toBe('results');
    expect(room.game?.results?.find((result) => result.playerId === hostMembership.playerId)?.winner).toBe(true);
    expect(await persistence.getStats('host-user')).toMatchObject({ games: 1, wins: 1 });
    expect(await persistence.getStats('guest-user')).toMatchObject({ games: 1, wins: 0 });
  });

  it('fills an eight-player lobby, places the ninth player in waiting, and leaks no cards', async () => {
    const persistence = new MemoryPersistence();
    const manager = new RoomManager(persistence);
    const identities = Array.from({ length: 9 }, (_, index) => ({ userId: `full-user-${index}`, anonymous: true } satisfies ServerIdentity));
    const created = await manager.handleRoomAction(identities[0], undefined, roomAction({ type: 'ROOM_CREATE', name: 'Host' }));
    const hostMembership = created.membership!;
    const memberships: Membership[] = [hostMembership];
    for (let index = 1; index < identities.length; index += 1) {
      const joined = await manager.handleRoomAction(identities[index], undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: `Player ${index}` }));
      memberships.push(joined.membership!);
    }
    let room = (await manager.get(hostMembership.roomCode))!;
    expect(room.players).toHaveLength(8);
    expect(room.waiting).toHaveLength(1);
    expect(memberships[8].waiting).toBe(true);
    expect(manager.view(room, memberships[8].playerId).game).toBeUndefined();
    for (const membership of memberships.slice(1, 8)) await manager.handleRoomAction(identities[memberships.indexOf(membership)], membership, roomAction({ type: 'ROOM_READY', ready: true }));
    await manager.handleRoomAction(identities[0], hostMembership, roomAction({ type: 'ROOM_START' }));
    room = (await manager.get(hostMembership.roomCode))!;
    expect(room.game?.players).toHaveLength(8);
    for (const membership of memberships.slice(0, 8)) {
      const view = manager.view(room, membership.playerId);
      expect(view.game?.players.flatMap((player) => player.cards)).toHaveLength(32);
      expect(view.game?.players.flatMap((player) => player.cards).some((card) => card.rank)).toBe(false);
      expect(view.game?.players.every((player) => player.cards.map((card) => card.slot).join(',') === '0,1,2,3')).toBe(true);
    }
  });

  it('promotes connected waiters as soon as full-lobby seats open', async () => {
    const manager = new RoomManager(new MemoryPersistence());
    const identities = Array.from({ length: 10 }, (_, index) => ({ userId: `queue-user-${index}`, anonymous: true } satisfies ServerIdentity));
    const created = await manager.handleRoomAction(identities[0], undefined, roomAction({ type: 'ROOM_CREATE', name: 'Host' }));
    const hostMembership = created.membership!;
    const memberships: Membership[] = [hostMembership];
    for (let index = 1; index < identities.length; index += 1) {
      const joined = await manager.handleRoomAction(identities[index], undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: `Player ${index}` }));
      memberships.push(joined.membership!);
    }

    await manager.disconnect(hostMembership.roomCode, memberships[8].playerId);
    await manager.handleRoomAction(identities[0], hostMembership, roomAction({ type: 'ROOM_REMOVE', playerId: memberships[1].playerId }));
    let room = (await manager.get(hostMembership.roomCode))!;
    expect(room.players).toHaveLength(8);
    expect(room.players.some((candidate) => candidate.id === memberships[9].playerId)).toBe(true);
    expect(room.waiting.map((candidate) => candidate.id)).toEqual([memberships[8].playerId]);

    await manager.handleRoomAction(identities[8], undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Player 8' }));
    await manager.handleRoomAction(identities[2], memberships[2], roomAction({ type: 'ROOM_LEAVE' }));
    room = (await manager.get(hostMembership.roomCode))!;
    expect(room.players).toHaveLength(8);
    expect(room.players.some((candidate) => candidate.id === memberships[8].playerId)).toBe(true);
    expect(room.waiting).toHaveLength(0);
    expect(room.players.find((candidate) => candidate.id === memberships[8].playerId)?.ready).toBe(false);
  });

  it('reconnects without duplicating players and preserves the host through the reconnect grace period', async () => {
    const persistence = new MemoryPersistence();
    const manager = new RoomManager(persistence);
    const created = await manager.handleRoomAction(host, undefined, roomAction({ type: 'ROOM_CREATE', name: 'Host' }));
    const hostMembership = created.membership!;
    const joined = await manager.handleRoomAction(guest, undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Guest' }));
    const guestMembership = joined.membership!;
    await manager.disconnect(hostMembership.roomCode, guestMembership.playerId);
    let room = (await manager.get(hostMembership.roomCode))!;
    expect(room.players.find((player) => player.id === guestMembership.playerId)?.connected).toBe(false);
    const rejoined = await manager.handleRoomAction(guest, undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Guest renamed' }));
    room = (await manager.get(hostMembership.roomCode))!;
    expect(rejoined.membership?.playerId).toBe(guestMembership.playerId);
    expect(room.players).toHaveLength(2);
    expect(room.players.find((player) => player.id === guestMembership.playerId)).toMatchObject({ connected: true, name: 'Guest renamed' });
    await manager.disconnect(hostMembership.roomCode, hostMembership.playerId);
    room = (await manager.get(hostMembership.roomCode))!;
    expect(room.hostPlayerId).toBe(hostMembership.playerId);
    const hostGrace = room.disconnectGrace[hostMembership.playerId];
    await manager.tick(hostGrace - 1);
    expect((await manager.get(hostMembership.roomCode))!.hostPlayerId).toBe(hostMembership.playerId);

    await manager.handleRoomAction(host, undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Host again' }));
    room = (await manager.get(hostMembership.roomCode))!;
    expect(room.hostPlayerId).toBe(hostMembership.playerId);
    expect(room.disconnectGrace[hostMembership.playerId]).toBeUndefined();

    await manager.disconnect(hostMembership.roomCode, hostMembership.playerId);
    room = (await manager.get(hostMembership.roomCode))!;
    await manager.tick(room.disconnectGrace[hostMembership.playerId] + 1);
    room = (await manager.get(hostMembership.roomCode))!;
    expect(room.hostPlayerId).toBe(guestMembership.playerId);
  });

  it('times out every unfinished initial peek, then waits through disconnect grace before auto-playing', async () => {
    const { manager, hostMembership } = await startedRoom();
    let room = (await manager.get(hostMembership.roomCode))!;
    let now = room.initialPeekDeadlineAt! + 1;
    while (room.game?.phase === 'initial_peek') {
      await manager.tick(now);
      room = (await manager.get(hostMembership.roomCode))!;
      now = room.initialPeekDeadlineAt! + 1;
    }
    expect(room.game?.phase).toBe('playing');
    const timedPlayerId = room.game!.turn!.playerId;
    await manager.disconnect(room.code, timedPlayerId);
    room = (await manager.get(room.code))!;
    const grace = room.disconnectGrace[timedPlayerId];
    await manager.tick(grace - 1);
    expect((await manager.get(room.code))!.game!.turn!.playerId).toBe(timedPlayerId);
    await manager.tick(grace + 1);
    room = (await manager.get(room.code))!;
    expect(room.game!.turn!.playerId).not.toBe(timedPlayerId);
    expect(room.game!.discard).toHaveLength(1);
  });

  it('applies a duplicate game action exactly once', async () => {
    const { manager, hostMembership, guestMembership } = await startedRoom();
    await completePeek(manager, hostMembership);
    await completePeek(manager, guestMembership);
    let room = (await manager.get(hostMembership.roomCode))!;
    const activeMembership = room.game!.turn!.playerId === hostMembership.playerId ? hostMembership : guestMembership;
    const draw = { type: 'DRAW', clientActionId: `duplicate-${++actionNumber}`, expectedVersion: room.game!.version } as GameAction;
    await manager.handleGameAction(activeMembership, draw);
    room = (await manager.get(hostMembership.roomCode))!;
    const versionAfterFirst = room.game!.version;
    const deckAfterFirst = room.game!.deck.length;
    await manager.handleGameAction(activeMembership, draw);
    room = (await manager.get(hostMembership.roomCode))!;
    expect(room.game!.version).toBe(versionAfterFirst);
    expect(room.game!.deck).toHaveLength(deckAfterFirst);
  });

  it('rejects a delayed non-stack action from an older game version', async () => {
    const { manager, hostMembership, guestMembership } = await startedRoom();
    await completePeek(manager, hostMembership);
    await completePeek(manager, guestMembership);
    let room = (await manager.get(hostMembership.roomCode))!;
    const activeMembership = room.game!.turn!.playerId === hostMembership.playerId ? hostMembership : guestMembership;
    const staleVersion = room.game!.version;
    await manager.handleGameAction(activeMembership, gameAction({ type: 'DRAW' }, staleVersion));
    room = (await manager.get(hostMembership.roomCode))!;

    await expect(manager.handleGameAction(activeMembership, gameAction({ type: 'DISCARD_DRAWN' }, staleVersion))).rejects.toMatchObject({ code: 'STALE_STATE' });
    expect((await manager.get(hostMembership.roomCode))!.game!.turn?.stage).toBe('deciding');
  });

  it('coalesces simultaneous duplicate actions while the first checkpoint is in flight', async () => {
    const { manager, hostMembership, guestMembership } = await startedRoom();
    await completePeek(manager, hostMembership);
    await completePeek(manager, guestMembership);
    let room = (await manager.get(hostMembership.roomCode))!;
    const activeMembership = room.game!.turn!.playerId === hostMembership.playerId ? hostMembership : guestMembership;
    const beforeDeck = room.game!.deck.length;
    const draw = { type: 'DRAW', clientActionId: `concurrent-duplicate-${++actionNumber}`, expectedVersion: room.game!.version } as GameAction;

    const results = await Promise.all(Array.from({ length: 25 }, () => manager.handleGameAction(activeMembership, draw)));
    room = (await manager.get(hostMembership.roomCode))!;

    expect(results).toHaveLength(25);
    expect(room.game!.deck).toHaveLength(beforeDeck - 1);
    expect(room.game!.turn?.stage).toBe('deciding');
  });

  it('rate-limits repeated stack guesses from one player without closing the race', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    try {
      const { manager, hostMembership, guestMembership } = await startedRoom();
      await completePeek(manager, hostMembership);
      await completePeek(manager, guestMembership);
      let room = (await manager.get(hostMembership.roomCode))!;
      const activeMembership = room.game!.turn!.playerId === hostMembership.playerId ? hostMembership : guestMembership;
      const actor = room.game!.players.find((player) => player.id === activeMembership.playerId)!;
      const wrongTarget = actor.cards[0];
      const forcedDraw = room.game!.deck.find((id) => room.game!.cards[id].rank !== room.game!.cards[wrongTarget].rank)!;
      const forcedIndex = room.game!.deck.indexOf(forcedDraw);
      [room.game!.deck[forcedIndex], room.game!.deck[room.game!.deck.length - 1]] = [room.game!.deck.at(-1)!, forcedDraw];
      await manager.handleGameAction(activeMembership, gameAction({ type: 'DRAW' }, room.game!.version));
      room = (await manager.get(hostMembership.roomCode))!;
      await manager.handleGameAction(activeMembership, gameAction({ type: 'DISCARD_DRAWN' }, room.game!.version));
      room = (await manager.get(hostMembership.roomCode))!;
      const generation = room.game!.discardGeneration;
      const raceVersion = room.game!.version;
      const first = await manager.handleGameAction(activeMembership, gameAction({ type: 'STACK_ATTEMPT', targetCardId: wrongTarget, discardGeneration: generation }, raceVersion));
      expect(first.effects?.some((effect) => effect.type === 'penalty')).toBe(true);
      room = (await manager.get(hostMembership.roomCode))!;
      expect(room.game!.stackOpen).toBe(true);
      await expect(manager.handleGameAction(activeMembership, gameAction({ type: 'STACK_ATTEMPT', targetCardId: wrongTarget, discardGeneration: generation }, room.game!.version))).rejects.toMatchObject({ code: 'RATE_LIMIT' });
      now.mockReturnValue(5_001_000);
      const staleButSameRace = await manager.handleGameAction(activeMembership, gameAction({ type: 'STACK_ATTEMPT', targetCardId: wrongTarget, discardGeneration: generation }, raceVersion));
      expect(staleButSameRace.effects?.some((effect) => effect.type === 'penalty')).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('promotes a waiting player after results and allows their stale membership to play the rematch', async () => {
    const { manager, hostMembership, guestMembership } = await startedRoom();
    const waitingIdentity: ServerIdentity = { userId: 'waiting-user', anonymous: true };
    const waiting = await manager.handleRoomAction(waitingIdentity, undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Waiting' }));
    const waitingMembership = waiting.membership!;
    expect(waitingMembership.waiting).toBe(true);
    await completePeek(manager, hostMembership);
    await completePeek(manager, guestMembership);
    await manager.handleRoomAction(host, hostMembership, roomAction({ type: 'ROOM_REMOVE', playerId: guestMembership.playerId }));
    await manager.handleRoomAction(host, hostMembership, roomAction({ type: 'ROOM_REMATCH' }));
    let room = (await manager.get(hostMembership.roomCode))!;
    expect(room.players.some((player) => player.id === waitingMembership.playerId)).toBe(true);
    expect(room.waiting.some((player) => player.id === waitingMembership.playerId)).toBe(false);
    await manager.handleRoomAction(waitingIdentity, waitingMembership, roomAction({ type: 'ROOM_READY', ready: true }));
    await manager.handleRoomAction(host, hostMembership, roomAction({ type: 'ROOM_START' }));
    room = (await manager.get(hostMembership.roomCode))!;
    await manager.handleGameAction(waitingMembership, gameAction({ type: 'INITIAL_PEEK_START' }, room.game!.version));
    expect((await manager.get(hostMembership.roomCode))!.game!.temporaryReveals[waitingMembership.playerId]).toHaveLength(2);
  });

  it('removes a waiting player who explicitly leaves during an active round', async () => {
    const { manager, hostMembership } = await startedRoom();
    const waitingIdentity: ServerIdentity = { userId: 'departing-waiter', anonymous: true };
    const joined = await manager.handleRoomAction(waitingIdentity, undefined, roomAction({ type: 'ROOM_JOIN', code: hostMembership.roomCode, name: 'Maya' }));
    const waitingMembership = joined.membership!;
    expect(waitingMembership.waiting).toBe(true);

    await manager.handleRoomAction(waitingIdentity, waitingMembership, roomAction({ type: 'ROOM_LEAVE' }));
    const room = (await manager.get(hostMembership.roomCode))!;
    expect(room.waiting.some((candidate) => candidate.id === waitingMembership.playerId)).toBe(false);
    expect(room.disconnectGrace[waitingMembership.playerId]).toBeUndefined();
  });
});
