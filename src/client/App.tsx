import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, Copy, Link2, UserRound, Volume2, VolumeX, Waves, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { nanoid } from 'nanoid';
import { MAX_HAND_CARDS, type CardView, type GameView, type PlayerView, type PowerKind } from '../shared/game.js';
import type { ActionAck, GameAction, RoomAction, RoomPlayerView, RoomView, ServerNotice } from '../shared/protocol.js';
import { ensureClientSession, getSupabase, type ClientSession } from './auth.js';
import { useGameAudio } from './audio.js';
import { createClientTransport, type ClientTransport } from './transport.js';

const serverUrl = (import.meta.env.VITE_SERVER_URL as string | undefined) || window.location.origin;
type ClientSocket = ClientTransport;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RoomActionInput = DistributiveOmit<RoomAction, 'clientActionId'>;
type GameActionInput = DistributiveOmit<GameAction, 'clientActionId' | 'expectedVersion'>;

export function App() {
  const [session, setSession] = useState<ClientSession>();
  const [socket, setSocket] = useState<ClientSocket>();
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<RoomView>();
  const [notice, setNotice] = useState<ServerNotice>();
  const [fatal, setFatal] = useState<string>();
  const [profileReady, setProfileReady] = useState<boolean>();
  const roomRef = useRef<RoomView | undefined>(undefined);
  const audio = useGameAudio();
  const audioRef = useRef(audio.playNotice);
  const pendingRoomActions = useRef(new Set<string>());
  const pendingGameActions = useRef(new Set<string>());
  const noticePhase = useRef('home');
  const currentNoticePhase = room ? `${room.phase}:${room.game?.phase ?? 'none'}` : 'home';
  useEffect(() => { audioRef.current = audio.playNotice; }, [audio.playNotice]);

  useEffect(() => {
    let active = true;
    void ensureClientSession().then((value) => active && setSession(value)).catch((error) => setFatal(error.message));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    const next = createClientTransport(serverUrl, session);
    next.on('connect', () => { setConnected(true); setFatal(undefined); });
    next.on('disconnect', () => setConnected(false));
    next.on('connect_error', (error) => {
      setConnected(false);
      // Socket.IO keeps `active` true for recoverable transport failures. A
      // rejected namespace/auth handshake is terminal and needs user action.
      if (!next.active) setFatal(error.message);
    });
    next.on('room:state', (state: RoomView) => {
      roomRef.current = state;
      setRoom(state);
      const expectedPath = `/room/${state.code}`;
      if (window.location.pathname !== expectedPath) window.history.replaceState({}, '', expectedPath);
    });
    next.on('room:left', ({ message }: { message: string }) => {
      roomRef.current = undefined;
      setRoom(undefined);
      window.history.replaceState({}, '', '/');
      const value: ServerNotice = { kind: 'error', message };
      audioRef.current(value);
      setNotice(value);
      window.setTimeout(() => setNotice((current) => current === value ? undefined : current), 3_500);
    });
    next.on('notice', (value: ServerNotice) => {
      audioRef.current(value);
      // Exact card movement is already shown on the table. Repeating the same
      // sentence as a bottom toast covers the local hand on phones.
      const hasLocalStackFeedback = (value.kind === 'stack' || value.kind === 'penalty') && value.playerId === roomRef.current?.selfPlayerId;
      if (isInlineNotice(value) || hasLocalStackFeedback) return;
      setNotice(value);
      window.setTimeout(() => setNotice((current) => current === value ? undefined : current), 3_500);
    });
    setSocket(next);
    return () => { next.disconnect(); };
  }, [session]);

  useEffect(() => {
    if (currentNoticePhase !== noticePhase.current) {
      noticePhase.current = currentNoticePhase;
      setNotice((current) => current?.kind === 'error' ? current : undefined);
    }
  }, [currentNoticePhase]);

  useEffect(() => {
    if (!session) return;
    const headers = new Headers(session.token ? { Authorization: `Bearer ${session.token}` } : { 'x-visitor-id': session.visitorId });
    void fetch('/api/me', { headers }).then((response) => response.json()).then((value) => setProfileReady(Boolean(value.handle))).catch(() => setProfileReady(false));
  }, [session]);

  const showActionError = useCallback((result: ActionAck) => {
    if (!result.ok) {
      const value: ServerNotice = { kind: 'error', message: result.message ?? 'That action is not available.' };
      setNotice(value);
      window.setTimeout(() => setNotice((current) => current === value ? undefined : current), 3_500);
    }
    return result;
  }, []);
  const sendRoom = useCallback(async (input: RoomActionInput) => {
    const key = input.type;
    if (pendingRoomActions.current.has(key)) return { clientActionId: 'pending', ok: false, code: 'ACTION_PENDING' };
    pendingRoomActions.current.add(key);
    try {
      return showActionError(await emitAction(socket, 'room:action', { ...input, clientActionId: nanoid() }));
    } finally {
      pendingRoomActions.current.delete(key);
    }
  }, [showActionError, socket]);
  const sendGame = useCallback(async (input: GameActionInput) => {
    const currentGame = roomRef.current?.game;
    if (!currentGame) return Promise.resolve<ActionAck>({ clientActionId: '', ok: false, message: 'No active game.' });
    const key = gameActionGroup(input.type);
    if (pendingGameActions.current.has(key)) return { clientActionId: 'pending', ok: false, code: 'ACTION_PENDING' };
    pendingGameActions.current.add(key);
    try {
      return showActionError(await emitAction(socket, 'game:action', { ...input, clientActionId: nanoid(), expectedVersion: currentGame.version }));
    } finally {
      pendingGameActions.current.delete(key);
    }
  }, [showActionError, socket]);
  const leaveRoom = useCallback(async () => {
    const result = await sendRoom({ type: 'ROOM_LEAVE' });
    if (!result.ok) return;
    roomRef.current = undefined;
    setRoom(undefined);
    window.history.replaceState({}, '', '/');
  }, [sendRoom]);

  if (fatal) return <FatalScreen message={fatal} />;
  if (!session || !socket) return <LoadingScreen />;

  const profileMatch = window.location.pathname.match(/^\/u\/([a-z0-9_]+)$/);
  if (profileMatch && !room) return <PublicProfile handle={profileMatch[1]} onHome={() => { window.history.pushState({}, '', '/'); window.location.reload(); }} />;

  const waitingPlayer = room?.waiting.find((player) => player.id === room.selfPlayerId);

  return (
    <div className="app-shell">
      <TopBar connected={connected} session={session} audio={audio} compact={Boolean(room?.game && !waitingPlayer)} forceProfile={!session.anonymous && profileReady === false} onProfileSaved={() => setProfileReady(true)} onLeave={room ? leaveRoom : undefined} />
      <AnimatePresence mode="wait">
        {!room ? (
          <Landing key="landing" connected={connected} send={sendRoom} initialCode={roomCodeFromPath()} />
        ) : waitingPlayer ? (
          <WaitingRoom key="waiting" room={room} player={waitingPlayer} onLeave={() => void leaveRoom()} />
        ) : room.phase === 'lobby' ? (
          <Lobby key="lobby" room={room} send={sendRoom} />
        ) : room.game ? (
          <GameTable key="game" room={room} send={sendGame} sendRoom={sendRoom} />
        ) : (
          <LoadingScreen key="room-loading" label="Restoring the table…" />
        )}
      </AnimatePresence>
      <AnimatePresence>{notice && <Toast notice={notice} />}</AnimatePresence>
    </div>
  );
}

function WaitingRoom({ room, player, onLeave }: { room: RoomView; player: RoomPlayerView; onLeave: () => void }) {
  const position = room.waiting.findIndex((candidate) => candidate.id === player.id) + 1;
  const roundActive = room.phase !== 'lobby';
  return (
    <motion.main className="waiting-page page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
      <section className="waiting-card glass" aria-labelledby="waiting-title">
        <div className="waiting-orbit" aria-hidden="true"><span>{position}</span></div>
        <p className="eyebrow">Room {room.code}</p>
        <h1 id="waiting-title">{roundActive ? 'Round in progress.' : 'Table is full.'}</h1>
        <p>{roundActive ? 'You’re next in line. Keep this tab open and Cambrio will move you into the lobby when the round ends.' : 'You’re next in line. If a seat opens before the deal, Cambrio will move you in automatically.'}</p>
        <div className="queue-status" role="status" aria-live="polite">
          <span><b>#{position}</b> in queue</span>
          <span><b>{room.players.length}</b> at the table</span>
        </div>
        <div className="seated-preview" aria-label="Players currently at the table">
          {room.players.map((seated) => <span key={seated.id} title={seated.name}>{seated.name.slice(0, 2).toUpperCase()}</span>)}
        </div>
        <button className="secondary leave-queue" onClick={onLeave}>Leave queue</button>
      </section>
    </motion.main>
  );
}

