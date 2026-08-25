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
  private readonly endpoint: string;

  constructor(serverUrl: string, private session: ClientSession) {
    this.endpoint = new URL('/api/realtime', serverUrl).toString();
    this.membership = this.restoreMembership();
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
    if (!this.active || this.polling) return;
    this.polling = true;
    try {
      if (this.membership) {
        const now = Date.now();
        const presence = now - this.lastPresenceAt >= 5_000;
        if (presence) this.lastPresenceAt = now;
        this.consume(await this.request({ operation: 'sync', membership: this.membership, presence }, 7_000));
      }
      this.failures = 0;
      this.setConnected(true);
    } catch (error) {
      this.failures += 1;
      if (this.failures >= 2) this.setConnected(false);
      if (this.failures === 2) this.emitLocal('connect_error', error instanceof Error ? error : new Error('Realtime connection lost.'));
    } finally {
      this.polling = false;
      if (this.active) this.pollTimer = window.setTimeout(() => void this.poll(), document.hidden ? 2_000 : this.nextPollMilliseconds);
    }
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
      sessionStorage.setItem('cambrio:http-membership', JSON.stringify(response.membership));
    }
    if (response.state) {
      this.nextPollMilliseconds = response.state.game?.paused ? 900 : response.state.game?.stackOpen ? 250 : response.state.phase === 'lobby' ? 900 : 650;
      this.emitLocal('room:state', response.state);
    }
    for (const notice of response.notices ?? []) this.emitLocal('notice', notice);
    if (response.left) {
      this.membership = undefined;
      sessionStorage.removeItem('cambrio:http-membership');
      this.emitLocal('room:left', response.left);
    }
  }

  private restoreMembership(): HttpResponse['membership'] {
    try {
      const stored = JSON.parse(sessionStorage.getItem('cambrio:http-membership') ?? 'null') as HttpResponse['membership'];
      const pathCode = window.location.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{8})$/i)?.[1]?.toUpperCase();
      if (!stored || !pathCode || stored.roomCode !== pathCode) {
        sessionStorage.removeItem('cambrio:http-membership');
        return undefined;
      }
      return stored;
    } catch {
      sessionStorage.removeItem('cambrio:http-membership');
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
