import { describe, expect, it } from 'vitest';
import type { RoomView } from '../shared/protocol.js';
import { acceptRoomRevision, parseSignalFrame, roomViewFingerprint } from './transport.js';

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
    expect(acceptRoomRevision(42, 41)).toBe(false);
    expect(acceptRoomRevision(42, 42)).toBe(true);
    expect(acceptRoomRevision(42, 43)).toBe(true);
  });

  it('does not rerender for heartbeat-only revision and expiry changes', () => {
    expect(roomViewFingerprint(room(12))).toBe(roomViewFingerprint(room(13)));
    expect(roomViewFingerprint(room(13, 'game'))).not.toBe(roomViewFingerprint(room(13)));
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
