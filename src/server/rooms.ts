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
  type TurnStage,
} from '../shared/game.js';
import type { GameAction, RoomAction, RoomPlayerView, RoomView } from '../shared/protocol.js';
import { normalizeDisplayName, toGameCommand } from '../shared/protocol.js';
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
  lastSeenAt?: number;
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
  pause?: {
    startedAt: number;
    initialPeekRemainingMs?: number;
    turnRemainingMs?: number;
    transferRemainingMs?: number;
  };
  disconnectGrace: Record<string, number>;
  createdAt: number;
  expiresAt: number;
  recordedGameId?: string;
  checkpointVersion: number;
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
  private processedActions = new Map<string, ManagerResult>();
  private inFlightActions = new Map<string, Promise<ManagerResult>>();
  private stackThrottle = new Map<string, number>();

  constructor(private persistence: Persistence) {}

  async handleRoomAction(identity: ServerIdentity, membership: Membership | undefined, action: RoomAction): Promise<ManagerResult> {
    const key = `room:${identity.userId}:${action.clientActionId}`;
    const cached = this.processedActions.get(key);
    if (cached) return cached;
    const pending = this.inFlightActions.get(key);
    if (pending) return this.withoutRepeatedEffects(await pending);
    const operation = this.executeRoomAction(identity, membership, action);
    this.inFlightActions.set(key, operation);
    try {
      const result = await operation;
      this.rememberAction(key, result);
      return result;
    } finally {
      this.inFlightActions.delete(key);
    }
  }

  private async executeRoomAction(identity: ServerIdentity, membership: Membership | undefined, action: RoomAction): Promise<ManagerResult> {
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
        room.pause = undefined;
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
          const now = Date.now();
          const timerState = {
            phase: room.game.phase,
            turnPlayerId: room.game.turn?.playerId,
            turnStage: room.game.turn?.stage,
            transferFromPlayerId: room.game.transfer?.fromPlayerId,
            transferToPlayerId: room.game.transfer?.toPlayerId,
          };
          const transition = applyGameCommand(room.game, { type: 'FORFEIT_PLAYER', playerId: target.id }, now, secureRandom);
          room.game = transition.state;
          room.players = room.players.filter((candidate) => candidate.id !== target.id);
          delete room.disconnectGrace[target.id];
          this.refreshPauseAfterTableChange(room, now, timerState);
          await this.afterTransition(room, transition.effects);
          result = { membership, effects: transition.effects };
        } else {
          room.players = room.players.filter((candidate) => candidate.id !== target.id);
          this.promoteWaiting(room);
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
        room.pause = undefined;
        for (const candidate of room.players) candidate.ready = candidate.id === room.hostPlayerId;
        this.promoteWaiting(room);
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
    return result;
  }

  async handleGameAction(membership: Membership | undefined, action: GameAction): Promise<ManagerResult> {
    const key = `game:${membership?.roomCode ?? 'none'}:${membership?.playerId ?? 'none'}:${action.clientActionId}`;
    const cached = this.processedActions.get(key);
    if (cached) return cached;
    const pending = this.inFlightActions.get(key);
    if (pending) return this.withoutRepeatedEffects(await pending);
    const operation = this.executeGameAction(membership, action);
    this.inFlightActions.set(key, operation);
    try {
      const result = await operation;
      this.rememberAction(key, result);
      return result;
    } finally {
      this.inFlightActions.delete(key);
    }
  }

  private async executeGameAction(membership: Membership | undefined, action: GameAction): Promise<ManagerResult> {
    const { room, player } = this.requireMembership(membership);
    if (!room.game || (room.phase !== 'game' && room.phase !== 'results')) throw new GameRuleError('NO_GAME', 'There is no active game.');
    if (room.waiting.some((candidate) => candidate.id === player.id)) throw new GameRuleError('WAITING', 'Waiting players cannot act in the current game.');
    if (room.pause) throw new GameRuleError('GAME_PAUSED', 'The round is paused while a player reconnects.');
    // Stack attempts have their own discard-generation lock and initial peeks
    // are intentionally concurrent per player. Reveal completion/concealment
    // must also survive a simultaneous stack mutation. Other turn and power
    // decisions target the exact state seen so delayed packets cannot land later.
    const independentlyConcurrent = action.type === 'STACK_ATTEMPT'
      || action.type === 'INITIAL_PEEK_START'
      || action.type === 'INITIAL_PEEK_END'
      || action.type === 'POWER_CONCEAL'
      || action.type === 'POWER_COMPLETE';
    if (!independentlyConcurrent && action.expectedVersion !== room.game.version) {
      throw new GameRuleError('STALE_STATE', 'The table changed before that action arrived. Try again.');
    }
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
    return { membership, effects: transition.effects };
  }

  async disconnect(code: string, playerId: string, explicitLeave = false): Promise<void> {
    const room = await this.get(code);
    if (!room) return;
    const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === playerId);
    if (!player) return;
    const wasWaiting = room.waiting.some((candidate) => candidate.id === playerId);
    player.connected = false;
    room.disconnectGrace[player.id] = Date.now() + RECONNECT_GRACE_MS;
    // A waiting player has no active-game seat to preserve. Remove an explicit
    // departure immediately so a disconnected ghost cannot be promoted later.
    if (explicitLeave && wasWaiting) {
      room.waiting = room.waiting.filter((candidate) => candidate.id !== player.id);
      delete room.disconnectGrace[player.id];
    } else if (room.phase === 'lobby' && explicitLeave) {
      room.players = room.players.filter((candidate) => candidate.id !== player.id);
      room.waiting = room.waiting.filter((candidate) => candidate.id !== player.id);
      this.promoteWaiting(room);
    } else if (room.game && room.game.players.some((candidate) => candidate.id === player.id)) {
      room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId, connected: false }, Date.now(), secureRandom).state;
      this.pauseForDisconnectedPlayers(room, Date.now());
    }
    if (room.hostPlayerId === player.id && explicitLeave) this.transferHost(room);
    if (![...room.players, ...room.waiting].some((candidate) => candidate.connected)) room.expiresAt = Date.now() + ROOM_TTL_MS;
    await this.save(room);
  }

  async reconnect(code: string, playerId: string): Promise<void> {
    const room = await this.get(code);
    if (!room) return;
    const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === playerId);
    if (!player) return;
    player.connected = true;
    delete room.disconnectGrace[player.id];
    if (room.game?.players.some((candidate) => candidate.id === player.id)) {
      room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId, connected: true }, Date.now(), secureRandom).state;
    }
    this.resumeIfEveryoneReturned(room, Date.now());
    await this.save(room);
  }

  async heartbeat(code: string, playerId: string, now: number, staleAfterMs: number): Promise<void> {
    const room = await this.get(code);
    if (!room) return;
    const player = [...room.players, ...room.waiting].find((candidate) => candidate.id === playerId);
    if (!player) return;
    player.lastSeenAt = now;
    if (!player.connected) {
      player.connected = true;
      delete room.disconnectGrace[player.id];
      if (room.game?.players.some((candidate) => candidate.id === player.id)) {
        room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId, connected: true }, now, secureRandom).state;
      }
    }
    for (const candidate of [...room.players, ...room.waiting]) {
      if (candidate.id === playerId || !candidate.connected || candidate.lastSeenAt === undefined || now - candidate.lastSeenAt <= staleAfterMs) continue;
      candidate.connected = false;
      room.disconnectGrace[candidate.id] = now + RECONNECT_GRACE_MS;
      if (room.game?.players.some((enginePlayer) => enginePlayer.id === candidate.id)) {
        room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId: candidate.id, connected: false }, now, secureRandom).state;
      }
    }
    this.pauseForDisconnectedPlayers(room, now);
    this.resumeIfEveryoneReturned(room, now);
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
      const host = room.players.find((player) => player.id === room.hostPlayerId);
      const hostGrace = host ? room.disconnectGrace[host.id] : undefined;
      if (host && !host.connected && hostGrace !== undefined && now >= hostGrace) {
        const previousHostId = room.hostPlayerId;
        this.transferHost(room);
        if (room.hostPlayerId !== previousHostId) {
          // Keep the expired deadline until any active turn owned by the old
          // host is auto-played below. Deleting it here gives that turn a fresh
          // grace period and makes timeout behavior depend on seat order.
          await this.save(room);
          changed.push(room.code);
        }
      }
      const game = room.game;
      if (!game || game.phase === 'results') continue;
      if (room.pause) {
        if (this.disconnectedGamePlayerIds(room).length > 0) continue;
        this.resumeIfEveryoneReturned(room, now);
        await this.save(room);
        changed.push(room.code);
      }
      let timedPlayerId: string | undefined;
      if (game.phase === 'initial_peek' && room.initialPeekDeadlineAt && room.initialPeekDeadlineAt <= now) {
        timedPlayerId = game.players.find((player) => !player.initialPeekComplete && !player.forfeited)?.id;
      } else if (game.transfer) {
        timedPlayerId = game.transfer.fromPlayerId;
      } else {
        timedPlayerId = game.turn?.playerId;
      }
      if (!timedPlayerId) continue;
      const engineDeadline = game.transfer?.deadlineAt ?? game.turn?.deadlineAt ?? room.initialPeekDeadlineAt ?? Infinity;
      const due = now >= engineDeadline;
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
      for (const player of [...restored.players, ...restored.waiting]) player.name = normalizeDisplayName(player.name);
      for (const player of restored.game?.players ?? []) player.name = normalizeDisplayName(player.name);
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
    const game = !isWaiting && room.game ? projectGame(room.game, playerId) : undefined;
    if (game?.phase === 'initial_peek') game.deadlineAt = room.initialPeekDeadlineAt;
    if (game && room.pause) {
      game.paused = {
        playerIds: this.disconnectedGamePlayerIds(room),
        remainingMs: this.pausedRemainingMs(room),
      };
    }
    return {
      code: room.code,
      phase: room.phase,
      selfPlayerId: playerId,
      hostPlayerId: room.hostPlayerId,
      players: room.players.map(mapPlayer),
      waiting: room.waiting.map(mapPlayer),
      game,
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
      checkpointVersion: 0,
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
      let waiting = room.waiting.includes(existing);
      if (waiting && room.phase === 'lobby' && room.players.length < 8) {
        room.waiting = room.waiting.filter((candidate) => candidate.id !== existing.id);
        existing.ready = false;
        room.players.push(existing);
        waiting = false;
      }
      if (room.game?.players.some((candidate) => candidate.id === existing.id)) {
        room.game = applyGameCommand(room.game, { type: 'SET_CONNECTED', playerId: existing.id, connected: true }, Date.now(), secureRandom).state;
      }
      this.resumeIfEveryoneReturned(room, Date.now());
      await this.save(room);
      return { membership: { roomCode: room.code, playerId: existing.id, waiting }, message: 'Reconnected to the room.' };
    }
    const player = await this.makePlayer(identity, name, Date.now());
    const waiting = room.phase !== 'lobby' || room.players.length >= 8;
    (waiting ? room.waiting : room.players).push(player);
    if (!waiting && !room.players.some((candidate) => candidate.id === room.hostPlayerId)) {
      room.hostPlayerId = player.id;
      player.ready = true;
    }
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
      room.pause = undefined;
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

  private promoteWaiting(room: RoomRuntime): void {
    while (room.players.length < 8) {
      const nextIndex = room.waiting.findIndex((candidate) => candidate.connected);
      if (nextIndex < 0) return;
      const [candidate] = room.waiting.splice(nextIndex, 1);
      candidate.ready = false;
      room.players.push(candidate);
    }
  }

  private disconnectedGamePlayerIds(room: RoomRuntime): string[] {
    if (!room.game || room.game.phase === 'results') return [];
    return room.game.players
      .filter((enginePlayer) => !enginePlayer.forfeited)
      .filter((enginePlayer) => !room.players.find((player) => player.id === enginePlayer.id)?.connected)
      .map((player) => player.id);
  }

  private pauseForDisconnectedPlayers(room: RoomRuntime, now: number): void {
    if (room.pause || !room.game || room.game.phase === 'results' || this.disconnectedGamePlayerIds(room).length === 0) return;
    room.pause = {
      startedAt: now,
      initialPeekRemainingMs: room.game.phase === 'initial_peek' && room.initialPeekDeadlineAt !== undefined
        ? Math.max(0, room.initialPeekDeadlineAt - now)
        : undefined,
      turnRemainingMs: room.game.turn ? Math.max(0, room.game.turn.deadlineAt - now) : undefined,
      transferRemainingMs: room.game.transfer ? Math.max(0, room.game.transfer.deadlineAt - now) : undefined,
    };
  }

  private resumeIfEveryoneReturned(room: RoomRuntime, now: number): void {
    if (!room.pause || this.disconnectedGamePlayerIds(room).length > 0) return;
    const minimumResumeMs = (remaining: number | undefined) => Math.max(1_000, remaining ?? 0);
    if (room.game?.phase === 'initial_peek' && room.pause.initialPeekRemainingMs !== undefined) {
      room.initialPeekDeadlineAt = now + minimumResumeMs(room.pause.initialPeekRemainingMs);
    }
    if (room.game?.turn && room.pause.turnRemainingMs !== undefined) {
      room.game.turn.deadlineAt = now + minimumResumeMs(room.pause.turnRemainingMs);
    }
    if (room.game?.transfer && room.pause.transferRemainingMs !== undefined) {
      room.game.transfer.deadlineAt = now + minimumResumeMs(room.pause.transferRemainingMs);
    }
    room.pause = undefined;
  }

  private refreshPauseAfterTableChange(room: RoomRuntime, now: number, previous: {
    phase: GameState['phase'];
    turnPlayerId?: string;
    turnStage?: TurnStage;
    transferFromPlayerId?: string;
    transferToPlayerId?: string;
  }): void {
    if (!room.pause) return;
    if (!room.game || room.game.phase === 'results') {
      room.pause = undefined;
      return;
    }

    const turnChanged = previous.phase !== room.game.phase
      || previous.turnPlayerId !== room.game.turn?.playerId
      || previous.turnStage !== room.game.turn?.stage;
    const transferChanged = previous.transferFromPlayerId !== room.game.transfer?.fromPlayerId
      || previous.transferToPlayerId !== room.game.transfer?.toPlayerId;
    if (turnChanged) room.pause.turnRemainingMs = room.game.turn ? Math.max(0, room.game.turn.deadlineAt - now) : undefined;
    if (transferChanged) room.pause.transferRemainingMs = room.game.transfer ? Math.max(0, room.game.transfer.deadlineAt - now) : undefined;
    if (previous.phase === 'initial_peek' && room.game.phase !== 'initial_peek') room.pause.initialPeekRemainingMs = undefined;

    // Keep the original frozen values for any timer whose underlying action did
    // not change. Rebuilding from absolute deadlines here would let wall-clock
    // time leak into a pause while another disconnected seat is still absent.
    if (this.disconnectedGamePlayerIds(room).length === 0) this.resumeIfEveryoneReturned(room, now);
  }

  private pausedRemainingMs(room: RoomRuntime): number {
    if (!room.pause) return 0;
    if (room.game?.phase === 'initial_peek') return room.pause.initialPeekRemainingMs ?? 0;
    if (room.game?.transfer) return room.pause.transferRemainingMs ?? 0;
    return room.pause.turnRemainingMs ?? 0;
  }

  private async save(room: RoomRuntime): Promise<void> {
    room.expiresAt = Date.now() + ROOM_TTL_MS;
    room.checkpointVersion = (room.checkpointVersion ?? room.game?.version ?? 0) + 1;
    await this.persistence.saveRoom(room.code, room, room.checkpointVersion, room.expiresAt);
  }

  private withoutRepeatedEffects(result: ManagerResult): ManagerResult {
    return { membership: result.membership };
  }

  private rememberAction(id: string, result: ManagerResult): void {
    this.processedActions.set(id, this.withoutRepeatedEffects(result));
    if (this.processedActions.size > 2_000) this.processedActions.delete(this.processedActions.keys().next().value!);
  }
}

export function gameCommandLabel(command: GameCommand): string {
  return command.type.toLowerCase().replaceAll('_', ' ');
}
