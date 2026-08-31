import { describe, expect, it } from 'vitest';
import type { RoomView } from '../shared/protocol.js';
import { acceptRoomRevision, parseSignalFrame, RoomRevisionScope, roomViewFingerprint, sameMembership } from './transport.js';

const room = (revision: number, phase: RoomView['phase'] = 'lobby'): RoomView => ({
  code: 'PLAY2458',
  revision,
  phase,
  selfPlayerId: 'player-1',
  hostPlayerId: 'player-1',
  players: [],
  waiting: [],
  expiresAt: 10_000 + revision,
});

describe('HTTP realtime snapshot ordering', () => {
  it('rejects a poll that arrives after a newer action response', () => {
    expect(acceptRoomRevision(-1, undefined)).toBe(true);
    expect(acceptRoomRevision(42, undefined)).toBe(false);
    expect(acceptRoomRevision(42, 41)).toBe(false);
    expect(acceptRoomRevision(42, 42)).toBe(true);
    expect(acceptRoomRevision(42, 43)).toBe(true);
  });

  it('does not rerender for heartbeat-only revision and expiry changes', () => {
    expect(roomViewFingerprint(room(12))).toBe(roomViewFingerprint(room(13)));
    expect(roomViewFingerprint(room(13, 'game'))).not.toBe(roomViewFingerprint(room(13)));
  });

  it('starts a fresh revision scope after following a different room', () => {
    const scope = new RoomRevisionScope();
    scope.follow('OLDROOM2');
    expect(scope.accept({ ...room(48), code: 'OLDROOM2' })).toBe(true);
    expect(scope.accept({ ...room(47), code: 'OLDROOM2' })).toBe(false);

    scope.follow('NEWROOM2');
    expect(scope.latestRevision).toBe(-1);
    expect(scope.accept({ ...room(1), code: 'NEWROOM2' })).toBe(true);
  });

  it('recognizes when an in-flight sync belongs to a superseded membership', () => {
    const oldMembership = { roomCode: 'OLDROOM2', playerId: 'player-1', waiting: false };
    expect(sameMembership(oldMembership, { ...oldMembership })).toBe(true);
    expect(sameMembership(oldMembership, undefined)).toBe(false);
    expect(sameMembership(oldMembership, { ...oldMembership, roomCode: 'NEWROOM2' })).toBe(false);
    expect(sameMembership(oldMembership, { ...oldMembership, waiting: true })).toBe(false);
  });

  it('parses Upstash SSE frames without damaging JSON message commas', () => {
    expect(parseSignalFrame('subscribe,cambrio:signal:PLAY2458,1')).toEqual(['subscribe', 'cambrio:signal:PLAY2458', '1']);
    expect(parseSignalFrame('message,cambrio:signal:PLAY2458,{"revision":42,"actorPlayerId":"p1"}')).toEqual([
      'message',
      'cambrio:signal:PLAY2458',
      '{"revision":42,"actorPlayerId":"p1"}',
    ]);
  });
});
