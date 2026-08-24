import { describe, expect, it } from 'vitest';
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
  await manager.handleGameAction(membership, gameAction({ type: 'INITIAL_PEEK_START' }, room.game!.version));
  await manager.handleGameAction(membership, gameAction({ type: 'INITIAL_PEEK_END' }, room.game!.version + 1));
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
});

