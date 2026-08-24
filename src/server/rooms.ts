import { randomInt, randomUUID } from 'node:crypto';
import { customAlphabet, nanoid } from 'nanoid';
import {
  applyGameCommand,
  createGame,
  GameRuleError,
  projectGame,
  type GameCommand,
  type GameEffect,
  type GameState,
} from '../shared/game.js';
import type { GameAction, RoomAction, RoomPlayerView, RoomView } from '../shared/protocol.js';
import { toGameCommand } from '../shared/protocol.js';
import type { ServerIdentity } from './auth.js';
import type { Persistence, StoredStats } from './persistence.js';

const makeCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 60_000;
const INITIAL_PEEK_MS = 45_000;
const STACK_THROTTLE_MS = 250;
const secureRandom = () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;

export interface RoomPlayer {
  id: string;
  userId: string;
  name: string;
  handle?: string;
  anonymous: boolean;
  ready: boolean;
  connected: boolean;
  joinedAt: number;
  stats: StoredStats;
}

export interface RoomRuntime {
  code: string;
  phase: 'lobby' | 'game' | 'results';
  hostPlayerId: string;
  players: RoomPlayer[];
  waiting: RoomPlayer[];
  game?: GameState;
  initialPeekDeadlineAt?: number;
  disconnectGrace: Record<string, number>;
  createdAt: number;
  expiresAt: number;
  recordedGameId?: string;
}

export interface Membership {
  roomCode: string;
  playerId: string;
  waiting: boolean;
}

export interface ManagerResult {
  membership?: Membership;
  effects?: GameEffect[];
  message?: string;
}

export class RoomManager {
  private rooms = new Map<string, RoomRuntime>();
  private processedActions = new Map<string, { ok: boolean; code?: string; message?: string }>();
  private stackThrottle = new Map<string, number>();

  constructor(private persistence: Persistence) {}

  async handleRoomAction(identity: ServerIdentity, membership: Membership | undefined, action: RoomAction): Promise<ManagerResult> {
    const cached = this.processedActions.get(action.clientActionId);
    if (cached) return { membership, message: cached.message };
    let result: ManagerResult;
    switch (action.type) {
      case 'ROOM_CREATE':
        result = await this.create(identity, action.name);
        break;
      case 'ROOM_JOIN':
        result = await this.join(identity, action.code, action.name);
        break;
      case 'ROOM_READY': {
        const { room, player } = this.requireMembership(membership);
        if (room.phase !== 'lobby') throw new GameRuleError('NOT_LOBBY', 'Ready status can only change in the lobby.');
        player.ready = action.ready;
        await this.save(room);
        result = { membership };
        break;
      }
      case 'ROOM_START': {
        const { room, player } = this.requireMembership(membership);
        if (room.hostPlayerId !== player.id) throw new GameRuleError('HOST_ONLY', 'Only the host can start the game.');
        if (room.phase !== 'lobby') throw new GameRuleError('NOT_LOBBY', 'The game has already started.');
        if (room.players.length < 2) throw new GameRuleError('PLAYER_COUNT', 'At least two players are required.');
        if (room.players.some((candidate) => candidate.id !== player.id && (!candidate.ready || !candidate.connected))) {
          throw new GameRuleError('NOT_READY', 'Every connected non-host player must be ready.');
        }
        const now = Date.now();
        room.game = createGame(
          randomUUID(),
          room.players.map((candidate) => ({
            id: candidate.id,
            userId: candidate.userId,
            name: candidate.name,
            handle: candidate.handle,
          })),
          now,
          secureRandom,
        );
        room.phase = 'game';
        room.initialPeekDeadlineAt = now + INITIAL_PEEK_MS;
        room.recordedGameId = undefined;
        await this.save(room);
        result = { membership, message: 'The cards are dealt. Hold your two bottom cards to peek.' };
        break;
      }
      case 'ROOM_REMOVE': {
        const { room, player } = this.requireMembership(membership);
        if (room.hostPlayerId !== player.id) throw new GameRuleError('HOST_ONLY', 'Only the host can remove a player.');
        if (action.playerId === player.id) throw new GameRuleError('REMOVE_SELF', 'Use Leave room instead.');
        const target = room.players.find((candidate) => candidate.id === action.playerId);
        if (!target) throw new GameRuleError('PLAYER_NOT_FOUND', 'That player is not seated.');
        if (room.game && room.game.phase !== 'results') {
          const transition = applyGameCommand(room.game, { type: 'FORFEIT_PLAYER', playerId: target.id }, Date.now(), secureRandom);
          room.game = transition.state;
          room.players = room.players.filter((candidate) => candidate.id !== target.id);
          await this.afterTransition(room, transition.effects);
          result = { membership, effects: transition.effects };
        } else {
          room.players = room.players.filter((candidate) => candidate.id !== target.id);
          await this.save(room);
          result = { membership };
        }
        break;
      }
      case 'ROOM_REMATCH': {
        const { room, player } = this.requireMembership(membership);
        if (room.hostPlayerId !== player.id) throw new GameRuleError('HOST_ONLY', 'Only the host can return the room to the lobby.');
        if (room.phase !== 'results') throw new GameRuleError('NO_RESULTS', 'The current game has not ended.');
        room.phase = 'lobby';
        room.game = undefined;
        room.initialPeekDeadlineAt = undefined;
        for (const candidate of room.players) candidate.ready = candidate.id === room.hostPlayerId;
        while (room.players.length < 8 && room.waiting.length) {
          const candidate = room.waiting.shift()!;
          candidate.ready = false;
          room.players.push(candidate);
        }
        await this.save(room);
        result = { membership, message: 'Back in the lobby. Ready up for another round.' };
        break;
      }
      case 'ROOM_LEAVE': {
        const { room, player } = this.requireMembership(membership);
        await this.disconnect(room.code, player.id, true);
        result = { membership: undefined };
        break;
      }
    }
    this.rememberAction(action.clientActionId, { ok: true, message: result.message });
    return result;
  }