function TopBar({ connected, session, audio, compact, forceProfile, onProfileSaved, onLeave }: { connected: boolean; session: ClientSession; audio: ReturnType<typeof useGameAudio>; compact: boolean; forceProfile: boolean; onProfileSaved: () => void; onLeave?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <header className={`topbar ${compact ? 'game-topbar' : ''}`}>
      <a className="brand" href="/" title="Cambrio home"><span className="brand-mark" aria-hidden="true"><CambrioGlyph decorative /></span><span className="brand-word">cambrio</span></a>
      <div className="top-actions">
        <span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Live' : 'Reconnecting'}</span>
        <button className="icon-button" onClick={audio.toggleEffects} aria-label="Toggle sound effects">{audio.settings.effects ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
        <button className={`icon-button ${audio.settings.ambience ? 'active' : ''}`} onClick={audio.toggleAmbience} aria-label="Toggle ambience"><Waves size={17} /></button>
        <button className="profile-chip" onClick={() => setOpen(true)}><UserRound size={15} /><span>{session.anonymous ? 'Guest' : session.session?.user.email?.split('@')[0] ?? 'Profile'}</span></button>
      </div>
      <AnimatePresence>{(open || forceProfile) && <AccountPanel session={session} close={() => setOpen(false)} force={forceProfile} onSaved={onProfileSaved} onLeave={onLeave} />}</AnimatePresence>
    </header>
  );
}

function Landing({ connected, send, initialCode }: { connected: boolean; send: (action: RoomActionInput) => Promise<ActionAck>; initialCode?: string }) {
  const [name, setName] = useState(() => localStorage.getItem('cambrio:name') ?? '');
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const autoJoinAttempted = useRef(false);
  const submit = async (mode: 'create' | 'join') => {
    setBusy(true); setError('');
    localStorage.setItem('cambrio:name', name.trim());
    const result = await send(mode === 'create' ? { type: 'ROOM_CREATE', name } : { type: 'ROOM_JOIN', name, code: code.toUpperCase() });
    if (!result.ok) setError(result.message ?? 'Unable to continue.');
    setBusy(false);
  };
  useEffect(() => {
    if (!connected || !initialCode || name.trim().length < 2 || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void submit('join');
  // The saved name and invite code are intentionally sampled once on arrival.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
  return (
    <motion.main className="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="hero-copy">
        <p className="eyebrow">Memory. Nerve. Perfect timing.</p>
        <h1>Know your cards.<br /><em>Trust your read.</em></h1>
        <p className="lede">The private-room card game where every hidden card matters—and one fearless stack can change everything.</p>
        <div className="feature-row"><span>2–8 players</span><span><Link2 size={13} />Private rooms</span><span>No download</span></div>
      </div>
      <section className="join-panel glass">
        <div className="mini-cards" aria-hidden="true"><i /><i /><i /></div>
        <h2>{initialCode ? 'Join this table' : 'Take a seat'}</h2>
        <label>Your display name<input name="displayName" autoComplete="name" value={name} maxLength={20} onChange={(event) => setName(event.target.value)} placeholder="What should friends call you?" /></label>
        {initialCode ? (
          <button className="primary wide" disabled={!connected || busy || name.trim().length < 2} onClick={() => void submit('join')}>Join room <ArrowRight size={17} /></button>
        ) : (
          <>
            <button className="primary wide" disabled={!connected || busy || name.trim().length < 2} onClick={() => void submit('create')}>Create private room <ArrowRight size={17} /></button>
            <div className="or"><span>or join with a code</span></div>
            <div className="code-row"><input name="roomCode" aria-label="Room code" className="code-input" value={code} maxLength={8} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD2345" /><button disabled={!connected || busy || code.length !== 8 || name.trim().length < 2} onClick={() => void submit('join')}>Join</button></div>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <small>No account required. Your room expires two hours after everyone leaves.</small>
      </section>
    </motion.main>
  );
}

function Lobby({ room, send }: { room: RoomView; send: (action: RoomActionInput) => Promise<ActionAck> }) {
  const self = room.players.find((player) => player.id === room.selfPlayerId);
  const isHost = self?.isHost;
  const shareUrl = `${window.location.origin}/room/${room.code}`;
  const allReady = room.players.length >= 2 && room.players.every((player) => player.isHost || (player.ready && player.connected));
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<string>();
  const copy = async () => { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  const act = async (key: string, action: RoomActionInput) => {
    if (pending) return;
    setPending(key);
    try { await send(action); } finally { setPending(undefined); }
  };
  return (
    <motion.main className="lobby page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <section className="lobby-heading"><div><p className="eyebrow">Private table</p><h1>Room <span>{room.code}</span></h1><p>Share the link, ready up, then the host deals.</p></div><button className="share-button" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied!' : 'Copy invite link'}</button></section>
      <div className="lobby-grid">
        <section className="glass player-list"><div className="section-heading"><div><h2>Players</h2><span>{room.players.length}/8 seated</span></div><div className="seat-meter" aria-label={`${room.players.length} of 8 seats filled`}>{Array.from({ length: 8 }, (_, index) => <i className={index < room.players.length ? 'filled' : ''} key={index} />)}</div></div><AnimatePresence initial={false}>{room.players.map((player) => <LobbyPlayer key={player.id} player={player} self={player.id === room.selfPlayerId} canRemove={Boolean(isHost && player.id !== room.selfPlayerId)} pending={pending === `remove:${player.id}`} remove={() => void act(`remove:${player.id}`, { type: 'ROOM_REMOVE', playerId: player.id })} />)}</AnimatePresence></section>
        <aside className="glass lobby-rules">
          <div className="briefing-title"><p className="eyebrow">Round in 3 steps</p><h2>Remember. Trade. Stack.</h2></div>
          <div className="briefing-flow" aria-label="Quick rules"><span><b>1</b><small>Peek at your bottom two</small></span><span><b>2</b><small>Draw, discard, or swap</small></span><span><b>3</b><small>Stack the matching rank</small></span></div>
        </aside>
      </div>
      <div className="lobby-footer">
        {!isHost && self && <button className={`${self.ready ? 'secondary ready' : 'primary'} ${pending === 'ready' ? 'is-pending' : ''}`} aria-busy={pending === 'ready'} disabled={Boolean(pending)} onClick={() => void act('ready', { type: 'ROOM_READY', ready: !self.ready })}>{pending === 'ready' ? <span className="button-spinner" /> : self.ready && <Check size={16} />}{self.ready ? 'Ready' : 'Ready up'}</button>}
        {isHost && <button className={`primary deal ${pending === 'start' ? 'is-pending' : ''}`} aria-busy={pending === 'start'} disabled={!allReady || Boolean(pending)} onClick={() => void act('start', { type: 'ROOM_START' })}>{pending === 'start' && <span className="button-spinner" />}{allReady ? 'Deal the cards' : room.players.length < 2 ? 'Waiting for players' : 'Waiting for ready players'}</button>}
      </div>
    </motion.main>
  );
}

function LobbyPlayer({ player, self, canRemove, pending, remove }: { player: RoomPlayerView; self: boolean; canRemove: boolean; pending: boolean; remove: () => void }) {
  const initials = player.name.slice(0, 2).toUpperCase();
  return <motion.div layout initial={{ opacity: 0, scale: .96 }} animate={{ opacity: pending ? .55 : 1, scale: 1 }} exit={{ opacity: 0, scale: .96 }} className={`lobby-player ${!player.connected ? 'offline' : ''} ${self ? 'self' : ''}`}><div className="avatar">{initials}</div><div className="player-info"><strong>{player.name}{self ? ' (you)' : ''}</strong><span>{player.handle ? <a href={`/u/${player.handle}`}>@{player.handle}</a> : 'Guest player'} · {player.stats?.wins ?? 0} wins</span></div>{player.isHost ? <span className="host-badge">HOST</span> : <span className={`ready-dot ${player.ready ? 'yes' : ''}`}>{player.ready && <Check size={10} />}{player.ready ? 'READY' : 'WAITING'}</span>}{canRemove && <button className="remove-player" disabled={pending} onClick={remove} aria-label={`Remove ${player.name}`}>{pending ? <span className="button-spinner" /> : <X size={15} />}</button>}</motion.div>;
}

export function GameTable({ room, send, sendRoom }: { room: RoomView; send: (action: GameActionInput) => Promise<ActionAck>; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const game = room.game!;
  const self = game.players.find((player) => player.id === room.selfPlayerId)!;
  const [revealVisible, setRevealVisible] = useState(false);
  const [stackFeedback, setStackFeedback] = useState<{ cardId: string; kind: StackFeedback }>();
  const [tableCue, setTableCue] = useState<TableCue>();
  const [pendingGroups, setPendingGroups] = useState<string[]>([]);
  const [pendingCardId, setPendingCardId] = useState<string>();
  const reduceMotion = useReducedMotion();
  const feedbackTimer = useRef<number | undefined>(undefined);
  const cueTimer = useRef<number | undefined>(undefined);
  const pendingUiActions = useRef(new Set<string>());
  const sendRef = useRef(send);
  const motionSnapshot = useRef<TableSnapshot | undefined>(undefined);

  useEffect(() => () => { window.clearTimeout(feedbackTimer.current); window.clearTimeout(cueTimer.current); }, []);
  useEffect(() => { sendRef.current = send; }, [send]);
  const performAction = useCallback(async (input: GameActionInput, cardId?: string) => {
    const group = gameActionGroup(input.type);
    if (pendingUiActions.current.has(group)) return { clientActionId: 'pending', ok: false, code: 'ACTION_PENDING' } satisfies ActionAck;
    pendingUiActions.current.add(group);
    setPendingGroups([...pendingUiActions.current]);
    if (cardId) setPendingCardId(cardId);
    try {
      return await send(input);
    } finally {
      pendingUiActions.current.delete(group);
      setPendingGroups([...pendingUiActions.current]);
      if (cardId) setPendingCardId((current) => current === cardId ? undefined : current);
    }
  }, [send]);
  useLayoutEffect(() => {
    const current = snapshotTable(game);
    const previous = motionSnapshot.current;
    motionSnapshot.current = current;
    if (!previous) return;
    const moved = [...current.locations.entries()].filter(([cardId, location]) => {
      const before = previous.locations.get(cardId);
      return before && !sameLocation(before, location);
    });
    const handMoves = moved.filter(([cardId, destination]) => previous.locations.get(cardId)?.zone === 'hand' && destination.zone === 'hand');
    let cue: TableCue | undefined;
    if (handMoves.length >= 2) {
      const movements = handMoves.slice(0, 2).map(([cardId, destination]) => ({ cardId, from: previous.locations.get(cardId)!, to: destination }));
      cue = { id: game.version, kind: 'exchange', title: previous.powerKind === 'black_king' ? 'Black King swap' : 'Blind swap', movements, from: locationLabel(movements[0].from), to: locationLabel(movements[0].to) };
    } else if (current.discardId && current.discardId !== previous.discardId) {
      const source = previous.locations.get(current.discardId)
        ?? (previous.turnStage === 'deciding' ? { zone: 'drawn' } as const : previous.turnStage === 'awaiting_draw' ? { zone: 'deck' } as const : undefined);
      if (source) {
        const kind = previous.stackOpen && source.zone === 'hand' ? 'stack' : 'discard';
        const discard: TableLocation = { zone: 'discard' };
        const discarded: TableMovement = { cardId: current.discardId, from: source, to: discard, face: game.discard, faceDirection: 'reveal' };
        const enteringHand = moved.find(([cardId, destination]) => cardId !== current.discardId && destination.zone === 'hand' && (previous.locations.get(cardId)?.zone === 'drawn'))
          ?? [...current.locations.entries()].find(([cardId, destination]) => cardId !== current.discardId && destination.zone === 'hand' && !previous.locations.has(cardId));
        if (kind !== 'stack' && source.zone === 'hand' && enteringHand) {
          const [cardId, destination] = enteringHand;
          const incomingFace = previous.drawn?.id === cardId ? previous.drawn : undefined;
          const incoming: TableMovement = { cardId, from: { zone: 'drawn' }, to: destination, face: incomingFace, faceDirection: incomingFace ? 'conceal' : undefined };
          cue = { id: game.version, kind: 'replace', title: 'Card replaced', movements: [discarded, incoming], from: 'Drawn card', to: locationLabel(destination), coveredDiscard: previous.discard };
        } else {
          const title = kind === 'stack' ? 'Card stacked' : source.zone === 'drawn' ? 'Drawn card discarded' : 'Card replaced';
          cue = { id: game.version, kind, title, movements: [discarded], from: locationLabel(source), to: 'Discard', coveredDiscard: previous.discard };
        }
      }
    } else if (previous.turnStage === 'awaiting_draw' && current.turnStage === 'deciding') {
      const drawn = current.drawn;
      cue = { id: game.version, kind: 'draw', title: 'Card drawn', movements: [{ cardId: drawn?.id ?? `draw-${game.version}`, from: { zone: 'deck' }, to: { zone: 'drawn' }, face: drawn, faceDirection: drawn ? 'reveal' : undefined }], from: 'Deck', to: 'Drawn card' };
    } else if (moved.length === 1) {
      const [cardId, destination] = moved[0];
      const source = previous.locations.get(cardId)!;
      const movements = [{ cardId, from: source, to: destination }];
      cue = { id: game.version, kind: 'transfer', title: 'Card transfer', movements, from: locationLabel(source), to: locationLabel(destination) };
    }
    if (!cue) return;
    setTableCue(cue);
    window.clearTimeout(cueTimer.current);
    cueTimer.current = window.setTimeout(() => setTableCue(undefined), cueLifetime(cue.kind));
  // A new authoritative game version is the animation trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.version]);
  const revealKey = game.power?.status === 'revealing' ? `${game.power.kind}:${game.power.targets.join(':')}` : '';
  useEffect(() => {
    if (!revealKey || game.power?.status !== 'revealing') {
      setRevealVisible(false);
      return;
    }
    let finished = false;
    setRevealVisible(true);
    const finish = () => {
      if (finished) return;
      finished = true;
      setRevealVisible(false);
      if (game.power?.kind === 'black_king') void sendRef.current({ type: 'POWER_CONCEAL' });
      else void sendRef.current({ type: 'POWER_COMPLETE' });
    };
    const timer = window.setTimeout(finish, 1_700);
    const concealWhenHidden = () => { if (document.hidden) finish(); };
    window.addEventListener('blur', finish);
    document.addEventListener('visibilitychange', concealWhenHidden);
    return () => { window.clearTimeout(timer); window.removeEventListener('blur', finish); document.removeEventListener('visibilitychange', concealWhenHidden); };
  // revealKey represents a new server-approved private reveal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  // Recover rounds saved by the older opt-in power flow. Current rounds enter
  // targeting immediately, so no extra confirmation tap is required.
  useEffect(() => {
    if (game.activePlayerId !== self.id || game.power?.status !== 'offered') return;
    void sendRef.current({ type: 'POWER_USE' });
  }, [game.activePlayerId, game.power?.status, game.version, self.id]);

  if (game.phase === 'initial_peek') return <InitialPeek game={game} self={self} send={send} />;
  if (game.phase === 'results') return <Results room={room} game={game} sendRoom={sendRoom} />;

  const opponents = game.players.filter((player) => player.id !== self.id && !player.forfeited);
  const paused = Boolean(game.paused);
  const isTurn = game.activePlayerId === self.id && !paused;
  const power = isTurn ? game.power : undefined;
  const selectingPower = power?.status === 'selecting';
  const transferring = game.transfer?.fromPlayerId === self.id;
  const canSwapDrawn = isTurn && game.turnStage === 'deciding' && Boolean(game.drawnCard) && self.cards.length > 0;
  const canRiskStack = self.cards.length > 0 && !game.stackLocked && !paused;
  const stackReady = game.stackOpen && canRiskStack && !transferring && !selectingPower;
  const stackLocked = game.stackOpen && Boolean(game.stackLocked) && !transferring && !selectingPower;
  // Calling is intentionally table-wide: a player may call while another
  // player's turn is in progress, and that caller anchors the final rotation.
  const canCallCambrio = !game.ending && !paused;

  const attemptStack = async (card: CardView) => {
    if (stackFeedback?.kind === 'trying') return;
    setStackFeedback({ cardId: card.id, kind: 'trying' });
    const result = await performAction({ type: 'STACK_ATTEMPT', targetCardId: card.id, discardGeneration: game.discardGeneration }, card.id);
    const kind: StackFeedback = result.outcome === 'stack' ? 'correct' : result.outcome === 'penalty' ? 'wrong' : result.outcome === 'stack_lock' ? 'locked' : 'closed';
    vibrate(kind === 'correct' ? 32 : kind === 'wrong' ? [18, 35, 18] : 12);
    setStackFeedback({ cardId: card.id, kind });
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setStackFeedback(undefined), kind === 'wrong' ? 1_500 : 1_100);
  };
  const actionCard = (card: CardView, owner: PlayerView) => {
    if (transferring && owner.id === self.id) { vibrate(10); return void performAction({ type: 'TRANSFER_CARD', cardId: card.id }, card.id); }
    if (selectingPower) { vibrate(10); return void performAction({ type: 'POWER_SELECT', targetCardId: card.id }, card.id); }
    if (canSwapDrawn && owner.id === self.id) { vibrate(14); return void performAction({ type: 'SWAP_DRAWN', targetCardId: card.id }, card.id); }
    if (game.stackOpen && canRiskStack) return void attemptStack(card);
  };
  const canInteract = (owner: PlayerView) => {
    if (transferring) return owner.id === self.id;
    if (selectingPower && power) return isEligiblePowerTarget(power.kind, power.targets.length, owner.id, self.id, self.cards.length);
    if (canSwapDrawn && owner.id === self.id) return true;
    return game.stackOpen && canRiskStack;
  };
  const isContextTarget = (owner: PlayerView) => {
    if (transferring) return owner.id === self.id;
    if (selectingPower && power) return isEligiblePowerTarget(power.kind, power.targets.length, owner.id, self.id, self.cards.length);
    return canSwapDrawn && owner.id === self.id;
  };
  const targetCue = (owner: PlayerView): CardTargetCue | undefined => {
    if (!isContextTarget(owner)) return undefined;
    if (transferring) return 'give';
    if (canSwapDrawn) return 'swap';
    if (!power) return undefined;
    if (power.kind === 'own_peek' || power.kind === 'opponent_peek') return 'step-1';
    return power.targets.length === 0 ? 'step-1' : 'step-2';
  };
  const turnDecisionPending = pendingGroups.includes('turn-decision');
  const powerPending = pendingGroups.includes('power');
  const selectionKind = power && (power.kind === 'own_peek' || power.kind === 'opponent_peek') ? 'peek' : power ? 'swap' : undefined;
  const receivingDiscard = Boolean(tableCue?.movements.some((movement) => movement.to.zone === 'discard'));

  return (
    <motion.main className={`game-page ${stackReady ? 'stack-mode' : ''} ${revealVisible ? 'reveal-focus-mode' : ''} ${paused ? 'is-paused' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="game-status"><span className="room-pill" data-short={room.code.slice(0, 2)}>{room.code}</span><TurnBanner game={game} self={self} /><Countdown deadline={game.deadlineAt} pausedMs={game.paused?.remainingMs} /></div>
      <section className="opponent-rail" aria-label="Other players" style={{ '--opponent-count': Math.max(1, opponents.length) } as CSSProperties}>
        {opponents.map((opponent) => <PlayerHand key={opponent.id} player={opponent} compact canInteract={() => canInteract(opponent)} highlight={() => isContextTarget(opponent)} targetCue={targetCue(opponent)} selectionKind={selectionKind} selectedCards={power?.targets} pendingCardId={pendingCardId} arrivingSlots={flightSlots(tableCue, opponent.id)} feedback={stackFeedback} reveal={revealVisible} onCard={(card) => actionCard(card, opponent)} active={game.activePlayerId === opponent.id} />)}
      </section>

      <section className="table-center">
        {game.paused && <PauseBanner game={game} />}
        <div className="pile-zone">
          <div className={`pile ${receivingDiscard ? 'receiving-flight' : ''}`} data-table-zone="discard"><div className="discard-stack">{receivingDiscard && tableCue?.coveredDiscard && <span className="covered-discard" aria-hidden="true"><Card card={tableCue.coveredDiscard} /></span>}<span className="current-discard"><Card card={game.discard} faceDown={!game.discard} /></span></div><span>{game.discard ? 'DISCARD' : 'EMPTY'}</span></div>
          <button data-table-zone="deck" className={`deck-card ${isTurn && game.turnStage === 'awaiting_draw' ? 'draw-ready' : ''} ${pendingGroups.includes('DRAW') ? 'is-pending' : ''}`} aria-busy={pendingGroups.includes('DRAW')} disabled={!isTurn || game.turnStage !== 'awaiting_draw' || Boolean(game.transfer) || pendingGroups.includes('DRAW')} onClick={() => { vibrate(10); void performAction({ type: 'DRAW' }); }} title={`Draw from deck; ${game.deckCount} cards remain`}><CardBackMark />{pendingGroups.includes('DRAW') && <span className="deck-pending" aria-hidden="true" />}<small>{game.deckCount}</small></button>
        </div>
        <span className="drawn-flight-anchor" data-table-zone="drawn" aria-hidden="true" />
        <AnimatePresence mode="wait" initial={false}>
          {game.drawnCard ? <motion.div key="drawn" data-table-zone="drawn-card" className={`drawn-panel ${tableCue?.kind === 'draw' ? 'receiving-draw' : ''}`} initial={reduceMotion ? false : { opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .98 }} transition={{ duration: reduceMotion ? 0 : .16, ease: [0.22, 1, 0.36, 1] }}><span>DRAWN</span><Card card={game.drawnCard} /><div className="drawn-actions"><button className={`primary discard-drawn ${turnDecisionPending ? 'is-pending' : ''}`} aria-busy={turnDecisionPending} disabled={turnDecisionPending} onClick={() => { vibrate(12); void performAction({ type: 'DISCARD_DRAWN' }); }}>{turnDecisionPending ? <span className="button-spinner" /> : <GameGlyph kind="discard" />}Discard</button>{self.cards.length > 0 && <small className="swap-slot-cue"><GameGlyph kind="swap" />Tap a marked slot to keep</small>}</div></motion.div> : stackReady ? <motion.div key="stack-open" className="stack-hint" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : .08 }}><GameGlyph kind="stack" /><strong>STACK OPEN</strong><span>Tap any remembered matching card</span></motion.div> : stackLocked ? <motion.div key="stack-locked" className="stack-hint limit" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : .08 }}><GameGlyph kind="stack" /><strong>STACK MISSED</strong><span>Try again on the next discard</span></motion.div> : null}
        </AnimatePresence>
      </section>

      <section className="self-zone"><PlayerHand player={self} canInteract={() => canInteract(self)} highlight={() => isContextTarget(self)} targetCue={targetCue(self)} selectionKind={selectionKind} selectedCards={power?.targets} pendingCardId={pendingCardId} arrivingSlots={flightSlots(tableCue, self.id)} feedback={stackFeedback} reveal={revealVisible} onCard={(card) => actionCard(card, self)} active={isTurn} /><span className="you-label">YOU &middot; {self.cards.length ? `${self.cards.length}/${MAX_HAND_CARDS} CARDS` : 'OUT'}</span></section>
      <div className="game-actions">{canCallCambrio && <button className="cambio-button" onClick={() => { vibrate(24); void send({ type: 'CALL_CAMBIO' }); }}><GameGlyph kind="cambio" />Call Cambrio</button>}</div>
      <AnimatePresence>{stackFeedback && stackFeedback.kind !== 'trying' && <motion.div className={`stack-result ${stackFeedback.kind}`} initial={{ opacity: 0, scale: .8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, y: -8 }}>{stackFeedback.kind === 'correct' ? 'MATCH — STACKED' : stackFeedback.kind === 'wrong' ? 'NO MATCH — PENALTY CARD' : stackFeedback.kind === 'locked' ? 'NO MATCH — WAIT FOR NEXT DISCARD' : 'STACK ALREADY TAKEN'}</motion.div>}</AnimatePresence>
      <AnimatePresence>{tableCue && <SwapFlightLayer key={`flight-${tableCue.id}`} cue={tableCue} />}</AnimatePresence>
      <AnimatePresence>{tableCue && tableCue.kind !== 'stack' && tableCue.kind !== 'draw' && <TableActionCue key={`cue-${tableCue.id}`} cue={tableCue} />}</AnimatePresence>
      {game.ending && <EndingAnnouncement key={`${game.ending.reason}-${game.ending.triggerPlayerId}`} game={game} />}
      <InteractionOverlay game={game} self={self} revealVisible={revealVisible} pending={powerPending || pendingGroups.includes('transfer')} send={performAction} />
    </motion.main>
  );
}

function InitialPeek({ game, self, send }: { game: GameView; self: PlayerView; send: (action: GameActionInput) => Promise<ActionAck> }) {
  const [holding, setHolding] = useState(false);
  const reduceMotion = useReducedMotion();
  const holdingRef = useRef(false);
  const startedRef = useRef(false);
  const startingRef = useRef(false);
  const releaseRequestedRef = useRef(false);
  const finish = useCallback(() => {
    holdingRef.current = false;
    setHolding(false);
    if (startingRef.current && !startedRef.current) {
      releaseRequestedRef.current = true;
      return;
    }
    if (!startedRef.current) return;
    startedRef.current = false;
    releaseRequestedRef.current = false;
    void send({ type: 'INITIAL_PEEK_END' });
  }, [send]);
  const begin = () => {
    if (game.paused || self.initialPeekComplete || startingRef.current || startedRef.current) return;
    vibrate(8);
    holdingRef.current = true;
    releaseRequestedRef.current = false;
    startingRef.current = true;
    setHolding(true);
    void send({ type: 'INITIAL_PEEK_START' }).then((result) => {
      startingRef.current = false;
      if (!result.ok) {
        holdingRef.current = false;
        setHolding(false);
        return;
      }
      startedRef.current = true;
      if (releaseRequestedRef.current) finish();
    });
  };
  const end = useCallback(() => {
    if (!holdingRef.current && !startingRef.current) return;
    finish();
  }, [finish]);
  useEffect(() => {
    const concealWhenHidden = () => { if (document.hidden) end(); };
    window.addEventListener('blur', end);
    document.addEventListener('visibilitychange', concealWhenHidden);
    return () => { window.removeEventListener('blur', end); document.removeEventListener('visibilitychange', concealWhenHidden); };
  }, [end]);
  return (
    <main className={`peek-screen ${holding ? 'holding' : ''} ${game.paused ? 'is-paused' : ''}`}>
      <motion.div className="peek-copy" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : .28 }}><p className="eyebrow">One look. Then remember.</p><h1>Your bottom two cards</h1><p>Hold below to see bottom left and bottom right. Their positions will never shift.</p></motion.div>
      <div className="peek-hand">{self.cards.map((card, index) => <motion.div className="hand-slot" data-peekable={card.slot >= 2 || undefined} key={card.id} style={{ gridColumn: card.slot % 2 + 1, gridRow: Math.floor(card.slot / 2) + 1 }} initial={reduceMotion ? false : { opacity: 0, y: -54, x: (index % 2 ? 1 : -1) * 12, rotate: (index % 2 ? 1 : -1) * 5 }} animate={{ opacity: 1, y: 0, x: 0, rotate: 0 }} transition={{ delay: reduceMotion ? 0 : .08 + index * .075, duration: reduceMotion ? 0 : .36, ease: [0.22, 1, 0.36, 1] }}><Card card={card} faceDown={!holding || card.slot < 2} positioned slot={card.slot} /></motion.div>)}</div>
      {game.paused ? <PauseBanner game={game} inline /> : self.initialPeekComplete ? <motion.div className="waiting-ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><span className="spinner" />Waiting for everyone…</motion.div> : <motion.button className="hold-button" onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onPointerLeave={end} animate={{ scale: holding ? .97 : 1, y: holding ? 2 : 0 }} transition={{ duration: reduceMotion ? 0 : .12 }}><GameGlyph kind="peek" />{holding ? 'Memorize bottom two' : 'Hold to peek'}</motion.button>}
      <motion.div className="ready-progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduceMotion ? 0 : .42 }}>{game.players.filter((player) => player.initialPeekComplete).length}/{game.players.length} ready</motion.div>
    </main>
  );
}

function InteractionOverlay({ game, self, revealVisible, pending, send }: { game: GameView; self: PlayerView; revealVisible: boolean; pending: boolean; send: (action: GameActionInput) => Promise<ActionAck> }) {
  if (game.paused) return null;
  if (game.transfer?.fromPlayerId === self.id) return <div className="interaction-prompt"><span className="ability-chip"><GameGlyph kind="gift" />STACK REWARD</span><ActionSequence labels={['Give a card']} selected={0} /></div>;
  const power = game.power;
  if (!power || game.activePlayerId !== self.id) return null;
  if (power.status === 'offered') return <div className="interaction-prompt activating-power"><span className="button-spinner" /><strong>Opening {powerName(power.kind)}</strong></div>;
  if (power.status === 'selecting') return <div className={`interaction-prompt ${pending ? 'is-pending' : ''}`}><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{powerName(power.kind)}</span><ActionSequence labels={powerStepLabels(power.kind, self.cards.length)} selected={power.targets.length} /><span className="sr-only">{powerTargetInstruction(power.kind, power.targets.length, self.cards.length)}</span><button className="text-button" aria-label="Skip ability" disabled={pending} onClick={() => void send({ type: 'POWER_DECLINE' })}>Skip</button></div>;
  const blackKing = power.kind === 'black_king';
  const choosing = blackKing && power.status === 'choosing';
  return <div className={`interaction-prompt power-prompt ${revealVisible ? 'is-revealing' : ''} ${pending ? 'is-pending' : ''}`}><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{blackKing ? 'BLACK KING' : powerName(power.kind)}</span>{!choosing ? <div className="reveal-status"><GameGlyph kind="peek" /><strong>Memorize {blackKing ? 'both cards' : 'this card'}</strong><span className="reveal-progress" /></div> : <div className="power-choice"><strong>Swap positions?</strong><button className="primary" aria-busy={pending} disabled={power.targets.length < 2 || pending} onClick={() => void send({ type: 'POWER_COMPLETE', swap: true })}>{pending ? <span className="button-spinner" /> : <GameGlyph kind="swap" />}Swap</button><button disabled={pending} onClick={() => void send({ type: 'POWER_COMPLETE', swap: false })}>Keep</button></div>}</div>;
}

function ActionSequence({ labels, selected }: { labels: string[]; selected: number }) {
  return <div className="action-sequence" aria-hidden="true">{labels.map((label, index) => <div className="sequence-part" key={label}>{index > 0 && <ArrowRight className="sequence-arrow" size={13} />}<span className={`sequence-step ${index < selected ? 'done' : index === selected ? 'current' : ''}`}><b>{index < selected ? <Check size={10} /> : index + 1}</b><small>{label}</small></span></div>)}</div>;
}

function Results({ room, game, sendRoom }: { room: RoomView; game: GameView; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const rows = game.results!.map((result) => ({ result, player: game.players.find((player) => player.id === result.playerId)! })).sort((a, b) => (a.result.score ?? 999) - (b.result.score ?? 999));
  const winnerNames = rows.filter((row) => row.result.winner).map((row) => row.player.name).join(' & ');
  const isHost = room.hostPlayerId === room.selfPlayerId;
  const reduceMotion = useReducedMotion();
  const winnerCount = rows.filter((row) => row.result.winner).length;
  const [returning, setReturning] = useState(false);
  const returnToLobby = async () => { if (returning) return; setReturning(true); try { await sendRoom({ type: 'ROOM_REMATCH' }); } finally { setReturning(false); } };
  return <motion.main className="results-page" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : .22 }}>
    <motion.header className="results-hero" initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : .32 }}>
      <span className="winner-mark" aria-hidden="true"><CambrioGlyph decorative /></span><p className="eyebrow">Round complete</p><h1>{winnerNames} {winnerCount > 1 ? 'win' : 'wins'}!</h1><p>Lowest score takes the table.</p>
    </motion.header>
    <section className="results-list glass" aria-label="Final scores">{rows.map(({ player, result }, index) => <motion.div key={player.id} className={`result-row ${result.winner ? 'winner' : ''}`} initial={reduceMotion ? false : { opacity: 0, y: 13 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : .16 + index * .065, duration: reduceMotion ? 0 : .28, ease: [0.22, 1, 0.36, 1] }}><span className="place">{result.forfeited ? '—' : index + 1}</span><div><strong>{player.name}{player.id === room.selfPlayerId ? ' (you)' : ''}</strong><div className="result-cards">{player.cards.map((card, cardIndex) => <motion.span className="result-card-wrap" key={card.id} initial={reduceMotion ? false : { opacity: 0, y: -9, rotate: cardIndex % 2 ? 2 : -2 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: reduceMotion ? 0 : .24 + index * .065 + cardIndex * .035, duration: reduceMotion ? 0 : .22 }}><Card card={card} mini /></motion.span>)}</div></div><strong className="score"><span className="sr-only">Score </span>{result.score ?? 'Forfeit'}</strong></motion.div>)}</section>
    {isHost ? <motion.button className={`primary deal ${returning ? 'is-pending' : ''}`} aria-busy={returning} disabled={returning} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : .3 + rows.length * .065 }} onClick={() => void returnToLobby()}>{returning && <span className="button-spinner" />}Return to lobby</motion.button> : <p className="waiting-host">Waiting for the host to return to the lobby…</p>}
  </motion.main>;
}

function EndingAnnouncement({ game }: { game: GameView }) {
  const reduceMotion = useReducedMotion();
  const ending = game.ending!;
  const trigger = game.players.find((player) => player.id === ending.triggerPlayerId);
  const called = ending.reason === 'cambio';
  return <motion.div className={`ending-announcement ${called ? 'called' : 'zero'}`} role="status" aria-live="assertive" initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: .94, y: 12 }} animate={reduceMotion ? { opacity: [1, 1, 0] } : { opacity: [0, 1, 1, 0], scale: [.94, 1.025, 1, 1], y: [12, 0, 0, -5] }} transition={{ duration: 1.65, times: reduceMotion ? [0, .82, 1] : [0, .14, .78, 1], ease: [0.22, 1, 0.36, 1] }}>
    <span className="ending-signal" aria-hidden="true"><CambrioGlyph decorative /></span>
    <div><span>{called ? 'CAMBRIO' : 'ZERO CARDS'}</span><strong>{trigger?.name ?? 'A player'} {called ? 'called it' : 'cleared their hand'}</strong><small>{called ? 'Final rotation begins' : 'Last turns are now in play'}</small></div>
  </motion.div>;
}

type StackFeedback = 'trying' | 'correct' | 'wrong' | 'locked' | 'closed';
type HandLocation = { zone: 'hand'; playerId: string; playerName: string; slot: number };
type TableLocation = HandLocation | { zone: 'discard' } | { zone: 'deck' } | { zone: 'drawn' };
type TableMovement = { cardId: string; from: TableLocation; to: TableLocation; face?: CardView; faceDirection?: 'reveal' | 'conceal' };
type TableCue = { id: number; kind: 'draw' | 'exchange' | 'replace' | 'transfer' | 'discard' | 'stack'; title: string; from: string; to: string; movements: TableMovement[]; coveredDiscard?: CardView };
type TableSnapshot = { locations: Map<string, TableLocation>; discardId?: string; discard?: CardView; drawn?: CardView; deckCount: number; turnStage?: GameView['turnStage']; powerKind?: PowerKind; stackOpen: boolean };

function snapshotTable(game: GameView): TableSnapshot {
  const locations = new Map<string, TableLocation>(game.players.flatMap((player) => player.cards.map((card) => [card.id, { zone: 'hand', playerId: player.id, playerName: player.name, slot: card.slot }] as const)));
  if (game.drawnCard) locations.set(game.drawnCard.id, { zone: 'drawn' });
  return {
    locations,
    discardId: game.discard?.id,
    discard: game.discard,
    drawn: game.drawnCard,
    deckCount: game.deckCount,
    turnStage: game.turnStage,
    powerKind: game.power?.kind,
    stackOpen: game.stackOpen,
  };
}

function locationLabel(location: TableLocation): string {
  if (location.zone === 'hand') return `${location.playerName} ${slotTag(location.slot)}`;
  if (location.zone === 'drawn') return 'Drawn card';
  return location.zone === 'deck' ? 'Deck' : 'Discard';
}

function sameLocation(first: TableLocation, second: TableLocation): boolean {
  if (first.zone !== second.zone) return false;
  return first.zone !== 'hand' || (second.zone === 'hand' && first.playerId === second.playerId && first.slot === second.slot);
}

function flightSlots(cue: TableCue | undefined, playerId: string): number[] {
  return cue?.movements.flatMap((movement) => movement.to.zone === 'hand' && movement.to.playerId === playerId ? [movement.to.slot] : []) ?? [];
}

type FlightGeometry = { cardId: string; from: DOMRect; to: DOMRect; fromLabel: string; toLabel: string; face?: CardView; faceDirection?: 'reveal' | 'conceal' };

function flightDuration(kind: TableCue['kind']): number {
  if (kind === 'draw') return .66;
  if (kind === 'discard' || kind === 'stack') return .82;
  if (kind === 'transfer') return .9;
  return 1.02;
}

function cueLifetime(kind: TableCue['kind']): number {
  if (kind === 'draw') return 760;
  if (kind === 'discard' || kind === 'stack') return 920;
  if (kind === 'transfer') return 1_020;
  return 1_380;
}

function SwapFlightLayer({ cue }: { cue: TableCue }) {
  const [flights, setFlights] = useState<FlightGeometry[]>([]);
  const reduceMotion = useReducedMotion();
  useLayoutEffect(() => {
    const measured = cue.movements.flatMap((movement) => {
      const from = locationRect(movement.from);
      const to = locationRect(movement.to);
      return from && to ? [{ cardId: movement.cardId, from, to, fromLabel: locationLabel(movement.from), toLabel: locationLabel(movement.to), face: movement.face, faceDirection: movement.faceDirection }] : [];
    });
    setFlights(measured);
  }, [cue]);
  if (!flights.length || reduceMotion) return null;
  const duration = flightDuration(cue.kind);
  return <motion.div className={`swap-flight-layer ${cue.kind}`} style={{ '--flight-duration': `${duration}s` } as CSSProperties} initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: .06 } }} aria-hidden="true">
    {flights.map((flight, index) => {
      const direction = index === 0 ? -1 : 1;
      const deltaX = flight.to.left - flight.from.left;
      const deltaY = flight.to.top - flight.from.top;
      const middleX = deltaX / 2 + direction * (cue.kind === 'draw' ? 5 : 16);
      const middleY = deltaY / 2 + direction * (cue.kind === 'draw' ? 18 : 30);
      const destinationScaleX = flight.to.width / flight.from.width;
      const destinationScaleY = flight.to.height / flight.from.height;
      return <motion.span key={flight.cardId} className={`card-flight flight-${index + 1} ${flight.faceDirection ? `face-${flight.faceDirection}` : ''}`} data-flight-card={flight.cardId}
        data-flight-from={flight.fromLabel} data-flight-to={flight.toLabel}
        data-flight-distance={Math.round(Math.hypot(flight.to.left - flight.from.left, flight.to.top - flight.from.top))}
        style={{ left: flight.from.left, top: flight.from.top, width: flight.from.width, height: flight.from.height, transformOrigin: 'top left' }}
        initial={{ x: 0, y: 0, rotate: index === 0 ? -2 : 2, scaleX: 1, scaleY: 1, opacity: 1 }}
        animate={{ x: [0, middleX, deltaX, deltaX], y: [0, middleY, deltaY, deltaY], rotate: index === 0 ? [-2, -7, 0, 0] : [2, 7, 0, 0], scaleX: [1, Math.sqrt(destinationScaleX), destinationScaleX, destinationScaleX], scaleY: [1, Math.sqrt(destinationScaleY), destinationScaleY, destinationScaleY], opacity: [1, 1, 1, 0] }}
        transition={{ duration, times: [0, .48, .9, 1], ease: [0.22, 1, 0.36, 1] }}><span className="flight-surface flight-back"><CardBackMark /></span>{flight.face?.rank && flight.face.suit && <span className={`flight-surface flight-front ${flight.face.suit === 'hearts' || flight.face.suit === 'diamonds' ? 'red' : ''}`}><strong>{flight.face.rank}</strong><SuitMark suit={flight.face.suit} /></span>}{flights.length > 1 && <b>{index + 1}</b>}</motion.span>;
    })}
  </motion.div>;
}

function locationRect(location: TableLocation): DOMRect | undefined {
  if (location.zone === 'discard') return document.querySelector<HTMLElement>('[data-table-zone="discard"] .playing-card')?.getBoundingClientRect();
  if (location.zone === 'deck') return document.querySelector<HTMLElement>('[data-table-zone="deck"]')?.getBoundingClientRect();
  if (location.zone === 'drawn') return document.querySelector<HTMLElement>('[data-table-zone="drawn-card"] .playing-card')?.getBoundingClientRect() ?? document.querySelector<HTMLElement>('[data-table-zone="drawn"]')?.getBoundingClientRect();
  return document.querySelector<HTMLElement>(`.hand-slot[data-player-id="${location.playerId}"][data-slot="${location.slot}"]`)?.getBoundingClientRect();
}

function TableActionCue({ cue }: { cue: TableCue }) {
  return <motion.div className={`table-action-cue ${cue.kind}`} role="status" aria-live="polite" initial={{ opacity: 0, y: 10, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, transition: { duration: .12 } }} transition={{ delay: .42, duration: .18 }}>
    {cue.kind === 'discard' ? <span className="cue-icon" aria-hidden="true"><GameGlyph kind="discard" /></span> : <span className="cue-cards" aria-hidden="true"><i /><i /></span>}
    <span><strong>{cue.title}</strong><small>{cue.from} <b>{cue.kind === 'exchange' ? '↔' : '→'}</b> {cue.to}</small></span>
  </motion.div>;
}

type CardTargetCue = 'step-1' | 'step-2' | 'swap' | 'give';

function PlayerHand({ player, compact = false, canInteract, highlight, targetCue, selectionKind, selectedCards = [], pendingCardId, arrivingSlots = [], feedback, reveal = false, active = false, onCard }: { player: PlayerView; compact?: boolean; canInteract?: (card: CardView) => boolean; highlight?: (card: CardView) => boolean; targetCue?: CardTargetCue; selectionKind?: 'peek' | 'swap'; selectedCards?: string[]; pendingCardId?: string; arrivingSlots?: number[]; feedback?: { cardId: string; kind: StackFeedback }; reveal?: boolean; active?: boolean; onCard: (card: CardView) => void }) {
  const highestSlot = player.cards.reduce((highest, card) => Math.max(highest, card.slot), 3);
  const slotCount = Math.max(4, highestSlot + 1);
  const cardsBySlot = new Map(player.cards.map((card) => [card.slot, card]));
  return <div className={`player-hand ${compact ? 'compact' : ''} ${active ? 'active-turn' : ''}`}>
    <div className="seat-name"><span>{player.name}</span>{!player.connected && <i>OFFLINE</i>}</div>
    <div className="hand-cards" aria-label={`${player.name}'s cards`}>
      {Array.from({ length: slotCount }, (_, slot) => {
        const card = cardsBySlot.get(slot);
        const selectionIndex = card ? selectedCards.indexOf(card.id) : -1;
        return <div className={`hand-slot ${card ? '' : 'vacant'} ${arrivingSlots.includes(slot) ? 'flight-receiving' : ''}`} key={slot} data-player-id={player.id} data-slot={slot} data-position={slotTag(slot)}>{card ? <Card card={card} faceDown={!reveal} positioned slot={slot} targetOption={highlight?.(card)} targetCue={targetCue} selectionKind={selectionKind} selectionOrder={selectionIndex >= 0 ? selectionIndex + 1 : undefined} pending={pendingCardId === card.id} feedback={feedback?.cardId === card.id ? feedback.kind : undefined} interactive={canInteract?.(card)} onClick={() => onCard(card)} /> : <span className="vacant-marker" aria-hidden="true" />}</div>;
      })}
      {player.cards.length === 0 && <div className="out-badge">OUT</div>}
    </div>
  </div>;
}

export function Card({ card, faceDown = false, interactive = false, mini = false, positioned = false, targetOption = false, targetCue, selectionKind, selectionOrder, pending = false, feedback, slot, label, onClick }: { card?: CardView; faceDown?: boolean; interactive?: boolean; mini?: boolean; positioned?: boolean; targetOption?: boolean; targetCue?: CardTargetCue; selectionKind?: 'peek' | 'swap'; selectionOrder?: number; pending?: boolean; feedback?: StackFeedback; slot?: number; label?: string; onClick?: () => void }) {
  const hidden = faceDown || !card?.rank;
  const red = card?.suit === 'hearts' || card?.suit === 'diamonds';
  const actualSlot = slot ?? card?.slot;
  const actionDescription = selectionOrder ? `; selected ${selectionKind === 'peek' ? 'to peek' : selectionOrder === 1 ? 'source' : 'destination'}` : targetCue ? `; ${targetCue === 'step-1' ? 'first target' : targetCue === 'step-2' ? 'second target' : targetCue === 'give' ? 'tap to give' : 'tap to swap'}` : interactive ? '; tap to select' : '';
  const description = !card ? 'Empty discard pile' : hidden ? `${actualSlot === undefined || actualSlot < 0 ? 'Hidden' : slotName(actualSlot)} card${actionDescription}` : `${card.rank} of ${card.suit}${actionDescription}`;
  return <motion.button data-card-id={card?.id} data-slot={actualSlot} initial={{ opacity: 0, y: hidden ? -8 : 0, scale: .96 }} title={description} aria-label={description} aria-busy={pending} className={`playing-card ${hidden ? 'face-down' : ''} ${red ? 'red' : ''} ${interactive ? 'interactive' : ''} ${targetOption ? 'target-option' : ''} ${mini ? 'mini' : ''} ${positioned ? 'positioned' : ''} ${selectionOrder ? 'selected' : ''} ${pending ? 'action-pending' : ''} ${feedback ? `stack-${feedback}` : ''} ${!card ? 'empty' : ''}`} disabled={!interactive || pending} onClick={onClick} animate={feedback === 'wrong' ? { opacity: 1, y: 0, x: [0, -7, 7, -5, 5, 0], rotate: [0, -1.4, 1.4, -.8, .8, 0] } : feedback === 'correct' ? { opacity: 1, y: 0, scale: [1, 1.08, 1] } : { opacity: 1, y: 0, scale: 1 }} transition={feedback ? { duration: .38, ease: 'easeOut' } : { opacity: { duration: .16 }, transform: { duration: .18, ease: [0.22, 1, 0.36, 1] } }} whileTap={interactive ? { scale: .96 } : undefined}>
    <AnimatePresence initial={false} mode="popLayout">
      {hidden ? <motion.span key="back" className="card-surface card-reverse" initial={{ opacity: 0, rotateY: -88 }} animate={{ opacity: 1, rotateY: 0 }} exit={{ opacity: 0, rotateY: 88 }} transition={{ duration: .22, ease: [0.22, 1, 0.36, 1] }}><CardBackMark /></motion.span> : <motion.span key="front" className="card-surface card-front" initial={{ opacity: 0, rotateY: 88 }} animate={{ opacity: 1, rotateY: 0 }} exit={{ opacity: 0, rotateY: -88 }} transition={{ duration: .22, ease: [0.22, 1, 0.36, 1] }}><span className="corner" data-rank={card!.rank}><b>{card!.rank}</b><SuitMark suit={card!.suit!} /></span><SuitMark suit={card!.suit!} className="center-suit" /></motion.span>}
    </AnimatePresence>
    {positioned && actualSlot !== undefined && <span className="slot-tag">{slotTag(actualSlot)}</span>}
    {targetOption && targetCue && !selectionOrder && <span className={`target-cue ${targetCue}`} aria-hidden="true">{targetCue === 'step-1' ? '1' : targetCue === 'step-2' ? '2' : <GameGlyph kind={targetCue === 'give' ? 'gift' : 'swap'} />}</span>}
    {selectionOrder && <motion.span className="selection-order" aria-hidden="true" initial={{ scale: .5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>{selectionOrder}<small>{selectionKind === 'peek' ? 'PEEK' : selectionOrder === 1 ? 'FROM' : 'TO'}</small></motion.span>}
    {pending && <span className="card-pending" aria-hidden="true" />}
    {label && <em>{label}</em>}
  </motion.button>;
}

function TurnBanner({ game, self }: { game: GameView; self: PlayerView }) {
  const active = game.players.find((player) => player.id === game.activePlayerId);
  const endingPlayer = game.ending ? game.players.find((player) => player.id === game.ending!.triggerPlayerId) : undefined;
  if (game.paused) {
    const disconnected = game.players.filter((player) => game.paused!.playerIds.includes(player.id));
    return <div className="turn-banner paused"><strong>{disconnected.length === 1 ? `${disconnected[0].name} disconnected` : `${disconnected.length} players disconnected`}</strong><span>Game paused · seat saved</span></div>;
  }
  if (game.transfer) return <div className="turn-banner"><strong>Card transfer</strong><span>Finish the successful stack</span></div>;
  return <div className={`turn-banner ${active?.id === self.id ? 'your-turn' : ''} ${game.ending ? 'ending-turn' : ''}`}>{game.ending && <span className="ending-state" role="status" aria-live="assertive"><CambrioGlyph decorative compact /><b>{game.ending.reason === 'cambio' ? 'CAMBRIO CALLED' : 'ZERO CARDS'}</b></span>}<strong>{active?.id === self.id ? 'Your turn' : `${active?.name ?? 'Player'}'s turn`}</strong><span>{game.ending ? `${endingPlayer?.name ?? 'Player'} · ${game.ending.turnsRemaining === 0 ? 'final turn' : `${game.ending.turnsRemaining} ${game.ending.turnsRemaining === 1 ? 'turn' : 'turns'} after this one`}` : game.turnStage === 'awaiting_draw' ? 'Draw from the deck' : game.turnStage === 'deciding' ? 'Discard or swap' : 'Resolving a power'}</span></div>;
}

function Countdown({ deadline, pausedMs }: { deadline?: number; pausedMs?: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const update = () => setSeconds(Math.max(0, Math.ceil(((deadline ?? Date.now()) - Date.now()) / 1000))); update(); const timer = window.setInterval(update, 250); return () => clearInterval(timer); }, [deadline]);
  if (pausedMs !== undefined) return <span className="countdown paused" title={`Paused with ${Math.ceil(pausedMs / 1000)} seconds remaining`} aria-label="Timer paused"><i /><i /></span>;
  return <span className={`countdown ${seconds <= 10 ? 'urgent' : ''}`}>{seconds}s</span>;
}

function PauseBanner({ game, inline = false }: { game: GameView; inline?: boolean }) {
  const names = game.players.filter((player) => game.paused?.playerIds.includes(player.id)).map((player) => player.name);
  const label = names.length === 1 ? names[0] : `${names.length} players`;
  return <motion.div className={`pause-banner ${inline ? 'inline' : ''}`} role="status" aria-live="polite" initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }}><span className="pause-symbol" aria-hidden="true"><i /><i /></span><div><strong>Game paused</strong><small>Waiting for {label} to reconnect</small></div></motion.div>;
}

function AccountPanel({ session, close, force = false, onSaved, onLeave }: { session: ClientSession; close: () => void; force?: boolean; onSaved?: () => void; onLeave?: () => void }) {
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('cambrio:name') ?? '');
  const [message, setMessage] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const permanent = !session.anonymous;
  useEffect(() => {
    if (force) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [close, force]);
  const authHeaders = { 'Content-Type': 'application/json', ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), 'x-visitor-id': session.visitorId };
  const google = async () => { const supabase = await getSupabase(); if (!supabase) return setMessage('Connect Supabase to enable accounts.'); const { error } = session.anonymous ? await supabase.auth.linkIdentity({ provider: 'google', options: { redirectTo: window.location.href } }) : await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } }); if (error) setMessage(error.message); };
  const emailLink = async () => { const supabase = await getSupabase(); if (!supabase) return setMessage('Connect Supabase to enable accounts.'); const { error } = session.anonymous ? await supabase.auth.updateUser({ email }) : await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } }); setMessage(error ? error.message : 'Check your email to finish linking your account.'); };
  const saveProfile = async () => { const response = await fetch('/api/me/profile', { method: 'PUT', headers: authHeaders, body: JSON.stringify({ handle, displayName }) }); const body = await response.json(); setMessage(response.ok ? 'Profile saved.' : body.error); if (response.ok) onSaved?.(); };
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => !force && close()}><motion.section className="account-panel glass" role="dialog" aria-modal="true" aria-labelledby="account-title" initial={{ y: 18 }} animate={{ y: 0 }} onMouseDown={(event) => event.stopPropagation()}>{!force && <button className="modal-close" aria-label="Close player panel" onClick={close}>×</button>}<p className="eyebrow">Player identity</p><h2 id="account-title">{permanent ? force ? 'Choose your player handle' : 'Your Cambrio profile' : 'Save your wins'}</h2>{!permanent ? <><p>Keep playing as a guest, or link this guest to an account. Wins already earned on this browser will come with you.</p><button className="google-button" onClick={() => void google()}>Continue with Google</button><div className="or"><span>or use email</span></div><div className="email-row"><input name="email" autoComplete="email" value={email} type="email" placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /><button onClick={() => void emailLink()}>Send link</button></div></> : <><p>Your unique handle creates your shareable public profile.</p><label>Public handle<input name="handle" autoComplete="username" value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} placeholder="card_shark" /></label><label>Display name<input name="displayName" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><button className="primary wide" disabled={handle.length < 3 || displayName.trim().length < 2} onClick={() => void saveProfile()}>Save public profile</button></>}{message && <p className="panel-message">{message}</p>}{onLeave && !force && <div className={`leave-table ${confirmLeave ? 'confirming' : ''}`}>{confirmLeave ? <><span><strong>Leave this table?</strong><small>You can rejoin later with the room link.</small></span><button onClick={() => setConfirmLeave(false)}>Stay</button><button className="danger" onClick={() => { close(); onLeave(); }}>Leave</button></> : <button className="leave-table-button" onClick={() => setConfirmLeave(true)}>Leave table</button>}</div>}</motion.section></motion.div>;
}

function PublicProfile({ handle, onHome }: { handle: string; onHome: () => void }) {
  const [profile, setProfile] = useState<{ displayName?: string; handle: string; games: number; wins: number; winRate: number }>();
  const [missing, setMissing] = useState(false);
  useEffect(() => { void fetch(`/api/profiles/${handle}`).then(async (response) => { if (!response.ok) setMissing(true); else setProfile(await response.json()); }); }, [handle]);
  return <main className="profile-page"><button className="back-link" onClick={onHome}>← Cambrio</button>{missing ? <div><h1>Player not found</h1><p>This profile may be private or unavailable.</p></div> : !profile ? <LoadingScreen /> : <section className="glass public-profile"><div className="profile-monogram">{(profile.displayName ?? profile.handle).slice(0, 2).toUpperCase()}</div><p className="eyebrow">Cambrio player</p><h1>{profile.displayName ?? profile.handle}</h1><p>@{profile.handle}</p><div className="stats-grid"><div><strong>{profile.wins}</strong><span>Wins</span></div><div><strong>{profile.games}</strong><span>Games</span></div><div><strong>{profile.winRate}%</strong><span>Win rate</span></div></div></section>}</main>;
}

function Toast({ notice }: { notice: ServerNotice }) { return <motion.div className={`toast ${notice.kind}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}><span>{notice.kind === 'penalty' ? '!' : notice.kind === 'stack' ? '✓' : '•'}</span>{notice.message}</motion.div>; }
function isInlineNotice(notice: ServerNotice): boolean {
  return notice.message === 'The cards are dealt. Hold your two bottom cards to peek.'
    || notice.message === 'Back in the lobby. Ready up for another round.'
    || notice.kind === 'cambio'
    || /^(Blind swap|Black King) · /.test(notice.message)
    || / swapped the draw into /.test(notice.message)
    || / gave a hidden card to /.test(notice.message);
}
function LoadingScreen({ label = 'Preparing the table…' }: { label?: string }) { return <main className="loading-screen"><div className="loader-cards"><i /><i /><i /></div><p>{label}</p></main>; }
function FatalScreen({ message }: { message: string }) { return <main className="loading-screen"><div className="fatal-mark">!</div><h1>Couldn’t reach the table</h1><p>{message}</p><button onClick={() => window.location.reload()}>Try again</button></main>; }

type GameGlyphKind = 'cambio' | 'discard' | 'gift' | 'peek' | 'stack' | 'swap';

export function CambrioGlyph({ decorative = false, compact = false }: { decorative?: boolean; compact?: boolean }) {
  return <svg className={compact ? 'game-glyph' : 'cambrio-glyph'} viewBox="0 0 24 24" fill="none" role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : 'Cambrio card'}>
    <rect x="4" y="6" width="9" height="12" rx="2" />
    <rect x="11" y="3" width="9" height="12" rx="2" />
    <path d="m6.5 10 2-2 2 2M17.5 11l-2 2-2-2" />
  </svg>;
}

function CardBackMark() {
  return <span className="card-back-mark" aria-hidden="true"><CambrioGlyph decorative /></span>;
}

function GameGlyph({ kind }: { kind: GameGlyphKind }) {
  if (kind === 'cambio') return <CambrioGlyph decorative compact />;
  return <svg className="game-glyph" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    {kind === 'peek' && <><path d="M3.5 12s3.1-5 8.5-5 8.5 5 8.5 5-3.1 5-8.5 5-8.5-5-8.5-5Z" /><circle cx="12" cy="12" r="2.4" /></>}
    {kind === 'swap' && <><path d="M5 8h11" /><path d="m13 5 3 3-3 3" /><path d="M19 16H8" /><path d="m11 13-3 3 3 3" /></>}
    {kind === 'stack' && <><rect x="4" y="6" width="10" height="13" rx="2" /><rect x="10" y="3" width="10" height="13" rx="2" /><path d="M12.5 9.5h5M15 7v5" /></>}
    {kind === 'discard' && <><rect x="4" y="3" width="10" height="14" rx="2" /><path d="M17 8v11M13.5 15.5 17 19l3.5-3.5" /></>}
    {kind === 'gift' && <><rect x="3" y="5" width="9" height="13" rx="2" /><path d="M10 11h10M17 8l3 3-3 3" /></>}
  </svg>;
}

function gameActionGroup(type: GameActionInput['type']): string {
  if (type === 'DISCARD_DRAWN' || type === 'SWAP_DRAWN') return 'turn-decision';
  if (type.startsWith('POWER_')) return 'power';
  if (type === 'TRANSFER_CARD') return 'transfer';
  if (type === 'STACK_ATTEMPT') return 'stack';
  return type;
}

function vibrate(pattern: number | number[]): void {
  if ('vibrate' in navigator) navigator.vibrate(pattern);
}

function emitAction(socket: ClientSocket | undefined, event: 'room:action' | 'game:action', payload: unknown): Promise<ActionAck> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ clientActionId: '', ok: false, message: 'Still reconnecting…' });
    socket.timeout(8_000).emit(event, payload, (error: Error | null, result: ActionAck) => resolve(error ? { clientActionId: '', ok: false, message: 'The server did not respond.' } : result));
  });
}

function roomCodeFromPath(): string | undefined { return window.location.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{8})$/i)?.[1]?.toUpperCase(); }
function SuitMark({ suit, className = '' }: { suit: NonNullable<CardView['suit']>; className?: string }) {
  return <svg className={`suit-mark ${className}`} viewBox="0 0 24 24" aria-hidden="true">
    {suit === 'hearts' && <path d="M12 21.2 10.5 19.8C5.4 15.2 2 12.1 2 8.3 2 5.2 4.4 2.8 7.5 2.8c1.8 0 3.5.8 4.5 2.1 1-1.3 2.7-2.1 4.5-2.1 3.1 0 5.5 2.4 5.5 5.5 0 3.8-3.4 6.9-8.5 11.5L12 21.2Z" />}
    {suit === 'diamonds' && <path d="M12 1.7 20.5 12 12 22.3 3.5 12 12 1.7Z" />}
    {suit === 'clubs' && <><circle cx="12" cy="7" r="4.6" /><circle cx="7.2" cy="13" r="4.6" /><circle cx="16.8" cy="13" r="4.6" /><path d="M10.2 14.4c.2 3.3-.8 5.6-3.1 7.8h9.8c-2.3-2.2-3.3-4.5-3.1-7.8h-3.6Z" /></>}
    {suit === 'spades' && <path d="M12 1.7C10 5.1 3.7 9 3.7 14.2c0 3 2.2 5.3 5.1 5.3 1.1 0 2.1-.4 2.9-1.1-.3 1.6-1.1 2.7-2.5 3.9h5.6c-1.4-1.2-2.2-2.3-2.5-3.9.8.7 1.8 1.1 2.9 1.1 2.9 0 5.1-2.3 5.1-5.3C20.3 9 14 5.1 12 1.7Z" />}
  </svg>;
}
function slotName(slot: number): string { return slot === 0 ? 'top left' : slot === 1 ? 'top right' : slot === 2 ? 'bottom left' : slot === 3 ? 'bottom right' : `extra slot ${slot - 3}`; }
function slotTag(slot: number): string { return slot === 0 ? 'TL' : slot === 1 ? 'TR' : slot === 2 ? 'BL' : slot === 3 ? 'BR' : `+${slot - 3}`; }
function isEligiblePowerTarget(power: PowerKind, selected: number, ownerId: string, selfId: string, ownCount: number): boolean {
  if (power === 'own_peek') return ownerId === selfId;
  if (power === 'opponent_peek' || (power === 'black_king' && ownCount === 0)) return ownerId !== selfId;
  return selected === 0 ? ownerId === selfId : ownerId !== selfId;
}
function powerName(power: PowerKind): string { return power === 'own_peek' ? 'Private peek' : power === 'opponent_peek' ? 'Read an opponent' : power === 'blind_swap' ? 'Blind swap' : 'Black King'; }
function powerGlyph(power: PowerKind): GameGlyphKind { return power === 'blind_swap' || power === 'black_king' ? 'swap' : 'peek'; }
function powerStepLabels(power: PowerKind, ownCount: number): string[] {
  if (power === 'own_peek') return ['Your card'];
  if (power === 'opponent_peek' || (power === 'black_king' && ownCount === 0)) return ['Their card'];
  return ['Your card', 'Their card'];
}
function powerTargetInstruction(power: PowerKind, selected: number, ownCount: number): string { if (power === 'own_peek') return 'Choose one of your cards'; if (power === 'opponent_peek' || (power === 'black_king' && ownCount === 0)) return "Choose an opponent's card"; if (selected === 0) return 'Choose one of your cards'; return "Now choose an opponent's card"; }
