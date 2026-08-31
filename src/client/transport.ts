import { io } from 'socket.io-client';
import type { ActionAck, RoomView, ServerNotice } from '../shared/protocol.js';
import type { ClientSession } from './auth.js';

type TransportEvent = 'connect' | 'disconnect' | 'connect_error' | 'room:state' | 'room:left' | 'notice';
interface TransportEventMap {
  connect: [];
  disconnect: [];
  connect_error: [Error];
  'room:state': [RoomView];
  'room:left': [{ message: string }];
  notice: [ServerNotice];
}
type Listener = (...args: unknown[]) => void;

interface HttpResponse {
  ack?: ActionAck;
  connected: true;
  membership?: { roomCode: string; playerId: string; waiting: boolean };
  state?: RoomView;
  notices?: ServerNotice[];
  left?: { message: string };
}

export interface ClientTransport {
  connected: boolean;
  active: boolean;
  on<Event extends TransportEvent>(event: Event, listener: (...args: TransportEventMap[Event]) => void): ClientTransport;
  disconnect(): void;
  timeout(milliseconds: number): {
    emit(event: 'room:action' | 'game:action', payload: unknown, callback: (error: Error | null, result: ActionAck) => void): void;
  };
}

export function createClientTransport(serverUrl: string, session: ClientSession): ClientTransport {
  if (import.meta.env.VITE_HTTP_TRANSPORT === 'true') return new HttpRealtimeTransport(serverUrl, session);
  return io(serverUrl, { auth: { token: session.token, visitorId: session.visitorId }, transports: ['websocket', 'polling'] }) as unknown as ClientTransport;
}

class HttpRealtimeTransport implements ClientTransport {
  connected = false;
  active = true;
  private listeners = new Map<TransportEvent, Set<Listener>>();
  private membership?: HttpResponse['membership'];
  private pollTimer?: number;
  private polling = false;
  private failures = 0;
  private nextPollMilliseconds = 900;
  private lastPresenceAt = 0;
  private readonly revisionScope = new RoomRevisionScope();
  private pollRequested = false;
  private signalRoomCode?: string;
  private signalController?: AbortController;
  private signalRetryTimer?: number;
  private signalGeneration = 0;
  private readonly endpoint: string;
  private readonly signalEndpoint: string;

  constructor(serverUrl: string, private session: ClientSession) {
    this.endpoint = new URL('/api/realtime', serverUrl).toString();
    this.signalEndpoint = new URL('/api/signal', serverUrl).toString();
    this.membership = this.restoreMembership();
    if (this.membership) this.followRoom(this.membership.roomCode);
    document.addEventListener('visibilitychange', this.wakeWhenVisible);
    window.addEventListener('online', this.wakeWhenVisible);
    window.addEventListener('pageshow', this.wakeWhenVisible);
    queueMicrotask(() => {
      if (!this.active) return;
      this.setConnected(true);
      void this.poll();
    });
  }

  on<Event extends TransportEvent>(event: Event, listener: (...args: TransportEventMap[Event]) => void): ClientTransport {
    const group = this.listeners.get(event) ?? new Set<Listener>();
    group.add(listener as unknown as Listener);
    this.listeners.set(event, group);
    return this;
  }

  disconnect() {
    this.active = false;
    window.clearTimeout(this.pollTimer);
    document.removeEventListener('visibilitychange', this.wakeWhenVisible);
    window.removeEventListener('online', this.wakeWhenVisible);
    window.removeEventListener('pageshow', this.wakeWhenVisible);
    this.signalGeneration += 1;
    this.signalController?.abort();
    window.clearTimeout(this.signalRetryTimer);
    this.signalController = undefined;
    this.signalRoomCode = undefined;
    this.setConnected(false);
  }

  timeout(milliseconds: number) {
    return {
      emit: (event: 'room:action' | 'game:action', payload: unknown, callback: (error: Error | null, result: ActionAck) => void) => {
        void this.action(event, payload, milliseconds).then((result) => callback(null, result)).catch((error: unknown) => {
          callback(error instanceof Error ? error : new Error('The server did not respond.'), { clientActionId: '', ok: false });
        });
      },
    };
  }

