import { z } from 'zod';
import type { GameCommand, GameEffect, GameView } from './game.js';

export interface IdentityView {
  userId: string;
  anonymous: boolean;
  handle?: string;
  displayName?: string;
}

export interface RoomPlayerView {
  id: string;
  name: string;
  handle?: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  joinedAt: number;
  stats?: { games: number; wins: number; winRate: number };
}

export interface RoomView {
  code: string;
  phase: 'lobby' | 'game' | 'results';
  selfPlayerId: string;
  hostPlayerId: string;
  players: RoomPlayerView[];
  waiting: RoomPlayerView[];
  game?: GameView;
  expiresAt?: number;
}

export interface ActionAck {
  clientActionId: string;
  ok: boolean;
  code?: string;
  message?: string;
  outcome?: GameEffect['type'];
}

export interface ServerNotice {
  kind: GameEffect['type'] | 'info' | 'error';
  message: string;
  playerId?: string;
}

export const displayNameSchema = z.string().trim().min(2).max(20).regex(/^[\p{L}\p{N} _.'-]+$/u, 'Use letters, numbers, spaces, apostrophes, periods, underscores, or hyphens.');
export const handleSchema = z.string().trim().toLowerCase().min(3).max(20).regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers, or underscores.');
export const roomCodeSchema = z.string().trim().toUpperCase().regex(/^[A-HJ-NP-Z2-9]{8}$/);

export const roomActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ROOM_CREATE'), clientActionId: z.string(), name: displayNameSchema }),
  z.object({ type: z.literal('ROOM_JOIN'), clientActionId: z.string(), code: roomCodeSchema, name: displayNameSchema }),
  z.object({ type: z.literal('ROOM_READY'), clientActionId: z.string(), ready: z.boolean() }),
  z.object({ type: z.literal('ROOM_START'), clientActionId: z.string() }),
  z.object({ type: z.literal('ROOM_REMOVE'), clientActionId: z.string(), playerId: z.string() }),
  z.object({ type: z.literal('ROOM_REMATCH'), clientActionId: z.string() }),
  z.object({ type: z.literal('ROOM_LEAVE'), clientActionId: z.string() }),
]);

const baseGameAction = { clientActionId: z.string(), expectedVersion: z.number().int().nonnegative() };
export const gameActionSchema = z.discriminatedUnion('type', [
  z.object({ ...baseGameAction, type: z.literal('INITIAL_PEEK_START') }),
  z.object({ ...baseGameAction, type: z.literal('INITIAL_PEEK_END') }),
  z.object({ ...baseGameAction, type: z.literal('DRAW') }),
  z.object({ ...baseGameAction, type: z.literal('DISCARD_DRAWN') }),
  z.object({ ...baseGameAction, type: z.literal('SWAP_DRAWN'), targetCardId: z.string() }),
  z.object({ ...baseGameAction, type: z.literal('POWER_USE') }),
  z.object({ ...baseGameAction, type: z.literal('POWER_DECLINE') }),
  z.object({ ...baseGameAction, type: z.literal('POWER_SELECT'), targetCardId: z.string() }),
  z.object({ ...baseGameAction, type: z.literal('POWER_COMPLETE'), swap: z.boolean().optional() }),
  z.object({ ...baseGameAction, type: z.literal('STACK_ATTEMPT'), targetCardId: z.string(), discardGeneration: z.number().int() }),
  z.object({ ...baseGameAction, type: z.literal('TRANSFER_CARD'), cardId: z.string() }),
  z.object({ ...baseGameAction, type: z.literal('CALL_CAMBIO') }),
]);

export type RoomAction = z.infer<typeof roomActionSchema>;
export type GameAction = z.infer<typeof gameActionSchema>;

export function toGameCommand(action: GameAction, playerId: string): GameCommand {
  const { clientActionId: _, expectedVersion: __, ...command } = action;
  void _;
  void __;
  return { ...command, playerId } as GameCommand;
}