  async handleGameAction(membership: Membership | undefined, action: GameAction): Promise<ManagerResult> {
    const { room, player } = this.requireMembership(membership);
    if (!room.game || (room.phase !== 'game' && room.phase !== 'results')) throw new GameRuleError('NO_GAME', 'There is no active game.');
    if (membership?.waiting) throw new GameRuleError('WAITING', 'Waiting players cannot act in the current game.');
    const cached = this.processedActions.get(action.clientActionId);
    if (cached) return { membership, message: cached.message };
    if (action.type === 'STACK_ATTEMPT') {
      const key = `${room.code}:${player.id}:${action.discardGeneration}`;
      const previous = this.stackThrottle.get(key) ?? 0;
      if (Date.now() - previous < STACK_THROTTLE_MS) throw new GameRuleError('RATE_LIMIT', 'Stack attempts are arriving too quickly.');
      this.stackThrottle.set(key, Date.now());
    }
    const command = toGameCommand(action, player.id);
    const transition = applyGameCommand(room.game, command, Date.now(), secureRandom);
    room.game = transition.state;
    await this.afterTransition(room, transition.effects);
    this.rememberAction(action.clientActionId, { ok: true });
    return { membership, effects: transition.effects };
  }

  async disconnect(code: string, playerId: string, explicitLeave = false): Promise<void> {
    const room = await this.get(code);
    if (!room) return;
    const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === playerId);
    if (!player) return;
    player.connected = false;
    room.disconnectGrace[player.id] = Date.now() + RECONNECT_GRACE_MS;
    if (room.phase === 'lobby' && explicitLeave) {
      room.players = room.players.filter((candidate) => candidate.id !== player.id);
      room.waiting = room.waiting.filter((candidate) => candidate.id !== player.id);
    } else if (room.game && room.game.players.some((candidate) => candidate.id === player.id)) {
      room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId, connected: false }, Date.now(), secureRandom).state;
    }
    if (room.hostPlayerId === player.id) this.transferHost(room);
    if (![...room.players, ...room.waiting].some((candidate) => candidate.connected)) room.expiresAt = Date.now() + ROOM_TTL_MS;
    await this.save(room);
  }

  async tick(now = Date.now()): Promise<string[]> {
    const changed: string[] = [];
    for (const room of this.rooms.values()) {
      if (![...room.players, ...room.waiting].some((player) => player.connected) && room.expiresAt <= now) {
        this.rooms.delete(room.code);
        await this.persistence.deleteRoom(room.code);
        continue;
      }
      const game = room.game;
      if (!game || game.phase === 'results') continue;
      let timedPlayerId: string | undefined;
      if (game.phase === 'initial_peek' && room.initialPeekDeadlineAt && room.initialPeekDeadlineAt <= now) {
        timedPlayerId = game.players.find((player) => !player.initialPeekComplete && !player.forfeited)?.id;
      } else if (game.transfer) {
        timedPlayerId = game.transfer.fromPlayerId;
      } else {
        timedPlayerId = game.turn?.playerId;
      }
      if (!timedPlayerId) continue;
      const roomPlayer = room.players.find((player) => player.id === timedPlayerId);
      const engineDeadline = game.transfer?.deadlineAt ?? game.turn?.deadlineAt ?? room.initialPeekDeadlineAt ?? Infinity;
      const due = roomPlayer?.connected ? now >= engineDeadline : now >= (room.disconnectGrace[timedPlayerId] ?? now + RECONNECT_GRACE_MS);
      if (!due) continue;
      try {
        const transition = applyGameCommand(game, { type: 'TIMEOUT', playerId: timedPlayerId }, now, secureRandom);
        room.game = transition.state;
        if (room.game.phase === 'initial_peek') room.initialPeekDeadlineAt = now + 250;
        await this.afterTransition(room, transition.effects);
        changed.push(room.code);
      } catch (error) {
        console.error('Timer transition failed', room.code, error);
      }
    }
    return changed;
  }

  async get(code: string): Promise<RoomRuntime | undefined> {
    const normalized = code.toUpperCase();
    const memory = this.rooms.get(normalized);
    if (memory) return memory;
    const restored = await this.persistence.loadRoom<RoomRuntime>(normalized);
    if (restored) {
      this.rooms.set(normalized, restored);
      return restored;
    }
    return undefined;
  }

  view(room: RoomRuntime, playerId: string): RoomView {
    const isWaiting = room.waiting.some((player) => player.id === playerId);
    const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === playerId);
    if (!player) throw new GameRuleError('PLAYER_NOT_FOUND', 'You are no longer in this room.');
    const mapPlayer = (candidate: RoomPlayer): RoomPlayerView => ({
      id: candidate.id,
      name: candidate.name,
      handle: candidate.handle,
      ready: candidate.ready,
      connected: candidate.connected,
      isHost: candidate.id === room.hostPlayerId,
      joinedAt: candidate.joinedAt,
      stats: candidate.stats,
    });
    return {
      code: room.code,
      phase: room.phase,
      selfPlayerId: playerId,
      hostPlayerId: room.hostPlayerId,
      players: room.players.map(mapPlayer),
      waiting: room.waiting.map(mapPlayer),
      game: !isWaiting && room.game ? projectGame(room.game, playerId) : undefined,
      expiresAt: room.expiresAt,
    };
  }

  private async create(identity: ServerIdentity, name: string): Promise<ManagerResult> {
    let code = makeCode();
    while (await this.get(code)) code = makeCode();
    const now = Date.now();
    const player = await this.makePlayer(identity, name, now);
    player.ready = true;
    const room: RoomRuntime = {
      code,
      phase: 'lobby',
      hostPlayerId: player.id,
      players: [player],
      waiting: [],
      disconnectGrace: {},
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
    };
    this.rooms.set(code, room);
    await this.save(room);
    return { membership: { roomCode: code, playerId: player.id, waiting: false }, message: 'Private room created.' };
  }

  private async join(identity: ServerIdentity, code: string, name: string): Promise<ManagerResult> {
    const room = await this.get(code);
    if (!room) throw new GameRuleError('ROOM_NOT_FOUND', 'That room does not exist or has expired.');
    const existing = [...room.players, ...room.waiting].find((candidate) => candidate.userId === identity.userId);
    if (existing) {
      existing.connected = true;
      existing.name = name;
      existing.handle = identity.handle;
      delete room.disconnectGrace[existing.id];
      const waiting = room.waiting.includes(existing);
      if (room.game?.players.some((candidate) => candidate.id === existing.id)) {
        room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId: existing.id, connected: true }, Date.now(), secureRandom).state;
      }
      await this.save(room);
      return { membership: { roomCode: room.code, playerId: existing.id, waiting }, message: 'Reconnected to the room.' };
    }
    const player = await this.makePlayer(identity, name, Date.now());
    const waiting = room.phase !== 'lobby' || room.players.length >= 8;
    (waiting ? room.waiting : room.players).push(player);
    await this.save(room);
    return {
      membership: { roomCode: room.code, playerId: player.id, waiting },
      message: waiting ? 'The round is active. You are waiting for the next lobby.' : 'Joined the room.',
    };
  }

  private async makePlayer(identity: ServerIdentity, name: string, joinedAt: number): Promise<RoomPlayer> {
    return {
      id: nanoid(12),
      userId: identity.userId,
      name,
      handle: identity.handle,
      anonymous: identity.anonymous,
      ready: false,
      connected: true,
      joinedAt,
      stats: await this.persistence.getStats(identity.userId),
    };
  }

  private requireMembership(membership: Membership | undefined): { room: RoomRuntime; player: RoomPlayer } {
    if (!membership) throw new GameRuleError('NOT_IN_ROOM', 'Join a room first.');
    const room = this.rooms.get(membership.roomCode);
    if (!room) throw new GameRuleError('ROOM_NOT_FOUND', 'That room is no longer active.');
    const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === membership.playerId);
    if (!player) throw new GameRuleError('PLAYER_NOT_FOUND', 'You are no longer in this room.');
    return { room, player };
  }

  private async afterTransition(room: RoomRuntime, effects: GameEffect[]): Promise<void> {
    if (room.game?.phase === 'results') {
      room.phase = 'results';
      if (room.recordedGameId !== room.game.id) {
        const participants = room.game.results!.map((result) => {
          const enginePlayer = room.game!.players.find((player) => player.id === result.playerId)!;
          return {
            userId: enginePlayer.userId,
            displayName: enginePlayer.name,
            seat: enginePlayer.seat,
            score: result.score,
            winner: result.winner,
            forfeited: result.forfeited,
          };
        });
        await this.persistence.recordMatch(room.game.id, room.code, participants);
        room.recordedGameId = room.game.id;
        for (const player of room.players) player.stats = await this.persistence.getStats(player.userId);
      }
    }
    if (effects.some((effect) => effect.type === 'turn') && room.game?.phase === 'initial_peek') {
      room.initialPeekDeadlineAt = Date.now() + INITIAL_PEEK_MS;
    }
    await this.save(room);
  }

  private transferHost(room: RoomRuntime): void {
    const replacement = room.players.filter((player) => player.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (replacement) room.hostPlayerId = replacement.id;
  }

  private async save(room: RoomRuntime): Promise<void> {
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    await this.persistence.saveRoom(room.code, room, room.game?.version ?? 0, room.expiresAt);
  }

  private rememberAction(id: string, result: { ok: boolean; code?: string; message?: string }): void {
    this.processedActions.set(id, result);
    if (this.processedActions.size > 2_000) this.processedActions.delete(this.processedActions.keys().next().value!);
  }
}

export function gameCommandLabel(command: GameCommand): string {
  return command.type.toLowerCase().replaceAll('_', ' ');
}