  private async action(event: 'room:action' | 'game:action', payload: unknown, milliseconds: number): Promise<ActionAck> {
    const response = await this.request({ operation: 'action', event, payload, membership: this.membership }, milliseconds);
    this.consume(response);
    return response.ack ?? { clientActionId: '', ok: false, message: 'The server returned no acknowledgement.' };
  }

  private async poll() {
    if (!this.active) return;
    if (this.polling) {
      this.pollRequested = true;
      return;
    }
    this.polling = true;
    try {
      if (this.membership) {
        const requestedMembership = this.membership;
        const now = Date.now();
        const presence = now - this.lastPresenceAt >= 5_000;
        if (presence) this.lastPresenceAt = now;
        const response = await this.request({ operation: 'sync', membership: requestedMembership, presence }, 7_000);
        // A leave, queue promotion, or new room action can finish while an
        // older sync is still in flight. That response belongs to the old
        // membership and must not resurrect or overwrite it.
        if (sameMembership(requestedMembership, this.membership)) this.consume(response);
      }
      this.failures = 0;
      this.setConnected(true);
    } catch (error) {
      this.failures += 1;
      if (this.failures >= 2) this.setConnected(false);
      if (this.failures === 2) this.emitLocal('connect_error', error instanceof Error ? error : new Error('Realtime connection lost.'));
    } finally {
      this.polling = false;
      if (this.active) {
        if (this.pollRequested && !document.hidden) {
          this.pollRequested = false;
          queueMicrotask(() => void this.poll());
        } else {
          this.pollTimer = window.setTimeout(() => void this.poll(), document.hidden ? 2_000 : this.nextPollMilliseconds);
        }
      }
    }
  }

  private wakeWhenVisible = () => {
    if (!this.active || document.hidden) return;
    this.requestImmediatePoll();
  };

  private requestImmediatePoll() {
    if (!this.active || document.hidden) return;
    window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    if (this.polling) this.pollRequested = true;
    else void this.poll();
  }

  private async request(body: unknown, milliseconds: number): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), milliseconds);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-visitor-id': this.session.visitorId,
          ...(this.session.token ? { Authorization: `Bearer ${this.session.token}` } : {}),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(response.status === 503 ? 'The live room service is still starting.' : 'The live room service did not respond.');
      return await response.json() as HttpResponse;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private consume(response: HttpResponse) {
    if (response.membership) {
      this.membership = response.membership;
      storeHttpMembership(response.membership);
      this.followRoom(response.membership.roomCode);
    }
    if (response.state) {
      this.nextPollMilliseconds = response.state.game?.paused ? 900 : response.state.game?.stackOpen ? 250 : response.state.phase === 'lobby' ? 900 : 650;
      // Polls and actions are intentionally concurrent. A slow poll must never
      // overwrite a newer action response and make the table jump backward.
      if (this.revisionScope.accept(response.state)) this.emitLocal('room:state', response.state);
    }
    for (const notice of response.notices ?? []) this.emitLocal('notice', notice);
    if (response.left) {
      this.membership = undefined;
      storeHttpMembership(undefined);
      this.followRoom(undefined);
      this.emitLocal('room:left', response.left);
    }
  }

  private followRoom(roomCode?: string) {
    if (roomCode === this.signalRoomCode && this.signalController) return;
    this.revisionScope.follow(roomCode);
    const generation = ++this.signalGeneration;
    this.signalController?.abort();
    window.clearTimeout(this.signalRetryTimer);
    this.signalController = undefined;
    this.signalRoomCode = roomCode;
    if (roomCode && this.active) void this.openSignalStream(roomCode, generation);
  }

  private async openSignalStream(roomCode: string, generation: number) {
    if (!this.membership || !this.active || generation !== this.signalGeneration) return;
    const controller = new AbortController();
    this.signalController = controller;
    try {
      const response = await fetch(this.signalEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-visitor-id': this.session.visitorId,
          ...(this.session.token ? { Authorization: `Bearer ${this.session.token}` } : {}),
        },
        body: JSON.stringify({ membership: this.membership }),
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error('The live update stream is unavailable.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      while (this.active && generation === this.signalGeneration) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data:')) this.consumeSignalFrame(line.slice(5).trim());
        }
      }
    } catch {
      // Polling is the correctness path. A transient acceleration-stream
      // outage is expected to reconnect quietly instead of spamming consoles.
    } finally {
      if (this.signalController === controller) this.signalController = undefined;
      if (!controller.signal.aborted && this.active && generation === this.signalGeneration && roomCode === this.signalRoomCode) {
        this.signalRetryTimer = window.setTimeout(() => void this.openSignalStream(roomCode, generation), 1_000);
      }
    }
  }

  private consumeSignalFrame(rawFrame: string) {
    try {
      const frame = parseSignalFrame(rawFrame);
      if (!frame || frame[0] !== 'message') return;
      const signal = typeof frame[2] === 'string' ? JSON.parse(frame[2]) as { revision?: unknown; actorPlayerId?: unknown } : frame[2] as { revision?: unknown; actorPlayerId?: unknown } | undefined;
      if (signal?.actorPlayerId === this.membership?.playerId) return;
      if (typeof signal?.revision === 'number' && signal.revision <= this.revisionScope.latestRevision) return;
      this.requestImmediatePoll();
    } catch {
      // Subscription acknowledgements and keep-alive frames carry no state.
    }
  }

  private restoreMembership(): HttpResponse['membership'] {
    try {
      const stored = JSON.parse(sessionStorage.getItem('cambrio:http-membership') ?? 'null') as HttpResponse['membership'];
      const pathCode = window.location.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{8})$/i)?.[1]?.toUpperCase();
      if (!stored || !pathCode || stored.roomCode !== pathCode) {
        storeHttpMembership(undefined);
        return undefined;
      }
      return stored;
    } catch {
      storeHttpMembership(undefined);
      return undefined;
    }
  }

  private setConnected(value: boolean) {
    if (this.connected === value) return;
    this.connected = value;
    this.emitLocal(value ? 'connect' : 'disconnect');
  }

  private emitLocal<Event extends TransportEvent>(event: Event, ...args: TransportEventMap[Event]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

export function acceptRoomRevision(latestRevision: number, incomingRevision?: number): boolean {
  // A legacy/malformed snapshot without a revision is safe only before the
  // client has accepted any authoritative room state. It must never be able
  // to replace a newer revision later in the session.
  return incomingRevision === undefined ? latestRevision < 0 : incomingRevision >= latestRevision;
}

export function sameMembership(
  first?: { roomCode: string; playerId: string; waiting: boolean },
  second?: { roomCode: string; playerId: string; waiting: boolean },
): boolean {
  return first?.roomCode === second?.roomCode
    && first?.playerId === second?.playerId
    && first?.waiting === second?.waiting;
}

function storeHttpMembership(membership: HttpResponse['membership']): void {
  try {
    if (membership) sessionStorage.setItem('cambrio:http-membership', JSON.stringify(membership));
    else sessionStorage.removeItem('cambrio:http-membership');
  } catch {
    // Hosted sync remains correct for the active page even when session
    // persistence is unavailable; only reload recovery is reduced.
  }
}

export class RoomRevisionScope {
  roomCode?: string;
  latestRevision = -1;
  private lastFingerprint = '';

  follow(roomCode?: string) {
    if (roomCode === this.roomCode) return;
    this.roomCode = roomCode;
    // Revisions are monotonic within a room, not across rooms. A freshly
    // created room commonly starts below the revision of the room just left.
    this.latestRevision = -1;
    this.lastFingerprint = '';
  }

  accept(state: RoomView): boolean {
    const revision = Number.isFinite(state.revision) ? state.revision : undefined;
    if (!acceptRoomRevision(this.latestRevision, revision)) return false;
    this.latestRevision = revision ?? this.latestRevision;
    const fingerprint = roomViewFingerprint(state);
    if (fingerprint === this.lastFingerprint) return false;
    this.lastFingerprint = fingerprint;
    return true;
  }
}

export function parseSignalFrame(rawFrame: string): unknown[] | undefined {
  try {
    const parsed = JSON.parse(rawFrame) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    const firstComma = rawFrame.indexOf(',');
    const secondComma = rawFrame.indexOf(',', firstComma + 1);
    if (firstComma <= 0 || secondComma <= firstComma) return undefined;
    return [rawFrame.slice(0, firstComma), rawFrame.slice(firstComma + 1, secondComma), rawFrame.slice(secondComma + 1)];
  }
}

export function roomViewFingerprint(state: RoomView): string {
  const { revision: _revision, expiresAt: _expiresAt, ...visibleState } = state;
  void _revision;
  void _expiresAt;
  return JSON.stringify(visibleState);
}
