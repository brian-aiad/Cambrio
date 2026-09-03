import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, CircleHelp, Copy, Link2, UserRound, Volume2, VolumeX, Waves, X } from 'lucide-react';
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
  const turnAudioRef = useRef(audio.playTurn);
  const pendingRoomActions = useRef(new Set<string>());
  const pendingGameActions = useRef(new Set<string>());
  const noticePhase = useRef('home');
  const currentNoticePhase = room ? `${room.phase}:${room.game?.phase ?? 'none'}` : 'home';
  useEffect(() => { audioRef.current = audio.playNotice; turnAudioRef.current = audio.playTurn; }, [audio.playNotice, audio.playTurn]);

  useEffect(() => {
    let active = true;
    void ensureClientSession().then((value) => active && setSession(value)).catch(() => setFatal(friendlyConnectionMessage()));
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
      if (!next.active) setFatal(friendlyConnectionMessage(error));
    });
    next.on('room:state', (state: RoomView) => {
      const previous = roomRef.current;
      const previousOwnsTurn = Boolean(previous?.game && (previous.game.phase === 'playing' || previous.game.phase === 'ending') && previous.game.activePlayerId === previous.selfPlayerId);
      const nowOwnsTurn = Boolean(state.game && (state.game.phase === 'playing' || state.game.phase === 'ending') && state.game.activePlayerId === state.selfPlayerId);
      if (nowOwnsTurn && !previousOwnsTurn) {
        turnAudioRef.current();
        vibrate([12, 36, 12]);
      }
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
    if (!session.token) {
      setProfileReady(true);
      return;
    }
    let active = true;
    const headers = new Headers(session.token ? { Authorization: `Bearer ${session.token}` } : { 'x-visitor-id': session.visitorId });
    void fetch('/api/me', { headers })
      .then(async (response) => {
        if (!response.ok) throw new Error('Profile service unavailable.');
        return response.json() as Promise<{ handle?: string }>;
      })
      .then((value) => { if (active) setProfileReady(Boolean(value.handle)); })
      // Optional account infrastructure must never trap a valid player behind
      // a non-dismissible setup dialog.
      .catch(() => { if (active) setProfileReady(true); });
    return () => { active = false; };
  }, [session]);

  const showActionError = useCallback((result: ActionAck) => {
    if (!result.ok) {
      const value: ServerNotice = { kind: 'error', message: friendlyActionMessage(result) };
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
      const result = await emitAction(socket, 'room:action', { ...input, clientActionId: nanoid() });
      return input.type === 'ROOM_CREATE' || input.type === 'ROOM_JOIN' ? result : showActionError(result);
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
        <div className="queue-position" aria-hidden="true"><span>{position}</span><small>next</small></div>
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
  const [rulesOpen, setRulesOpen] = useState(false);
  const helpButton = useRef<HTMLButtonElement>(null);
  const closeAccount = useCallback(() => setOpen(false), []);
  const closeRules = useCallback(() => {
    setRulesOpen(false);
    window.requestAnimationFrame(() => helpButton.current?.focus());
  }, []);
  return (
    <header className={`topbar ${compact ? 'game-topbar' : ''}`}>
      <a className="brand" href="/" title="Cambrio home"><span className="brand-mark" aria-hidden="true"><CambrioGlyph decorative /></span><span className="brand-word">cambrio</span></a>
      <div className="top-actions">
        <span className={`connection ${connected ? 'online' : 'reconnecting'}`} role="status" aria-live="polite" title={connected ? 'Connected to the table' : 'Reconnecting to the table'}><i />{connected ? 'Live' : 'Reconnecting'}</span>
        <button className="icon-button" onClick={audio.toggleEffects} aria-label="Toggle sound effects">{audio.settings.effects ? <Volume2 size={17} /> : <VolumeX size={17} />}</button>
        <button className={`icon-button ${audio.settings.ambience ? 'active' : ''}`} onClick={audio.toggleAmbience} aria-label="Toggle ambience"><Waves size={17} /></button>
        <button ref={helpButton} className="icon-button help-button" onClick={() => { setOpen(false); setRulesOpen(true); }} aria-label="How to play Cambrio" aria-haspopup="dialog" aria-expanded={rulesOpen}><CircleHelp size={18} /></button>
        <button className="profile-chip" aria-haspopup="dialog" aria-expanded={open || forceProfile} onClick={() => { setRulesOpen(false); setOpen(true); }}><UserRound size={15} /><span>{session.anonymous ? 'Guest' : session.session?.user.email?.split('@')[0] ?? 'Profile'}</span></button>
      </div>
      <AnimatePresence>{(open || forceProfile) && <AccountPanel session={session} audio={audio} close={closeAccount} force={forceProfile} onSaved={onProfileSaved} onLeave={onLeave} />}</AnimatePresence>
      <AnimatePresence>{rulesOpen && !forceProfile && <RulesPanel close={closeRules} />}</AnimatePresence>
    </header>
  );
}

function RulesPanel({ close }: { close: () => void }) {
  const reduceMotion = useReducedMotion();
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(true, close, closeButton);
  return <motion.div ref={dialogRef} className="modal-backdrop rules-backdrop" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onPointerDown={close}>
    <motion.section className="rules-panel glass" role="dialog" aria-modal="true" aria-labelledby="rules-title" aria-describedby="rules-summary" initial={reduceMotion ? false : { opacity: 0, y: 18, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 10, scale: .99 }} transition={{ duration: reduceMotion ? 0 : .2, ease: [0.22, 1, 0.36, 1] }} onPointerDown={(event) => event.stopPropagation()}>
      <button ref={closeButton} className="modal-close" aria-label="Close how to play" onClick={close}><X size={18} /></button>
      <header className="rules-heading"><span className="rules-mark" aria-hidden="true"><CambrioGlyph decorative /></span><div><p className="eyebrow">How to play</p><h2 id="rules-title">Remember. Trade. Stack.</h2><p id="rules-summary">Keep the lowest hidden total. Card positions never shift, so memory is your advantage.</p></div></header>
      <div className="rules-flow" aria-label="Round flow">
        <article><b>1</b><span><GameGlyph kind="peek" /><strong>Remember</strong></span><p>Hold to peek at your bottom-left and bottom-right cards once.</p></article>
        <article><b>2</b><span><GameGlyph kind="swap" /><strong>Take a turn</strong></span><p>Draw privately, then discard it or replace one of your hidden cards.</p></article>
        <article><b>3</b><span><GameGlyph kind="stack" /><strong>Race to stack</strong></span><p>After a discard, anyone may tap a remembered card with the same rank.</p></article>
      </div>
      <div className="rules-details">
        <section><p className="eyebrow">Stacking</p><h3>Fast, public, and risky</h3><p>The first correct tap wins the race. A wrong rank stays put and gives you a hidden penalty card. If you stack another player’s card, give them one of yours.</p><div className="rule-example"><span className="example-card">8</span><b>=</b><span className="example-card face-down"><CambrioGlyph decorative /></span><small>Match rank, not suit</small></div></section>
        <section><p className="eyebrow">Power cards</p><h3>Discard to activate</h3><div className="power-list"><span><b>7–8</b> Peek at one of yours</span><span><b>9–10</b> Peek at an opponent</span><span><b>J–Q</b> Blind-swap two cards</span><span><b>Black K</b> Peek, then choose to swap</span></div><p className="power-note">Replacing or stacking a power card does not activate it.</p></section>
      </div>
      <footer className="rules-finish"><span className="rules-finish-mark"><GameGlyph kind="cambio" /></span><div><strong>Call Cambrio when you’re ready</strong><p>The table completes the final rotation, then reveals every hand. Lowest score wins; red Kings are −1.</p></div><div className="value-strip" aria-label="Card values"><span>A<b>1</b></span><span>2–10<b>Face value</b></span><span>J · Q · black K<b>10</b></span><span>red K<b>−1</b></span></div></footer>
    </motion.section>
  </motion.div>;
}

type EntryIntent = { mode: 'create' | 'join'; name: string; code?: string };

function Landing({ connected, send, initialCode }: { connected: boolean; send: (action: RoomActionInput) => Promise<ActionAck>; initialCode?: string }) {
  const [name, setName] = useState(readStoredName);
  const [code, setCode] = useState(initialCode ?? '');
  const [busy, setBusy] = useState<'create' | 'join'>();
  const [queuedIntent, setQueuedIntent] = useState<EntryIntent>();
  const [error, setError] = useState('');
  const missingInvite = Boolean(initialCode && /does not exist|expired/i.test(error));
  const nameReady = name.trim().length >= 2;
  const autoJoinAttempted = useRef(false);
  const autoJoinEligible = useRef(nameReady);
  const buildIntent = useCallback((mode: 'create' | 'join'): EntryIntent => ({
    mode,
    name: name.trim(),
    ...(mode === 'join' ? { code: (initialCode ?? code).toUpperCase() } : {}),
  }), [code, initialCode, name]);
  const submit = useCallback(async (intent: EntryIntent) => {
    setBusy(intent.mode); setError('');
    rememberName(intent.name);
    const result = await send(intent.mode === 'create'
      ? { type: 'ROOM_CREATE', name: intent.name }
      : { type: 'ROOM_JOIN', name: intent.name, code: intent.code ?? '' });
    if (!result.ok) setError(result.message ?? 'Unable to continue.');
    setBusy(undefined);
  }, [send]);
  const requestSubmit = useCallback((mode: 'create' | 'join') => {
    if (busy || queuedIntent || !nameReady) return;
    const intent = buildIntent(mode);
    // A deliberate invite submission owns this attempt. Without this marker,
    // a rejected manual join was immediately repeated by the saved-name
    // auto-join effect as soon as its busy state cleared.
    if (mode === 'join' && initialCode) autoJoinAttempted.current = true;
    if (!connected) return setQueuedIntent(intent);
    void submit(intent);
  }, [buildIntent, busy, connected, initialCode, nameReady, queuedIntent, submit]);
  useEffect(() => {
    if (!connected || !queuedIntent || busy) return;
    const intent = queuedIntent;
    setQueuedIntent(undefined);
    void submit(intent);
  }, [busy, connected, queuedIntent, submit]);
  useEffect(() => {
    if (!autoJoinEligible.current || !connected || !initialCode || name.trim().length < 2 || busy || queuedIntent || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void submit(buildIntent('join'));
  }, [buildIntent, busy, connected, initialCode, name, queuedIntent, submit]);
  const pendingMode = busy ?? queuedIntent?.mode;
  return (
    <motion.main className="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="hero-copy">
        <p className="eyebrow">A private table for 2–8 friends</p>
        <h1>Know your cards.<br /><em>Trust your read.</em></h1>
        <p className="lede">Remember hidden positions, trade carefully, and race your friends to the discard. Lowest hand wins.</p>
        <a className="hero-cta primary" href="#join-table">Create or join a table <ArrowRight size={17} /></a>
        <div className="feature-row" aria-label="Game details"><span><b>2–8</b> players</span><span><Link2 size={13} /><b>Private</b> invite</span><span><b>Instant</b> guest play</span></div>
        <div className="hero-game-note"><GameGlyph kind="peek" /><div><strong>Position is memory.</strong><span>Your cards stay in TL, TR, BL, and BR—even when the hand changes.</span></div></div>
      </div>
      <form id="join-table" className="join-panel glass" aria-busy={Boolean(pendingMode)} onSubmit={(event) => { event.preventDefault(); requestSubmit(initialCode || code.length === 8 ? 'join' : 'create'); }}>
        {initialCode ? <div className="invite-heading"><span>Private invite</span><h2>Join this table</h2><strong aria-label={`Room code ${initialCode}`}>{initialCode}</strong></div> : <div className="entry-heading"><p className="eyebrow">Play now</p><h2>Take a seat</h2><p>Create a new table or enter a friend’s room code.</p></div>}
        <label>Your display name<input name="displayName" autoComplete="name" value={name} maxLength={20} disabled={Boolean(pendingMode)} aria-describedby={`display-name-hint${error ? ' entry-error' : ''}`} aria-invalid={Boolean(error)} onChange={(event) => { autoJoinEligible.current = false; setName(event.target.value); if (error) setError(''); }} onKeyDown={(event) => { if (event.key !== 'Enter') return; event.preventDefault(); requestSubmit(initialCode || code.length === 8 ? 'join' : 'create'); }} placeholder="What should friends call you?" /><span id="display-name-hint" className={`input-hint ${nameReady ? 'ready' : ''}`}>{nameReady ? <><Check size={12} />Ready as {name.trim()}</> : 'Use 2–20 characters so friends recognize you.'}</span></label>
        {initialCode ? (
          !missingInvite && <button type="submit" className="primary wide" aria-busy={pendingMode === 'join'} disabled={Boolean(pendingMode) || !nameReady}>{pendingMode === 'join' ? <><span className="button-spinner" />{connected ? 'Joining table…' : 'Connecting…'}</> : <>Join room <ArrowRight size={17} /></>}</button>
        ) : (
          <>
            <button type="button" className="primary wide" aria-busy={pendingMode === 'create'} disabled={Boolean(pendingMode) || !nameReady} onClick={() => requestSubmit('create')}>{pendingMode === 'create' ? <><span className="button-spinner" />{connected ? 'Opening table…' : 'Connecting…'}</> : <>Create private room <ArrowRight size={17} /></>}</button>
            <div className="or"><span>or join with a code</span></div>
            <div className="code-row"><input name="roomCode" aria-label="Room code" aria-describedby={error ? 'entry-error' : undefined} aria-invalid={Boolean(error)} className="code-input" value={code} disabled={Boolean(pendingMode)} onChange={(event) => { setCode(event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 8)); if (error) setError(''); }} placeholder="ABCD2345" /><button type="submit" aria-busy={pendingMode === 'join'} disabled={Boolean(pendingMode) || code.length !== 8 || !nameReady}>{pendingMode === 'join' ? <span className="button-spinner" /> : null}{pendingMode === 'join' ? connected ? 'Joining…' : 'Connecting…' : 'Join'}</button></div>
          </>
        )}
        {queuedIntent && <div className="queued-entry" role="status"><span>Waiting for a table connection. Your details are held for this request.</span><button type="button" onClick={() => setQueuedIntent(undefined)}>Cancel</button></div>}
        {missingInvite ? <div className="expired-invite" role="alert"><strong>This table is no longer active.</strong><span>Room {initialCode} may have expired. Ask the host for a fresh link, or open a new table now.</span><div><button type="button" className="secondary" onClick={() => window.location.assign('/')}>Back home</button><button type="button" className="primary" disabled={Boolean(pendingMode) || !nameReady} onClick={() => requestSubmit('create')}>{pendingMode === 'create' ? <span className="button-spinner" /> : null}{pendingMode === 'create' ? connected ? 'Opening…' : 'Connecting…' : 'Start new table'}</button></div></div> : error && <p id="entry-error" className="form-error" role="alert">{friendlyEntryMessage(error)}</p>}
        <small>No account required. Your room expires two hours after everyone leaves.</small>
      </form>
    </motion.main>
  );
}

function Lobby({ room, send }: { room: RoomView; send: (action: RoomActionInput) => Promise<ActionAck> }) {
  const self = room.players.find((player) => player.id === room.selfPlayerId);
  const isHost = self?.isHost;
  const shareUrl = `${window.location.origin}/room/${room.code}`;
  const allReady = room.players.length >= 2 && room.players.every((player) => player.isHost || (player.ready && player.connected));
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [pending, setPending] = useState<string>();
  const shareTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(shareTimer.current), []);
  const waitingOn = room.players.filter((player) => !player.isHost && (!player.ready || !player.connected));
  const startLabel = allReady ? 'Deal the cards' : room.players.length < 2 ? 'Invite one more player' : waitingOn.length === 1 ? `Waiting for ${waitingOn[0].name}` : `Waiting for ${waitingOn.length} players`;
  const copy = async () => {
    let resetAfter = 2_200;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareState('copied');
    } catch {
      setShareState('failed');
      resetAfter = 4_500;
    }
    window.clearTimeout(shareTimer.current);
    shareTimer.current = window.setTimeout(() => setShareState('idle'), resetAfter);
  };
  const act = async (key: string, action: RoomActionInput) => {
    if (pending) return;
    setPending(key);
    try { await send(action); } finally { setPending(undefined); }
  };
  return (
    <motion.main className="lobby page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <section className="lobby-heading"><div><p className="eyebrow">Private table</p><h1>Room <span>{room.code}</span></h1><p className="lobby-subtitle">{room.players.length < 2 ? 'Share the invite to fill the next seat.' : 'Ready up, then the host deals.'}</p></div><button className={`share-button ${shareState}`} aria-live="polite" onClick={() => void copy()}>{shareState === 'copied' ? <Check size={16} /> : <Copy size={16} />}{shareState === 'copied' ? 'Invite copied' : shareState === 'failed' ? 'Try copy again' : 'Copy invite link'}</button>{shareState === 'failed' && <p className="share-fallback" role="alert">Copy is unavailable. Share room code <strong>{room.code}</strong> instead.</p>}</section>
      <div className="lobby-grid">
        <section className="glass player-list"><div className="section-heading"><div><h2>Players</h2><span>{room.players.length}/8 seated</span></div><div className="seat-meter" aria-label={`${room.players.length} of 8 seats filled`}>{Array.from({ length: 8 }, (_, index) => <i className={index < room.players.length ? 'filled' : ''} key={index} />)}</div></div><AnimatePresence initial={false}>{room.players.map((player) => <LobbyPlayer key={player.id} player={player} self={player.id === room.selfPlayerId} canRemove={Boolean(isHost && player.id !== room.selfPlayerId)} pending={pending === `remove:${player.id}`} remove={() => void act(`remove:${player.id}`, { type: 'ROOM_REMOVE', playerId: player.id })} />)}</AnimatePresence>{Array.from({ length: Math.max(0, 8 - room.players.length) }, (_, index) => <div className="lobby-seat-empty" aria-hidden="true" key={`empty-${index}`}><span>{room.players.length + index + 1}</span><small>Open seat</small></div>)}</section>
        <aside className="glass lobby-rules">
          <div className="briefing-title"><p className="eyebrow">Round in 3 steps</p><h2>Remember. Trade. Stack.</h2></div>
          <div className="briefing-flow" aria-label="Quick rules"><span><b>1</b><div className="rule-copy"><GameGlyph kind="peek" /><small>Peek at your bottom two</small></div></span><span><b>2</b><div className="rule-copy"><GameGlyph kind="swap" /><small>Draw, discard, or swap</small></div></span><span><b>3</b><div className="rule-copy"><GameGlyph kind="stack" /><small>Stack the matching rank</small></div></span></div>
        </aside>
      </div>
      <div className="lobby-footer">
        {!isHost && self && <button className={`${self.ready ? 'secondary ready' : 'primary'} ${pending === 'ready' ? 'is-pending' : ''}`} aria-busy={pending === 'ready'} disabled={Boolean(pending)} onClick={() => void act('ready', { type: 'ROOM_READY', ready: !self.ready })}>{pending === 'ready' ? <span className="button-spinner" /> : self.ready && <Check size={16} />}{self.ready ? 'Ready' : 'Ready up'}</button>}
        {isHost && <button className={`primary deal ${pending === 'start' ? 'is-pending' : ''}`} aria-busy={pending === 'start'} disabled={!allReady || Boolean(pending)} onClick={() => void act('start', { type: 'ROOM_START' })}>{pending === 'start' && <span className="button-spinner" />}{pending === 'start' ? 'Dealing…' : startLabel}</button>}
      </div>
    </motion.main>
  );
}

function LobbyPlayer({ player, self, canRemove, pending, remove }: { player: RoomPlayerView; self: boolean; canRemove: boolean; pending: boolean; remove: () => void }) {
  const initials = player.name.slice(0, 2).toUpperCase();
  return <motion.div layout initial={{ opacity: 0, scale: .96 }} animate={{ opacity: pending ? .55 : 1, scale: 1 }} exit={{ opacity: 0, scale: .96 }} className={`lobby-player ${!player.connected ? 'offline' : ''} ${self ? 'self' : ''}`}><div className="avatar">{initials}</div><div className="player-info"><strong>{player.name}{self ? ' (you)' : ''}</strong><span>{player.handle ? <a href={`/u/${player.handle}`}>@{player.handle}</a> : 'Guest player'} · {player.stats?.wins ?? 0} wins</span></div>{!player.connected ? <span className="ready-dot offline-label">OFFLINE</span> : player.isHost ? <span className="host-badge">HOST</span> : <span className={`ready-dot ${player.ready ? 'yes' : ''}`}>{player.ready && <Check size={10} />}{player.ready ? 'READY' : 'NOT READY'}</span>}{canRemove && <button className="remove-player" disabled={pending} onClick={remove} aria-label={`Remove ${player.name}`}>{pending ? <span className="button-spinner" /> : <X size={15} />}</button>}</motion.div>;
}

export function GameTable({ room, send, sendRoom }: { room: RoomView; send: (action: GameActionInput) => Promise<ActionAck>; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const game = room.game!;
  const self = game.players.find((player) => player.id === room.selfPlayerId)!;
  const [revealVisible, setRevealVisible] = useState(false);
  const [stackFeedback, setStackFeedback] = useState<StackFeedbackState>();
  const [tableCue, setTableCue] = useState<TableCue>();
  const [previousCueTitle, setPreviousCueTitle] = useState<string>();
  const [pendingGroups, setPendingGroups] = useState<string[]>([]);
  const [pendingCardId, setPendingCardId] = useState<string>();
  const [pendingDecision, setPendingDecision] = useState<'discard' | 'swap'>();
  const [focusedOpponentId, setFocusedOpponentId] = useState<string>();
  const compactPortrait = useMediaQuery('(max-width: 500px) and (orientation: portrait)');
  const reduceMotion = useReducedMotion();
  const feedbackTimer = useRef<number | undefined>(undefined);
  const cueTimer = useRef<number | undefined>(undefined);
  const pendingUiActions = useRef(new Set<string>());
  const sendRef = useRef(send);
  const motionSnapshot = useRef<TableSnapshot | undefined>(undefined);
  const lastActivity = useRef<{ title: string; at: number } | undefined>(undefined);

  useEffect(() => () => { window.clearTimeout(feedbackTimer.current); window.clearTimeout(cueTimer.current); }, []);
  useEffect(() => { sendRef.current = send; }, [send]);
  useEffect(() => { setFocusedOpponentId(undefined); }, [game.activePlayerId, game.power?.kind, game.power?.status, game.power?.targets.length]);
  const dismissTableCue = useCallback(() => {
    window.clearTimeout(cueTimer.current);
    setTableCue(undefined);
  }, []);
  const pauseActive = Boolean(game.paused);
  const endingKey = game.ending ? `${game.ending.reason}:${game.ending.triggerPlayerId}` : '';
  useEffect(() => {
    if (!pauseActive) return;
    dismissTableCue();
    window.clearTimeout(feedbackTimer.current);
    setStackFeedback(undefined);
  }, [dismissTableCue, pauseActive]);
  useEffect(() => {
    if (!endingKey) return;
    dismissTableCue();
    window.clearTimeout(feedbackTimer.current);
    setStackFeedback(undefined);
  }, [dismissTableCue, endingKey]);
  const feedbackGeneration = useRef(game.discardGeneration);
  useEffect(() => {
    if (feedbackGeneration.current === game.discardGeneration) return;
    feedbackGeneration.current = game.discardGeneration;
    window.clearTimeout(feedbackTimer.current);
    setStackFeedback(undefined);
  }, [game.discardGeneration]);
  const performAction = useCallback(async (input: GameActionInput, cardId?: string) => {
    const group = gameActionGroup(input.type);
    // One browser should never race two conflicting intents against the same
    // expected version. Cross-player stack races remain fully concurrent on
    // the server; this only coalesces impatient taps from this local client.
    if (pendingUiActions.current.size > 0) return { clientActionId: 'pending', ok: false, code: 'ACTION_PENDING' } satisfies ActionAck;
    if (input.type !== 'STACK_ATTEMPT') {
      window.clearTimeout(feedbackTimer.current);
      setStackFeedback(undefined);
    }
    pendingUiActions.current.add(group);
    setPendingGroups([...pendingUiActions.current]);
    if (cardId) setPendingCardId(cardId);
    if (input.type === 'DISCARD_DRAWN') setPendingDecision('discard');
    if (input.type === 'SWAP_DRAWN') setPendingDecision('swap');
    try {
      return await send(input);
    } finally {
      pendingUiActions.current.delete(group);
      setPendingGroups([...pendingUiActions.current]);
      if (cardId) setPendingCardId((current) => current === cardId ? undefined : current);
      if (input.type === 'DISCARD_DRAWN' || input.type === 'SWAP_DRAWN') setPendingDecision(undefined);
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
    const handArrivals = [...current.locations.entries()].filter((entry): entry is [string, HandLocation] => entry[1].zone === 'hand' && !previous.locations.has(entry[0]));
    let cue: TableCue | undefined;
    if (handMoves.length >= 2) {
      const movements = handMoves.slice(0, 2).map(([cardId, destination]) => ({ cardId, from: previous.locations.get(cardId)!, to: destination }));
      const powerEvent = game.lastPublicEvent?.type === 'power' && game.lastPublicEvent.version === game.version ? game.lastPublicEvent : undefined;
      const actorPlayerId = powerEvent?.playerId;
      const actorName = actorPlayerId ? game.players.find((player) => player.id === actorPlayerId)?.name : undefined;
      const title = powerEvent?.powerKind === 'black_king' || previous.powerKind === 'black_king'
        ? `${actorName ?? 'Player'} used Black King`
        : `${actorName ?? 'Player'} swapped two cards`;
      cue = { id: game.version, kind: 'exchange', title, actorPlayerId, movements, from: locationLabel(movements[0].from), to: locationLabel(movements[0].to) };
    } else if (current.discardId && current.discardId !== previous.discardId) {
      const source = previous.locations.get(current.discardId)
        ?? (previous.turnStage === 'deciding'
          ? previous.drawn
            ? { zone: 'drawn' } as const
            : previous.activePlayerId && previous.activePlayerName
              ? { zone: 'decision', playerId: previous.activePlayerId, playerName: previous.activePlayerName } as const
              : undefined
          : previous.turnStage === 'awaiting_draw' ? { zone: 'deck' } as const : undefined);
      if (source) {
        const kind = previous.stackOpen && source.zone === 'hand' ? 'stack' : 'discard';
        const publicCard = publicCardLabel(game.discard);
        const discard: TableLocation = { zone: 'discard' };
        const discarded: TableMovement = { cardId: current.discardId, from: source, to: discard, face: game.discard, faceDirection: 'reveal' };
        const enteringHand = moved.find(([cardId, destination]) => cardId !== current.discardId && destination.zone === 'hand' && (previous.locations.get(cardId)?.zone === 'drawn'))
          ?? [...current.locations.entries()].find(([cardId, destination]) => cardId !== current.discardId && destination.zone === 'hand' && !previous.locations.has(cardId));
        if (kind !== 'stack' && source.zone === 'hand' && enteringHand) {
          const [cardId, destination] = enteringHand;
          const incomingFace = previous.drawn?.id === cardId ? previous.drawn : undefined;
          const incomingSource: TableLocation = previous.drawn
            ? { zone: 'drawn' }
            : previous.activePlayerId && previous.activePlayerName
              ? { zone: 'decision', playerId: previous.activePlayerId, playerName: previous.activePlayerName }
              : { zone: 'drawn' };
          const incoming: TableMovement = { cardId, from: incomingSource, to: destination, face: incomingFace, faceDirection: incomingFace ? 'conceal' : undefined };
          cue = { id: game.version, kind: 'replace', title: `${previous.activePlayerName ?? 'Player'} replaced a card`, actorPlayerId: previous.activePlayerId, movements: [discarded, incoming], from: locationLabel(incomingSource), to: locationLabel(destination), coveredDiscard: previous.discard };
        } else {
          const stackActor = kind === 'stack' && game.lastPublicEvent?.type === 'stack' && game.lastPublicEvent.version === game.version
            ? game.players.find((player) => player.id === game.lastPublicEvent?.playerId)?.name
            : source.zone === 'hand' ? source.playerName : undefined;
          const sourceOwner = kind === 'stack' && game.lastPublicEvent?.type === 'stack'
            ? game.players.find((candidate) => candidate.id === game.lastPublicEvent?.sourcePlayerId)?.name
            : undefined;
          let title = kind === 'stack' && source.zone === 'hand'
            ? `${stackActor ?? source.playerName} stacked${sourceOwner && sourceOwner !== stackActor ? ` ${sourceOwner}'s card` : ''}${publicCard ? ` · ${publicCard}` : ''}`
            : source.zone === 'drawn' || source.zone === 'decision'
              ? `${previous.activePlayerName ?? 'Player'} discarded${publicCard ? ` ${publicCard}` : ' the draw'}`
              : source.zone === 'deck'
                ? `${previous.activePlayerName ?? 'Player'} drew and discarded${publicCard ? ` ${publicCard}` : ''}`
                : source.zone === 'hand' ? `${source.playerName} replaced a card` : 'Card moved';
          if (kind === 'discard' && game.lastPublicEvent?.type === 'power' && game.lastPublicEvent.powerKind && game.lastPublicEvent.version === game.version) title += ` · ${powerName(game.lastPublicEvent.powerKind)} begins`;
          cue = { id: game.version, kind, title, actorPlayerId: kind === 'stack' ? game.lastPublicEvent?.playerId : previous.activePlayerId, movements: [discarded], from: locationLabel(source), to: 'Discard', coveredDiscard: previous.discard };
        }
      }
    } else if (previous.turnStage === 'awaiting_draw' && current.turnStage === 'deciding') {
      const drawn = current.drawn;
      const destination: TableLocation = drawn
        ? { zone: 'drawn' }
        : current.activePlayerId && current.activePlayerName
          ? { zone: 'decision', playerId: current.activePlayerId, playerName: current.activePlayerName }
          : { zone: 'drawn' };
      cue = { id: game.version, kind: 'draw', title: `${current.activePlayerName ?? 'Player'} drew a card`, actorPlayerId: current.activePlayerId, movements: [{ cardId: drawn?.id ?? `draw-${game.version}`, from: { zone: 'deck' }, to: destination, face: drawn, faceDirection: drawn ? 'reveal' : undefined }], from: 'Deck', to: locationLabel(destination) };
    } else if (current.deckCount < previous.deckCount && handArrivals.length === 1) {
      const [cardId, destination] = handArrivals[0];
      cue = { id: game.version, kind: 'penalty', title: `${destination.playerName} took a penalty`, actorPlayerId: destination.playerId, movements: [{ cardId, from: { zone: 'deck' }, to: destination }], from: 'Deck', to: locationLabel(destination) };
    } else if (moved.length === 1) {
      const [cardId, destination] = moved[0];
      const source = previous.locations.get(cardId)!;
      const movements = [{ cardId, from: source, to: destination }];
      const title = source.zone === 'hand' && destination.zone === 'hand' ? `${source.playerName} gave ${destination.playerName} a card` : 'Card moved';
      cue = { id: game.version, kind: 'transfer', title, actorPlayerId: source.zone === 'hand' ? source.playerId : undefined, movements, from: locationLabel(source), to: locationLabel(destination) };
    }
    if (!cue) return;
    const now = Date.now();
    setPreviousCueTitle(lastActivity.current && now - lastActivity.current.at <= 2_400 ? lastActivity.current.title : undefined);
    lastActivity.current = { title: cue.title, at: now };
    setTableCue(cue);
    window.clearTimeout(cueTimer.current);
    cueTimer.current = window.setTimeout(() => setTableCue(undefined), cueLifetime(cue.kind));
  // A new authoritative game version is the animation trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.version]);
  const revealFacesReady = game.power?.status === 'revealing' && game.power.targets.every((targetId) => game.players.some((player) => player.cards.some((card) => card.id === targetId && Boolean(card.rank))));
  const revealKey = game.power?.status === 'revealing' ? `${game.power.kind}:${game.power.targets.join(':')}:${revealFacesReady ? 'visible' : 'revoked'}` : '';
  const revealPaused = Boolean(game.paused);
  useEffect(() => {
    if (!revealKey || game.power?.status !== 'revealing') {
      setRevealVisible(false);
      return;
    }
    // Never leave private faces sitting open through a multiplayer pause. If
    // this player disconnected, the server projection has already revoked the
    // faces; wait for resume before completing/concealing so GAME_PAUSED does
    // not strand the power in its revealing stage.
    if (revealPaused) {
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
    if (!revealFacesReady) {
      finish();
      return;
    }
    const timer = window.setTimeout(finish, 1_700);
    const concealWhenHidden = () => { if (document.hidden) finish(); };
    window.addEventListener('blur', finish);
    document.addEventListener('visibilitychange', concealWhenHidden);
    return () => { window.clearTimeout(timer); window.removeEventListener('blur', finish); document.removeEventListener('visibilitychange', concealWhenHidden); };
  // revealKey represents a new server-approved private reveal; revealPaused
  // lets a revoked reveal finish immediately after the authoritative resume.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey, revealPaused]);

  // Recover rounds saved by the older opt-in power flow. Current rounds enter
  // targeting immediately, so no extra confirmation tap is required.
  useEffect(() => {
    if (game.activePlayerId !== self.id || game.power?.status !== 'offered') return;
    void sendRef.current({ type: 'POWER_USE' });
  }, [game.activePlayerId, game.power?.status, game.version, self.id]);

  if (game.phase === 'initial_peek') return <InitialPeek room={room} game={game} self={self} send={send} sendRoom={sendRoom} />;
  if (game.phase === 'results') return <Results room={room} game={game} sendRoom={sendRoom} />;

  // A forfeited seat remains in its authoritative position. Removing it here
  // caused every later opponent to reflow in a game built around spatial memory.
  const opponents = game.players.filter((player) => player.id !== self.id);
  const paused = revealPaused;
  const isTurn = game.activePlayerId === self.id && !paused;
  const power = isTurn ? game.power : undefined;
  const selectingPower = power?.status === 'selecting';
  const transferring = game.transfer?.fromPlayerId === self.id;
  const targetsOpponents = Boolean(selectingPower && power && (power.kind === 'opponent_peek' || ((power.kind === 'blind_swap' || power.kind === 'black_king') && (power.targets.length > 0 || self.cards.length === 0))));
  const denseTargetMode = compactPortrait && game.players.length >= 7 && targetsOpponents;
  const focusedOpponent = denseTargetMode ? opponents.find((player) => player.id === focusedOpponentId && !player.forfeited && player.cards.length > 0) : undefined;
  const canSwapDrawn = isTurn && game.turnStage === 'deciding' && Boolean(game.drawnCard) && self.cards.length > 0;
  const localActionPending = pendingGroups.length > 0;
  const canRiskStack = self.cards.length > 0 && !game.stackLocked && !paused;
  const stackAvailable = game.stackOpen && canRiskStack && !transferring && !localActionPending;
  // Power prompts already explain that the stack window remains live. Avoid a
  // second stack banner colliding with the power decision on small phones.
  const stackReady = stackAvailable && !power;
  const stackLocked = game.stackOpen && Boolean(game.stackLocked) && !transferring && !power;
  const cambioPending = pendingGroups.includes('CALL_CAMBIO');
  // Calling is intentionally table-wide: a player may call while another
  // player's turn is in progress, and that caller anchors the final rotation.
  const canCallCambrio = !game.ending && !paused;

  const attemptStack = async (card: CardView) => {
    if (stackFeedback?.kind === 'trying') return;
    setStackFeedback({ cardId: card.id, kind: 'trying' });
    const result = await performAction({ type: 'STACK_ATTEMPT', targetCardId: card.id, discardGeneration: game.discardGeneration }, card.id);
    if (!result.ok) {
      setStackFeedback(undefined);
      return;
    }
    const kind: StackFeedback = result.outcome === 'stack_success'
      ? 'correct'
      : result.outcome === 'stack_wrong'
        ? 'wrong'
        : result.outcome === 'stack_race_lost'
          ? 'race-lost'
          : 'blocked';
    const actorName = result.actorPlayerId ? game.players.find((candidate) => candidate.id === result.actorPlayerId)?.name : undefined;
    vibrate(kind === 'correct' ? 32 : kind === 'wrong' ? [18, 35, 18] : 12);
    setStackFeedback({ cardId: card.id, kind, actorName, blockReason: result.stackBlockReason });
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setStackFeedback(undefined), kind === 'wrong' ? 1_500 : kind === 'race-lost' ? 1_400 : 1_200);
  };
  const actionCard = (card: CardView, owner: PlayerView) => {
    if (transferring && owner.id === self.id) { vibrate(10); return void performAction({ type: 'TRANSFER_CARD', cardId: card.id }, card.id); }
    if (selectingPower && power && !(denseTargetMode && owner.id !== self.id) && isEligiblePowerTarget(power.kind, power.targets.length, owner.id, self.id, self.cards.length)) { vibrate(10); return void performAction({ type: 'POWER_SELECT', targetCardId: card.id }, card.id); }
    if (canSwapDrawn && owner.id === self.id) { vibrate(14); return void performAction({ type: 'SWAP_DRAWN', targetCardId: card.id }, card.id); }
    if (stackAvailable) return void attemptStack(card);
  };
  const canInteract = (owner: PlayerView) => {
    if (localActionPending) return false;
    if (transferring) return owner.id === self.id;
    if (selectingPower && power) return isEligiblePowerTarget(power.kind, power.targets.length, owner.id, self.id, self.cards.length) || stackAvailable;
    if (canSwapDrawn && owner.id === self.id) return true;
    return stackAvailable;
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
  const selectionKind = power && (power.kind === 'own_peek' || power.kind === 'opponent_peek') ? 'peek' : power ? 'swap' : undefined;
  const selectFocusedCard = (card: CardView) => {
    if (!power || !focusedOpponent || localActionPending) return;
    vibrate(10);
    void performAction({ type: 'POWER_SELECT', targetCardId: card.id }, card.id);
  };
  const receivingDiscard = Boolean(tableCue?.movements.some((movement) => movement.to.zone === 'discard'));
  const cueDecisionLocation = tableCue?.movements.flatMap((movement) => [movement.from, movement.to]).find((location): location is DecisionLocation => location.zone === 'decision');
  const opponentHoldingDraw = game.turnStage === 'deciding' && game.activePlayerId !== self.id && !paused;
  const decisionPlayerId = opponentHoldingDraw ? game.activePlayerId : cueDecisionLocation?.playerId;
  const decisionPlayer = decisionPlayerId ? game.players.find((player) => player.id === decisionPlayerId) : undefined;
  const decisionReceiving = Boolean(tableCue?.movements.some((movement) => movement.to.zone === 'decision' && movement.to.playerId === decisionPlayerId));
  const decisionDeparting = Boolean(tableCue?.movements.some((movement) => movement.from.zone === 'decision' && movement.from.playerId === decisionPlayerId));

  return (
    <motion.main className={`game-page ${game.players.length <= 4 ? 'table-roomy' : game.players.length <= 6 ? 'table-compact' : 'table-dense'} ${stackAvailable ? 'stack-mode' : ''} ${selectingPower ? 'target-mode' : ''} ${targetsOpponents ? 'target-opponents' : ''} ${denseTargetMode ? 'dense-target-mode' : ''} ${focusedOpponent ? 'has-focused-target' : ''} ${transferring ? 'transfer-mode' : ''} ${revealVisible ? 'reveal-focus-mode' : ''} ${paused ? 'is-paused' : ''} ${tableCue ? 'motion-locked' : ''}`} style={{ '--table-flight-duration': tableCue ? `${flightDuration(tableCue.kind)}s` : undefined } as CSSProperties} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="game-status"><span className="room-pill" data-short={room.code.slice(-4)} title={`Room ${room.code}`} aria-label={`Room ${room.code}`}>{room.code}</span><TurnBanner game={game} self={self} pendingDecision={pendingDecision} /><Countdown deadline={game.deadlineAt} pausedMs={game.paused?.remainingMs} /></div>
      <section className="opponent-rail" aria-label="Other players" style={{ '--opponent-count': Math.max(1, opponents.length) } as CSSProperties}>
        {opponents.map((opponent) => <PlayerHand key={opponent.id} player={opponent} compact recipient={game.transfer?.toPlayerId === opponent.id} recentActor={tableCue?.actorPlayerId === opponent.id} canInteract={() => denseTargetMode ? stackAvailable : canInteract(opponent)} highlight={() => denseTargetMode ? false : isContextTarget(opponent)} targetCue={denseTargetMode ? undefined : targetCue(opponent)} selectionKind={selectionKind} selectedCards={power?.targets} pendingCardId={pendingCardId} arrivingSlots={flightSlots(tableCue, opponent.id)} feedback={stackFeedback} reveal={revealVisible} onCard={(card) => actionCard(card, opponent)} active={game.activePlayerId === opponent.id} autoCenter={game.activePlayerId === opponent.id && !tableCue} focusable={denseTargetMode && !opponent.forfeited && opponent.cards.length > 0} focused={focusedOpponent?.id === opponent.id} onFocusPlayer={() => { vibrate(8); setFocusedOpponentId(opponent.id); }} />)}
      </section>

      <AnimatePresence>{focusedOpponent && power && <DenseTargetPanel key={focusedOpponent.id} player={focusedOpponent} power={power.kind} pendingCardId={pendingCardId} pending={localActionPending} onCard={selectFocusedCard} onBack={() => setFocusedOpponentId(undefined)} />}</AnimatePresence>

      <section className="table-center">
        {game.paused && <PauseBanner game={game} />}
        <div className="pile-zone">
          <div className={`pile ${receivingDiscard ? 'receiving-flight' : ''}`} data-table-zone="discard"><div className="discard-stack">{receivingDiscard && tableCue?.coveredDiscard && <span className="covered-discard" aria-hidden="true"><Card card={tableCue.coveredDiscard} /></span>}<span className="current-discard"><Card card={game.discard} faceDown={!game.discard} /></span></div><span>{game.discard ? 'DISCARD' : 'EMPTY'}</span></div>
          <div className={`pile deck-pile ${isTurn && game.turnStage === 'awaiting_draw' ? 'actionable' : ''}`}><button data-table-zone="deck" className={`deck-card ${isTurn && game.turnStage === 'awaiting_draw' ? 'draw-ready' : ''} ${pendingGroups.includes('DRAW') ? 'is-pending' : ''}`} aria-label={`${isTurn && game.turnStage === 'awaiting_draw' ? 'Draw card' : 'Deck'}; ${game.deckCount} cards remain`} aria-busy={pendingGroups.includes('DRAW')} disabled={!isTurn || game.turnStage !== 'awaiting_draw' || Boolean(game.transfer) || localActionPending} onClick={() => { vibrate(10); void performAction({ type: 'DRAW' }); }} title={`Draw from deck; ${game.deckCount} cards remain`}><CardBackMark />{pendingGroups.includes('DRAW') && <span className="deck-pending" aria-hidden="true" />}<small>{game.deckCount}</small></button><span>{pendingGroups.includes('DRAW') ? 'DRAWING' : isTurn && game.turnStage === 'awaiting_draw' ? 'DRAW' : 'DECK'}</span></div>
        </div>
        <span className="drawn-flight-anchor" data-table-zone="drawn" aria-hidden="true" />
        <AnimatePresence mode="wait" initial={false}>
          {game.drawnCard ? <motion.div key="drawn" data-table-zone="drawn-card" className={`drawn-panel ${tableCue?.kind === 'draw' ? 'receiving-draw' : ''} ${pendingDecision ? 'is-resolving' : ''}`} initial={reduceMotion ? false : { opacity: 0, scale: .98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .98 }} transition={{ duration: reduceMotion ? 0 : .16, ease: [0.22, 1, 0.36, 1] }}><span>YOUR DRAW</span><Card card={game.drawnCard} /><div className="drawn-actions"><button className={`primary discard-drawn ${pendingDecision === 'discard' ? 'is-pending' : ''}`} aria-label={pendingDecision === 'discard' ? 'Discarding card' : 'Discard'} aria-busy={pendingDecision === 'discard'} disabled={localActionPending} onClick={() => { vibrate(12); void performAction({ type: 'DISCARD_DRAWN' }); }}>{pendingDecision === 'discard' ? <span className="button-spinner" /> : <GameGlyph kind="discard" />}{pendingDecision === 'discard' ? 'Discarding…' : 'Discard card'}</button>{self.cards.length > 0 && <small className={`swap-slot-cue ${pendingDecision === 'swap' ? 'is-pending' : ''}`}>{pendingDecision === 'swap' ? <span className="button-spinner" /> : <GameGlyph kind="swap" />}{pendingDecision === 'swap' ? 'Replacing…' : 'Or choose a slot'}</small>}</div></motion.div> : stackReady ? <motion.div key="stack-open" className="stack-hint" role="status" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : .08 }}><GameGlyph kind="stack" /><strong>STACK OPEN</strong><span>Match the discard—first correct tap wins</span></motion.div> : stackLocked ? <motion.div key="stack-locked" className="stack-hint limit" role="status" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : .08 }}><GameGlyph kind="stack" /><strong>STACK MISSED</strong><span>Try again on the next discard</span></motion.div> : null}
        </AnimatePresence>
      </section>

      <section className="self-zone"><PlayerHand player={self} recentActor={tableCue?.actorPlayerId === self.id} canInteract={() => canInteract(self)} highlight={() => isContextTarget(self)} targetCue={targetCue(self)} selectionKind={selectionKind} selectedCards={power?.targets} pendingCardId={pendingCardId} arrivingSlots={flightSlots(tableCue, self.id)} feedback={stackFeedback} reveal={revealVisible} onCard={(card) => actionCard(card, self)} active={isTurn} /><span className="you-label">{isTurn ? 'YOUR TURN' : 'YOU'} &middot; {self.cards.length ? `${self.cards.length}/${MAX_HAND_CARDS} CARDS` : '0 CARDS'}</span></section>
      <div className="game-actions">{canCallCambrio && <button className={`cambio-button ${cambioPending ? 'is-pending' : ''}`} aria-busy={cambioPending} disabled={localActionPending} title={localActionPending && !cambioPending ? 'Wait for the current action to finish' : 'Start the final rotation'} onClick={() => { vibrate(24); void performAction({ type: 'CALL_CAMBIO' }); }}>{cambioPending ? <span className="button-spinner" /> : <GameGlyph kind="cambio" />}{cambioPending ? 'Calling…' : 'Call Cambrio'}</button>}</div>
      {decisionPlayer && <OpponentDecisionStage key={decisionPlayer.id} player={decisionPlayer} receiving={decisionReceiving} departing={decisionDeparting} action={tableCue?.kind} />}
      {game.paused && <PauseRecoveryControl room={room} game={game} sendRoom={sendRoom} />}
      <AnimatePresence>{stackFeedback && stackFeedback.kind !== 'trying' && <StackResult feedback={stackFeedback as StackFeedbackState & { kind: Exclude<StackFeedback, 'trying'> }} reduceMotion={Boolean(reduceMotion)} />}</AnimatePresence>
      <AnimatePresence>{tableCue && <SwapFlightLayer key={`flight-${tableCue.id}`} cue={tableCue} onLayoutChange={dismissTableCue} />}</AnimatePresence>
      {tableCue && <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{tableCue.title}: {tableCue.from} to {tableCue.to}</span>}
      <AnimatePresence>{tableCue && <TableActionCue key={`cue-${tableCue.id}`} cue={tableCue} previousTitle={previousCueTitle} />}</AnimatePresence>
      {game.ending && <EndingAnnouncement key={`${game.ending.reason}-${game.ending.triggerPlayerId}`} game={game} />}
      <InteractionOverlay game={game} self={self} revealVisible={revealVisible} pending={localActionPending} send={performAction} denseTargetMode={denseTargetMode} focusedTargetName={focusedOpponent?.name} />
    </motion.main>
  );
}

function InitialPeek({ room, game, self, send, sendRoom }: { room: RoomView; game: GameView; self: PlayerView; send: (action: GameActionInput) => Promise<ActionAck>; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const [holding, setHolding] = useState(false);
  const peekPlayers = game.players.filter((player) => !player.forfeited);
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
      <motion.div className="peek-copy" initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : .28 }}><p className="eyebrow">One look. Then remember.</p><h1>Your bottom two cards</h1><p id="peek-instructions">Hold below to see bottom left and bottom right. Their positions will never shift.</p></motion.div>
      <div className="peek-hand">{self.cards.map((card, index) => <motion.div className="hand-slot" data-peekable={card.slot >= 2 || undefined} key={card.id} style={{ gridColumn: card.slot % 2 + 1, gridRow: Math.floor(card.slot / 2) + 1 }} initial={reduceMotion ? false : { opacity: 0, y: -54, x: (index % 2 ? 1 : -1) * 12, rotate: (index % 2 ? 1 : -1) * 5 }} animate={{ opacity: 1, y: 0, x: 0, rotate: 0 }} transition={{ delay: reduceMotion ? 0 : .08 + index * .075, duration: reduceMotion ? 0 : .36, ease: [0.22, 1, 0.36, 1] }}><Card card={card} faceDown={!holding || card.slot < 2} positioned slot={card.slot} /></motion.div>)}</div>
      {game.paused ? <PauseBanner game={game} inline /> : self.initialPeekComplete ? <motion.div className="waiting-ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><span className="spinner" />Waiting for everyone…</motion.div> : <motion.button className="hold-button" aria-describedby="peek-instructions" onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onPointerLeave={end} onKeyDown={(event) => { if (event.key !== ' ' && event.key !== 'Enter') return; event.preventDefault(); if (!event.repeat) begin(); }} onKeyUp={(event) => { if (event.key !== ' ' && event.key !== 'Enter') return; event.preventDefault(); end(); }} onBlur={end} animate={{ scale: holding ? .97 : 1, y: holding ? 2 : 0 }} transition={{ duration: reduceMotion ? 0 : .12 }}><GameGlyph kind="peek" />{holding ? 'Memorize bottom two' : 'Hold to peek'}</motion.button>}
      <motion.div className="peek-meta" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: reduceMotion ? 0 : .42 }}><span className="ready-progress">{peekPlayers.filter((player) => player.initialPeekComplete).length}/{peekPlayers.length} ready</span><Countdown deadline={game.deadlineAt} pausedMs={game.paused?.remainingMs} /></motion.div>
      {game.paused && <PauseRecoveryControl room={room} game={game} sendRoom={sendRoom} />}
    </main>
  );
}

function InteractionOverlay({ game, self, revealVisible, pending, send, denseTargetMode = false, focusedTargetName }: { game: GameView; self: PlayerView; revealVisible: boolean; pending: boolean; send: (action: GameActionInput) => Promise<ActionAck>; denseTargetMode?: boolean; focusedTargetName?: string }) {
  if (game.paused) return null;
  if (game.transfer?.fromPlayerId === self.id) {
    const recipient = game.players.find((player) => player.id === game.transfer?.toPlayerId);
    return <div className="interaction-prompt transfer-prompt" role="status"><span className="ability-chip"><GameGlyph kind="gift" />STACK REWARD</span><div className="prompt-copy"><strong>Give {recipient?.name ?? 'the other player'} one card</strong><span>Choose a highlighted card.</span></div></div>;
  }
  const power = game.power;
  if (!power || game.activePlayerId !== self.id) return null;
  if (power.status === 'offered') return <div className="interaction-prompt activating-power"><span className="button-spinner" /><strong>Opening {powerName(power.kind)}</strong></div>;
  if (power.status === 'selecting') {
    const instruction = denseTargetMode ? focusedTargetName ? `Choose ${focusedTargetName}'s card` : 'Choose an opponent' : powerTargetInstruction(power.kind, power.targets.length, self.cards.length);
    return <div className={`interaction-prompt selecting-prompt ${denseTargetMode ? 'dense-selecting' : ''} ${pending ? 'is-pending' : ''}`} role="status"><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{powerName(power.kind)}</span><div className="prompt-copy"><strong>{instruction}</strong><ActionSequence labels={powerStepLabels(power.kind, self.cards.length)} selected={power.targets.length} />{game.stackOpen && self.cards.length > 0 && <small className="stack-still-open"><GameGlyph kind="stack" />Other cards can still stack</small>}</div><button className="text-button" aria-label="Skip ability" disabled={pending} onClick={() => void send({ type: 'POWER_DECLINE' })}>Skip</button></div>;
  }
  const blackKing = power.kind === 'black_king';
  const choosing = blackKing && power.status === 'choosing';
  const privateTargets = power.targets.map((targetId, index) => {
    const owner = game.players.find((player) => player.cards.some((card) => card.id === targetId));
    const card = owner?.cards.find((candidate) => candidate.id === targetId);
    return card && owner ? `${blackKing ? `${index === 0 ? 'First' : 'Second'}: ` : ''}${owner.id === self.id ? 'Your' : owner.name + '’s'} ${slotName(card.slot).toLowerCase()} card` : undefined;
  }).filter((label): label is string => Boolean(label));
  const privateContext = privateTargets.join(' · ');
  const stackNote = game.stackOpen && self.cards.length > 0 ? <small className="stack-still-open power-stack-note"><GameGlyph kind="stack" />Stack window remains open</small> : null;
  return <div className={`interaction-prompt power-prompt ${choosing ? 'is-choosing' : ''} ${revealVisible ? 'is-revealing' : ''} ${pending ? 'is-pending' : ''}`} role="status"><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{blackKing ? 'BLACK KING' : powerName(power.kind)}</span>{!choosing ? <div className="power-resolution"><div className="reveal-status"><GameGlyph kind="peek" /><strong>{privateContext || `Memorize ${blackKing ? 'both cards' : 'this card'}`}</strong><small className="private-reveal-note">Only you can see {blackKing ? 'these faces' : 'this face'}</small><span className="reveal-progress" /></div>{stackNote}</div> : <div className="power-choice"><strong>{privateContext && <>{privateContext}<br /></>}Choose whether these two cards switch places.</strong><button className="primary" aria-busy={pending} disabled={power.targets.length < 2 || pending} onClick={() => void send({ type: 'POWER_COMPLETE', swap: true })}>{pending ? <span className="button-spinner" /> : <GameGlyph kind="swap" />}Swap cards</button><button disabled={pending} onClick={() => void send({ type: 'POWER_COMPLETE', swap: false })}>Keep positions</button>{stackNote}</div>}</div>;
}

function StackResult({ feedback, reduceMotion }: { feedback: StackFeedbackState & { kind: Exclude<StackFeedback, 'trying'> }; reduceMotion: boolean }) {
  const { kind, actorName, blockReason } = feedback;
  const copy = kind === 'correct'
    ? { title: 'Stacked!', detail: 'Match found.' }
    : kind === 'wrong'
      ? { title: 'No match', detail: 'Penalty card added.' }
      : kind === 'blocked'
        ? blockReason === 'hand_limit'
          ? { title: 'No match', detail: 'Hand full—wait for the next discard.' }
          : { title: 'Stack closed', detail: 'The table already moved on.' }
        : { title: actorName ? `${actorName} got there first` : 'Too late', detail: 'Your card stayed in place.' };
  return <motion.div className={`stack-result ${kind} ${blockReason ?? ''}`} role="status" aria-live="polite" aria-atomic="true" initial={reduceMotion ? false : { opacity: 0, scale: .86, y: 5 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }} transition={{ duration: reduceMotion ? 0 : .16, ease: [0.22, 1, 0.36, 1] }}><span className="stack-result-mark" aria-hidden="true"><GameGlyph kind="stack" /></span><span className="stack-result-copy"><strong>{copy.title}</strong><small>{copy.detail}</small></span></motion.div>;
}

function ActionSequence({ labels, selected }: { labels: string[]; selected: number }) {
  return <div className="action-sequence" aria-hidden="true">{labels.map((label, index) => <div className="sequence-part" key={label}>{index > 0 && <ArrowRight className="sequence-arrow" size={13} />}<span className={`sequence-step ${index < selected ? 'done' : index === selected ? 'current' : ''}`}><b>{index < selected ? <Check size={10} /> : index + 1}</b><small>{label}</small></span></div>)}</div>;
}

function Results({ room, game, sendRoom }: { room: RoomView; game: GameView; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const sortedRows = game.results!.map((result) => ({ result, player: game.players.find((player) => player.id === result.playerId)! })).sort((a, b) => (a.result.score ?? 999) - (b.result.score ?? 999));
  const rows = sortedRows.map((row) => ({
    ...row,
    place: row.result.forfeited ? undefined : sortedRows.findIndex((candidate) => candidate.result.score === row.result.score) + 1,
  }));
  const winners = rows.filter((row) => row.result.winner).map((row) => row.player.name);
  const winnerNames = winners.length <= 2 ? winners.join(' & ') : `${winners[0]} & ${winners.length - 1} others`;
  const isHost = room.hostPlayerId === room.selfPlayerId;
  const reduceMotion = useReducedMotion();
  const winnerCount = rows.filter((row) => row.result.winner).length;
  const selfRow = rows.find((row) => row.player.id === room.selfPlayerId);
  const [returning, setReturning] = useState(false);
  const returnToLobby = async () => { if (returning) return; setReturning(true); try { await sendRoom({ type: 'ROOM_REMATCH' }); } finally { setReturning(false); } };
  return <motion.main className="results-page" initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduceMotion ? 0 : .22 }}>
    <motion.header className="results-hero" initial={reduceMotion ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : .32 }}>
      <span className="winner-mark" aria-hidden="true"><CambrioGlyph decorative /></span><p className="eyebrow">Round complete</p><h1>{winnerNames} {winnerCount > 1 ? 'win' : 'wins'}!</h1><p>{selfRow?.result.winner ? 'You finished with the lowest total.' : selfRow?.place ? `You placed ${ordinal(selfRow.place)} with ${selfRow.result.score} points.` : 'Lowest score takes the table.'}</p>
    </motion.header>
    <div className="results-actions">{isHost ? <motion.button className={`primary deal ${returning ? 'is-pending' : ''}`} aria-label={returning ? 'Returning to lobby' : 'Return to lobby for another round'} aria-busy={returning} disabled={returning} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : .24, duration: reduceMotion ? 0 : .18 }} onClick={() => void returnToLobby()}>{returning && <span className="button-spinner" />}{returning ? 'Returning…' : 'Play another round'}</motion.button> : <p className="waiting-host"><span className="spinner" />Waiting for the host to open the next lobby…</p>}</div>
    <section className="results-list glass" aria-label="Final scores">{rows.map(({ player, result, place }, index) => {
      const batch = Math.floor(index / 2);
      return <motion.div key={player.id} aria-current={player.id === room.selfPlayerId ? 'true' : undefined} className={`result-row ${result.winner ? 'winner' : ''} ${player.id === room.selfPlayerId ? 'self-result' : ''}`} initial={reduceMotion ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reduceMotion ? 0 : .12 + batch * .035, duration: reduceMotion ? 0 : .2, ease: [0.22, 1, 0.36, 1] }}><span className="place" aria-label={place ? `Place ${place}` : 'Forfeited'}>{place ?? '—'}</span><div><strong>{player.name}{player.id === room.selfPlayerId ? ' (you)' : ''}</strong><div className="result-cards">{player.cards.map((card, cardIndex) => <motion.span className="result-card-wrap" key={card.id} initial={reduceMotion ? false : { opacity: 0, y: -6, rotate: cardIndex % 2 ? 1 : -1 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: reduceMotion ? 0 : .16 + batch * .035 + Math.min(cardIndex, 2) * .018, duration: reduceMotion ? 0 : .16 }}><Card card={card} mini /></motion.span>)}</div></div><strong className="score"><span className="sr-only">Score </span>{result.score ?? 'Forfeit'}</strong></motion.div>;
    })}</section>
  </motion.main>;
}

function EndingAnnouncement({ game }: { game: GameView }) {
  const reduceMotion = useReducedMotion();
  const ending = game.ending!;
  const trigger = game.players.find((player) => player.id === ending.triggerPlayerId);
  const called = ending.reason === 'cambio';
  return <motion.div className={`ending-announcement ${called ? 'called' : 'zero'}`} role="status" aria-live="assertive" initial={reduceMotion ? { opacity: 1 } : { opacity: 0, scale: .96, y: 8 }} animate={reduceMotion ? { opacity: [1, 1, 0] } : { opacity: [0, 1, 1, 0], scale: [.96, 1, 1, 1], y: [8, 0, 0, -3] }} transition={{ duration: reduceMotion ? .12 : .72, times: [0, .18, .72, 1], ease: [0.22, 1, 0.36, 1] }}>
    <span className="ending-signal" aria-hidden="true"><CambrioGlyph decorative /></span>
    <div><span>{called ? 'CAMBRIO' : 'ZERO CARDS'}</span><strong>{trigger?.name ?? 'A player'} {called ? 'called it' : 'cleared their hand'}</strong><small>{called ? 'Final rotation begins' : 'Last turns are now in play'}</small></div>
  </motion.div>;
}

type StackFeedback = 'trying' | 'correct' | 'wrong' | 'race-lost' | 'blocked';
type StackFeedbackState = { cardId: string; kind: StackFeedback; actorName?: string; blockReason?: ActionAck['stackBlockReason'] };
type HandLocation = { zone: 'hand'; playerId: string; playerName: string; slot: number };
type DecisionLocation = { zone: 'decision'; playerId: string; playerName: string };
type TableLocation = HandLocation | DecisionLocation | { zone: 'discard' } | { zone: 'deck' } | { zone: 'drawn' };
type TableMovement = { cardId: string; from: TableLocation; to: TableLocation; face?: CardView; faceDirection?: 'reveal' | 'conceal' };
type TableCue = { id: number; kind: 'draw' | 'exchange' | 'replace' | 'transfer' | 'discard' | 'stack' | 'penalty'; title: string; actorPlayerId?: string; from: string; to: string; movements: TableMovement[]; coveredDiscard?: CardView };
type TableSnapshot = { locations: Map<string, TableLocation>; discardId?: string; discard?: CardView; drawn?: CardView; deckCount: number; turnStage?: GameView['turnStage']; activePlayerId?: string; activePlayerName?: string; powerKind?: PowerKind; stackOpen: boolean };

function snapshotTable(game: GameView): TableSnapshot {
  const locations = new Map<string, TableLocation>(game.players.flatMap((player) => player.cards.map((card) => [card.id, { zone: 'hand', playerId: player.id, playerName: player.name, slot: card.slot }] as const)));
  if (game.drawnCard) locations.set(game.drawnCard.id, { zone: 'drawn' });
  const activePlayer = game.players.find((player) => player.id === game.activePlayerId);
  return {
    locations,
    discardId: game.discard?.id,
    discard: game.discard,
    drawn: game.drawnCard,
    deckCount: game.deckCount,
    turnStage: game.turnStage,
    activePlayerId: activePlayer?.id,
    activePlayerName: activePlayer?.name,
    powerKind: game.power?.kind,
    stackOpen: game.stackOpen,
  };
}

function locationLabel(location: TableLocation): string {
  if (location.zone === 'hand') return `${location.playerName} ${slotTag(location.slot)}`;
  if (location.zone === 'decision') return `${location.playerName}'s draw`;
  if (location.zone === 'drawn') return 'Drawn card';
  return location.zone === 'deck' ? 'Deck' : 'Discard';
}

function sameLocation(first: TableLocation, second: TableLocation): boolean {
  if (first.zone !== second.zone) return false;
  if (first.zone === 'hand') return second.zone === 'hand' && first.playerId === second.playerId && first.slot === second.slot;
  if (first.zone === 'decision') return second.zone === 'decision' && first.playerId === second.playerId;
  return true;
}

function flightSlots(cue: TableCue | undefined, playerId: string): number[] {
  return cue?.movements.flatMap((movement) => movement.to.zone === 'hand' && movement.to.playerId === playerId ? [movement.to.slot] : []) ?? [];
}

type FlightGeometry = { cardId: string; from: DOMRect; to: DOMRect; fromLabel: string; toLabel: string; face?: CardView; faceDirection?: 'reveal' | 'conceal' };

const FLIGHT_DURATIONS: Record<TableCue['kind'], number> = {
  draw: .34,
  discard: .38,
  stack: .38,
  penalty: .44,
  transfer: .5,
  exchange: .58,
  replace: .58,
};

function flightDuration(kind: TableCue['kind']): number {
  return FLIGHT_DURATIONS[kind];
}

function flightEase(kind: TableCue['kind']): [number, number, number, number] {
  if (kind === 'stack') return [.16, 1, .3, 1];
  if (kind === 'penalty') return [.25, .8, .25, 1];
  if (kind === 'transfer') return [.2, .75, .2, 1];
  if (kind === 'exchange') return [.35, .8, .2, 1];
  if (kind === 'replace') return [.22, .85, .2, 1];
  return [.22, 1, .36, 1];
}

function cueLifetime(kind: TableCue['kind']): number {
  if (kind === 'draw') return 520;
  if (kind === 'discard') return 600;
  if (kind === 'replace') return 850;
  if (kind === 'stack') return 1_250;
  if (kind === 'penalty') return 1_200;
  if (kind === 'transfer') return 1_300;
  return 800;
}

function publicCardLabel(card?: CardView): string | undefined {
  if (!card?.rank || !card.suit) return undefined;
  const suit = card.suit === 'hearts' ? '♥' : card.suit === 'diamonds' ? '♦' : card.suit === 'clubs' ? '♣' : '♠';
  return `${card.rank}${suit}`;
}

function SwapFlightLayer({ cue, onLayoutChange }: { cue: TableCue; onLayoutChange: () => void }) {
  const [flights, setFlights] = useState<FlightGeometry[]>([]);
  const [active, setActive] = useState(true);
  const reduceMotion = useReducedMotion();
  const duration = flightDuration(cue.kind);
  useLayoutEffect(() => {
    const measured = cue.movements.flatMap((movement) => {
      const from = locationRect(movement.from);
      const to = locationRect(movement.to);
      return from && to ? [{ cardId: movement.cardId, from: snapRect(from), to: snapRect(to), fromLabel: locationLabel(movement.from), toLabel: locationLabel(movement.to), face: movement.face, faceDirection: movement.faceDirection }] : [];
    });
    setFlights(measured);
  }, [cue]);
  useEffect(() => {
    setActive(true);
    const timer = window.setTimeout(() => setActive(false), duration * 1_000 + 40);
    return () => window.clearTimeout(timer);
  }, [cue, duration]);
  useEffect(() => {
    // A phone can rotate while a card is in flight. The authoritative DOM is
    // already at its final state, so abort the cosmetic layer instead of
    // landing against stale pre-rotation coordinates.
    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('orientationchange', onLayoutChange);
    window.addEventListener('pagehide', onLayoutChange);
    const cancelWhenHidden = () => { if (document.hidden) onLayoutChange(); };
    document.addEventListener('visibilitychange', cancelWhenHidden);
    return () => {
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('orientationchange', onLayoutChange);
      window.removeEventListener('pagehide', onLayoutChange);
      document.removeEventListener('visibilitychange', cancelWhenHidden);
    };
  }, [onLayoutChange]);
  useEffect(() => {
    if (reduceMotion) onLayoutChange();
  }, [onLayoutChange, reduceMotion]);
  if (!flights.length || reduceMotion || !active) return null;
  return <motion.div className={`swap-flight-layer ${cue.kind}`} style={{ '--flight-duration': `${duration}s` } as CSSProperties} initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: .06 } }} aria-hidden="true">
    {flights.map((flight, index) => {
      const direction = index === 0 ? -1 : 1;
      const deltaX = flight.to.left - flight.from.left;
      const deltaY = flight.to.top - flight.from.top;
      const middleX = deltaX / 2 + direction * (cue.kind === 'draw' ? 5 : 16);
      const middleY = deltaY / 2 + direction * (cue.kind === 'draw' ? 18 : 30);
      const destinationScaleX = flight.to.width / flight.from.width;
      const destinationScaleY = flight.to.height / flight.from.height;
      const travelTimes = cue.kind === 'replace' ? index === 0 ? [0, .08, .42, .94, 1] : [0, .2, .58, .94, 1] : cue.kind === 'draw' ? [0, .06, .5, .94, 1] : [0, .1, .54, .91, 1];
      const startRotate = index === 0 ? -2 : 2;
      const middleRotate = index === 0 ? -7 : 7;
      const transform = (x: number, y: number, rotate: number, scaleX: number, scaleY: number) => `translate3d(${x}px, ${y}px, 0) rotate(${rotate}deg) scale(${scaleX}, ${scaleY})`;
      return <motion.span key={flight.cardId} className={`card-flight flight-${index + 1} ${flight.faceDirection ? `face-${flight.faceDirection}` : ''}`} data-flight-card={flight.cardId}
        data-flight-from={flight.fromLabel} data-flight-to={flight.toLabel}
        data-flight-distance={Math.round(Math.hypot(flight.to.left - flight.from.left, flight.to.top - flight.from.top))}
        style={{ left: flight.from.left, top: flight.from.top, width: flight.from.width, height: flight.from.height, transformOrigin: 'top left' }}
        initial={{ transform: transform(0, 0, startRotate, 1, 1), opacity: 1 }}
        animate={{ transform: [transform(0, 0, startRotate, 1, 1), transform(0, 0, startRotate, 1, 1), transform(middleX, middleY, middleRotate, Math.sqrt(destinationScaleX), Math.sqrt(destinationScaleY)), transform(deltaX, deltaY, 0, destinationScaleX, destinationScaleY), transform(deltaX, deltaY, 0, destinationScaleX, destinationScaleY)], opacity: [1, 1, 1, 1, 0] }}
        transition={{ duration, times: travelTimes, ease: flightEase(cue.kind) }}><span className="flight-surface flight-back"><CardBackMark /></span>{flight.face?.rank && flight.face.suit && <span className={`flight-surface flight-front ${flight.face.suit === 'hearts' || flight.face.suit === 'diamonds' ? 'red' : ''}`}><strong>{flight.face.rank}</strong><SuitMark suit={flight.face.suit} /></span>}{flights.length > 1 && <b>{index + 1}</b>}</motion.span>;
    })}
  </motion.div>;
}

function snapRect(rect: DOMRect): DOMRect {
  return new DOMRect(Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height));
}

function locationRect(location: TableLocation): DOMRect | undefined {
  if (location.zone === 'discard') return document.querySelector<HTMLElement>('[data-table-zone="discard"] .playing-card')?.getBoundingClientRect();
  if (location.zone === 'deck') return document.querySelector<HTMLElement>('[data-table-zone="deck"]')?.getBoundingClientRect();
  if (location.zone === 'drawn') return document.querySelector<HTMLElement>('[data-table-zone="drawn-card"] .playing-card')?.getBoundingClientRect() ?? document.querySelector<HTMLElement>('[data-table-zone="drawn"]')?.getBoundingClientRect();
  if (location.zone === 'decision') return [...document.querySelectorAll<HTMLElement>('[data-decision-player]')].find((element) => element.dataset.decisionPlayer === location.playerId)?.querySelector<HTMLElement>('.decision-card-anchor')?.getBoundingClientRect();
  return document.querySelector<HTMLElement>(`.hand-slot[data-player-id="${location.playerId}"][data-slot="${location.slot}"]`)?.getBoundingClientRect();
}

function TableActionCue({ cue, previousTitle }: { cue: TableCue; previousTitle?: string }) {
  const reduceMotion = useReducedMotion();
  return <motion.div className={`table-action-cue ${cue.kind}`} aria-hidden="true" initial={reduceMotion ? false : { opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6, transition: { duration: reduceMotion ? 0 : .1 } }} transition={{ delay: reduceMotion ? 0 : .06, duration: reduceMotion ? 0 : .18, ease: [0.22, 1, 0.36, 1] }}>
    {cue.kind === 'draw' ? <span className="cue-card-single"><CardBackMark /></span>
      : cue.kind === 'discard' ? <span className="cue-icon"><GameGlyph kind="discard" /></span>
        : cue.kind === 'stack' ? <span className="cue-icon"><GameGlyph kind="stack" /></span>
          : cue.kind === 'penalty' ? <span className="cue-icon cue-penalty">!</span>
            : cue.kind === 'transfer' ? <span className="cue-icon"><GameGlyph kind="gift" /></span>
              : <span className="cue-cards"><i /><i /></span>}
    <span><strong>{cue.title}</strong><small><span>{cue.from} <b>{cue.kind === 'exchange' ? '↔' : '→'}</b> {cue.to}</span>{previousTitle && previousTitle !== cue.title && <em>Before · {previousTitle}</em>}</small></span>
  </motion.div>;
}

type DecisionAnchor = { left: number; top: number; labelSide: 'below' | 'left' | 'right' };

function measureDecisionAnchor(playerId: string): DecisionAnchor {
  const seat = [...document.querySelectorAll<HTMLElement>('[data-player-seat]')].find((element) => element.dataset.playerSeat === playerId);
  if (!seat) return { left: window.innerWidth / 2, top: Math.max(110, window.innerHeight * .24), labelSide: 'below' };
  const rect = seat.getBoundingClientRect();
  const compactLandscape = window.innerHeight <= 500 && window.innerWidth >= 600;
  const sideAnchoredPhone = window.innerWidth <= 500 && (window.innerHeight <= 680 || rect.bottom > window.innerHeight * .38);
  const cardHalfWidth = window.innerHeight <= 680 ? compactLandscape ? 21 : 18 : window.innerWidth <= 760 ? 21 : 27;
  const cardHeight = cardHalfWidth * 2 * 1.4;
  const center = rect.left + rect.width / 2;
  if (sideAnchoredPhone) {
    const seatOnLeft = center < window.innerWidth / 2;
    const sideCenter = center + (seatOnLeft ? -1 : 1) * (rect.width / 2 + cardHalfWidth + 6);
    return {
      left: Math.min(window.innerWidth - cardHalfWidth - 8, Math.max(cardHalfWidth + 8, sideCenter)),
      top: rect.bottom + 7,
      labelSide: seatOnLeft ? 'right' : 'left',
    };
  }
  if (compactLandscape) {
    const seatOnLeft = center < window.innerWidth / 2;
    const sideCenter = seatOnLeft ? rect.right + cardHalfWidth / 2 : rect.left - cardHalfWidth / 2;
    const localHandTop = document.querySelector<HTMLElement>('.self-zone .hand-cards')?.getBoundingClientRect().top ?? window.innerHeight;
    return {
      left: Math.min(window.innerWidth - cardHalfWidth - 8, Math.max(cardHalfWidth + 8, sideCenter)),
      top: Math.min(rect.bottom - cardHeight - 14, localHandTop - cardHeight - 7),
      labelSide: seatOnLeft ? 'left' : 'right',
    };
  }
  const labelSide = window.innerHeight > 680 && rect.bottom > window.innerHeight * .38 ? center > window.innerWidth / 2 ? 'left' : 'right' : 'below';
  return {
    left: Math.min(window.innerWidth - cardHalfWidth - 8, Math.max(cardHalfWidth + 8, center)),
    top: rect.bottom + (window.innerHeight <= 680 ? 7 : 10),
    labelSide,
  };
}

function OpponentDecisionStage({ player, receiving, departing, action }: { player: PlayerView; receiving: boolean; departing: boolean; action?: TableCue['kind'] }) {
  const [anchor, setAnchor] = useState<DecisionAnchor>(() => measureDecisionAnchor(player.id));
  useLayoutEffect(() => {
    let frame: number | undefined;
    const update = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const next = measureDecisionAnchor(player.id);
        setAnchor((current) => Math.abs(current.left - next.left) < .5 && Math.abs(current.top - next.top) < .5 && current.labelSide === next.labelSide ? current : next);
      });
    };
    const seat = [...document.querySelectorAll<HTMLElement>('[data-player-seat]')].find((element) => element.dataset.playerSeat === player.id);
    const rail = seat?.closest('.opponent-rail');
    const observer = seat && 'ResizeObserver' in window ? new ResizeObserver(update) : undefined;
    if (seat) observer?.observe(seat);
    rail?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      rail?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [player.id]);
  const status = departing ? action === 'replace' ? 'SWAPPING' : 'DISCARDING' : receiving ? 'DRAWING' : 'CHOOSING';
  return <div data-decision-player={player.id} className={`opponent-decision-stage label-${anchor.labelSide} ${receiving ? 'receiving-draw' : ''} ${departing ? 'departing-draw' : ''}`} style={{ left: anchor.left, top: anchor.top }} role="status" aria-live="polite" aria-label={`${player.name} is ${status.toLowerCase()} a hidden drawn card`}>
    <span className="decision-owner"><strong>{player.name}</strong><small>{status}</small></span>
    <span className="decision-card-anchor" aria-hidden="true"><Card card={{ id: `decision-${player.id}`, slot: -1 }} faceDown /></span>
  </div>;
}

type CardTargetCue = 'step-1' | 'step-2' | 'peek' | 'swap' | 'give';

function DenseTargetPanel({ player, power, pendingCardId, pending, onCard, onBack }: { player: PlayerView; power: PowerKind; pendingCardId?: string; pending: boolean; onCard: (card: CardView) => void; onBack: () => void }) {
  const reduceMotion = useReducedMotion();
  const highestSlot = player.cards.reduce((highest, card) => Math.max(highest, card.slot), 3);
  const slotCount = Math.max(4, highestSlot + 1);
  const cardsBySlot = new Map(player.cards.map((card) => [card.slot, card]));
  const selectionKind = power === 'opponent_peek' ? 'peek' : 'swap';
  const cue: CardTargetCue = selectionKind;
  return <motion.section className="dense-target-panel" aria-label={`Choose one of ${player.name}'s cards`} initial={reduceMotion ? false : { opacity: 0, y: 8, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 5, scale: .98 }} transition={{ duration: reduceMotion ? 0 : .16, ease: [0.22, 1, 0.36, 1] }}>
    <header><span><small>CHOOSE ONE CARD</small><strong>{player.name}</strong></span><button type="button" onClick={onBack}>Change</button></header>
    <div className="dense-target-cards">
      {Array.from({ length: slotCount }, (_, slot) => {
        const card = cardsBySlot.get(slot);
        return <div className={`dense-target-slot ${card ? '' : 'vacant'}`} key={slot} data-position={slotTag(slot)}>{card ? <Card card={card} faceDown positioned slot={slot} targetOption targetCue={cue} selectionKind={selectionKind} pending={pendingCardId === card.id} interactive={!pending} reference onClick={() => onCard(card)} /> : <span aria-hidden="true">{slotTag(slot)}</span>}</div>;
      })}
    </div>
  </motion.section>;
}

function PlayerHand({ player, compact = false, recipient = false, recentActor = false, canInteract, highlight, targetCue, selectionKind, selectedCards = [], pendingCardId, arrivingSlots = [], feedback, reveal = false, active = false, autoCenter = active, focusable = false, focused = false, onFocusPlayer, onCard }: { player: PlayerView; compact?: boolean; recipient?: boolean; recentActor?: boolean; canInteract?: (card: CardView) => boolean; highlight?: (card: CardView) => boolean; targetCue?: CardTargetCue; selectionKind?: 'peek' | 'swap'; selectedCards?: string[]; pendingCardId?: string; arrivingSlots?: number[]; feedback?: StackFeedbackState; reveal?: boolean; active?: boolean; autoCenter?: boolean; focusable?: boolean; focused?: boolean; onFocusPlayer?: () => void; onCard: (card: CardView) => void }) {
  const handRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const hand = handRef.current;
    const rail = hand?.parentElement;
    if (!autoCenter || !compact || !hand || !rail || rail.scrollWidth <= rail.clientWidth) return;
    const frame = window.requestAnimationFrame(() => {
      if (hand.closest('.game-page')?.classList.contains('motion-locked')) return;
      const railRect = rail.getBoundingClientRect();
      const handRect = hand.getBoundingClientRect();
      const centeredLeft = rail.scrollLeft + handRect.left - railRect.left - (rail.clientWidth - handRect.width) / 2;
      rail.scrollTo({ left: Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, centeredLeft)), behavior: 'auto' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoCenter, compact]);
  const highestSlot = player.cards.reduce((highest, card) => Math.max(highest, card.slot), 3);
  const slotCount = Math.max(4, highestSlot + 1);
  const cardsBySlot = new Map(player.cards.map((card) => [card.slot, card]));
  const cardCountLabel = player.forfeited ? 'Forfeited' : player.cards.length === 0 ? 'No cards' : `${player.cards.length} ${player.cards.length === 1 ? 'card' : 'cards'}`;
  const seatLabel = <><span className="seat-identity"><b>{player.name}</b><AnimatePresence initial={false} mode="popLayout"><motion.small key={cardCountLabel} initial={reduceMotion ? false : { opacity: 0, y: -3, scale: 1.12 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3, scale: .9 }} transition={{ duration: reduceMotion ? 0 : .16, ease: [0.22, 1, 0.36, 1] }}>{cardCountLabel}</motion.small></AnimatePresence></span>{player.forfeited ? <i>FORFEITED</i> : !player.connected ? <i>OFFLINE</i> : recipient ? <i className="recipient-label">RECEIVES</i> : focusable ? <i className="target-label">{focused ? 'TARGET' : 'CHOOSE'}</i> : null}</>;
  const seatAria = `${player.name}, ${cardCountLabel}${active ? ', current turn' : ''}${recipient ? ', receives your card' : ''}${!player.connected && !player.forfeited ? ', offline' : ''}${focusable ? focused ? ', selected target' : ', choose this opponent' : ''}`;
  return <div ref={handRef} data-player-seat={player.id} className={`player-hand ${compact ? 'compact' : ''} ${active ? 'active-turn' : ''} ${recentActor ? 'recent-actor' : ''} ${recipient ? 'transfer-recipient' : ''} ${focusable ? 'focusable-player' : ''} ${focused ? 'focused-player' : ''} ${player.cards.length === 0 ? 'empty-hand' : ''} ${player.forfeited ? 'forfeited-hand' : ''}`}>
    {focusable ? <button type="button" className="seat-name target-focus-control" aria-label={seatAria} aria-pressed={focused} onClick={onFocusPlayer}>{seatLabel}</button> : <div className="seat-name" aria-label={seatAria}>{seatLabel}</div>}
    <div className="hand-cards" aria-label={`${player.name}'s cards`}>
      {Array.from({ length: slotCount }, (_, slot) => {
        const card = cardsBySlot.get(slot);
        const selectionIndex = card ? selectedCards.indexOf(card.id) : -1;
        return <div className={`hand-slot ${card ? '' : 'vacant'} ${arrivingSlots.includes(slot) ? 'flight-receiving' : ''}`} key={slot} data-player-id={player.id} data-slot={slot} data-position={slotTag(slot)}>{card ? <Card card={card} faceDown={!reveal} positioned slot={slot} targetOption={highlight?.(card)} targetCue={targetCue} selectionKind={selectionKind} selectionOrder={selectionIndex >= 0 ? selectionIndex + 1 : undefined} pending={pendingCardId === card.id} feedback={feedback?.cardId === card.id ? feedback.kind : undefined} interactive={canInteract?.(card)} onClick={() => onCard(card)} /> : <span className="vacant-marker" aria-hidden="true" />}</div>;
      })}
      {player.cards.length === 0 && <div className="out-badge" role="status"><strong>{player.forfeited ? 'FORFEITED' : 'NO CARDS'}</strong><small>{player.forfeited ? 'Hand removed' : 'Seat stays in play'}</small></div>}
    </div>
  </div>;
}

export function Card({ card, faceDown = false, interactive = false, mini = false, positioned = false, targetOption = false, targetCue, selectionKind, selectionOrder, pending = false, feedback, slot, label, reference = false, onClick }: { card?: CardView; faceDown?: boolean; interactive?: boolean; mini?: boolean; positioned?: boolean; targetOption?: boolean; targetCue?: CardTargetCue; selectionKind?: 'peek' | 'swap'; selectionOrder?: number; pending?: boolean; feedback?: StackFeedback; slot?: number; label?: string; reference?: boolean; onClick?: () => void }) {
  const hidden = faceDown || !card?.rank;
  const red = card?.suit === 'hearts' || card?.suit === 'diamonds';
  const actualSlot = slot ?? card?.slot;
  const actionDescription = selectionOrder
    ? `; selected ${selectionKind === 'peek' ? 'to peek' : selectionOrder === 1 ? 'source' : 'destination'}`
    : targetCue
      ? `; ${targetCue === 'step-1' || targetCue === 'step-2' ? `${selectionKind === 'peek' ? 'peek' : 'swap'} target ${targetCue === 'step-1' ? '1' : '2'}` : targetCue === 'peek' ? 'tap to peek' : targetCue === 'give' ? 'tap to give' : 'tap to swap'}`
      : interactive ? '; tap to attempt stack' : '';
  const description = !card ? 'Empty discard pile' : hidden ? `${actualSlot === undefined || actualSlot < 0 ? 'Hidden' : slotName(actualSlot)} card${actionDescription}` : `${card.rank} of ${card.suit}${actionDescription}`;
  return <button data-card-id={reference ? undefined : card?.id} data-slot={actualSlot} title={description} aria-label={description} aria-busy={pending} className={`playing-card ${hidden ? 'face-down' : ''} ${red ? 'red' : ''} ${interactive ? 'interactive' : ''} ${targetOption ? 'target-option' : ''} ${mini ? 'mini' : ''} ${positioned ? 'positioned' : ''} ${selectionOrder ? 'selected' : ''} ${pending ? 'action-pending' : ''} ${feedback ? `stack-${feedback}` : ''} ${!card ? 'empty' : ''}`} disabled={!interactive || pending} onClick={onClick}>
    <AnimatePresence initial={false} mode="popLayout">
      {hidden ? <motion.span key="back" className="card-surface card-reverse" initial={{ opacity: 0, rotateY: -88 }} animate={{ opacity: 1, rotateY: 0 }} exit={{ opacity: 0, rotateY: 88 }} transition={{ duration: .22, ease: [0.22, 1, 0.36, 1] }}><CardBackMark /></motion.span> : <motion.span key="front" className="card-surface card-front" initial={{ opacity: 0, rotateY: 88 }} animate={{ opacity: 1, rotateY: 0 }} exit={{ opacity: 0, rotateY: -88 }} transition={{ duration: .22, ease: [0.22, 1, 0.36, 1] }}><span className="corner" data-rank={card!.rank}><b>{card!.rank}</b><SuitMark suit={card!.suit!} /></span><SuitMark suit={card!.suit!} className="center-suit" /></motion.span>}
    </AnimatePresence>
    {positioned && actualSlot !== undefined && <span className="slot-tag">{slotTag(actualSlot)}</span>}
    {targetOption && targetCue && !selectionOrder && <span className={`target-cue ${targetCue}`} aria-hidden="true">{targetCue === 'step-1' ? '1' : targetCue === 'step-2' ? '2' : <GameGlyph kind={targetCue === 'give' ? 'gift' : targetCue === 'peek' ? 'peek' : 'swap'} />}</span>}
    {selectionOrder && <motion.span className="selection-order" aria-hidden="true" initial={{ scale: .5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>{selectionOrder}<small>{selectionKind === 'peek' ? 'PEEK' : selectionOrder === 1 ? 'FROM' : 'TO'}</small></motion.span>}
    {pending && <span className="card-pending" aria-hidden="true" />}
    {label && <em>{label}</em>}
  </button>;
}

function TurnBanner({ game, self, pendingDecision }: { game: GameView; self: PlayerView; pendingDecision?: 'discard' | 'swap' }) {
  const active = game.players.find((player) => player.id === game.activePlayerId);
  const activeIndex = active ? game.players.findIndex((player) => player.id === active.id) : -1;
  const nextPlayer = activeIndex >= 0 ? Array.from({ length: game.players.length - 1 }, (_, offset) => game.players[(activeIndex + offset + 1) % game.players.length]).find((player) => !player.forfeited) : undefined;
  const endingPlayer = game.ending ? game.players.find((player) => player.id === game.ending!.triggerPlayerId) : undefined;
  const reduceMotion = useReducedMotion();
  if (game.paused) {
    const disconnected = game.players.filter((player) => game.paused!.playerIds.includes(player.id));
    return <div className="turn-banner paused" role="status" aria-live="polite"><strong>{disconnected.length === 1 ? `${disconnected[0].name} disconnected` : `${disconnected.length} players disconnected`}</strong><span>Game paused · seat saved</span></div>;
  }
  if (game.transfer) {
    const giver = game.players.find((player) => player.id === game.transfer?.fromPlayerId);
    const recipient = game.players.find((player) => player.id === game.transfer?.toPlayerId);
    const localGives = giver?.id === self.id;
    return <div className={`turn-banner transfer-turn ${localGives ? 'your-turn' : ''}`} role="status" aria-live="polite"><strong>{localGives ? 'Stack reward' : `${giver?.name ?? 'Player'} is giving a card`}</strong><span>{localGives ? `${recipient?.name ?? 'The opponent'} receives your card` : `Finishing the stack with ${recipient?.name ?? 'the recipient'}`}</span></div>;
  }
  return <div className={`turn-banner ${active?.id === self.id ? 'your-turn' : ''} ${game.ending ? 'ending-turn' : ''}`} role="status" aria-live="polite" aria-atomic="true">{game.ending && <span className="ending-state" role="status" aria-live="assertive"><CambrioGlyph decorative compact /><b>{game.ending.reason === 'cambio' ? 'CAMBRIO CALLED' : 'ZERO CARDS'}</b></span>}<motion.strong key={active?.id ?? 'none'} initial={reduceMotion ? false : { opacity: .62, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduceMotion ? 0 : .2, ease: [0.22, 1, 0.36, 1] }}>{active?.id === self.id ? 'Your turn' : `${active?.name ?? 'Player'}'s turn`}</motion.strong><span>{pendingDecision === 'discard' ? 'Sending discard…' : pendingDecision === 'swap' ? 'Replacing card…' : game.ending ? `${endingPlayer?.name ?? 'Player'} · ${game.ending.turnsRemaining === 0 ? 'final turn' : `${game.ending.turnsRemaining} ${game.ending.turnsRemaining === 1 ? 'turn' : 'turns'} after this one`}` : game.turnStage === 'awaiting_draw' ? 'Draw from the deck' : game.turnStage === 'deciding' ? 'Discard or replace' : 'Resolving a power'}{!game.ending && nextPlayer && <i className="turn-next">Next {nextPlayer.id === self.id ? 'you' : nextPlayer.name}</i>}</span></div>;
}

function Countdown({ deadline, pausedMs }: { deadline?: number; pausedMs?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!deadline) return; const timer = window.setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, [deadline]);
  const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000));
  const remaining = pausedMs !== undefined ? Math.max(0, Math.ceil(pausedMs / 1000)) : seconds;
  const timerStyle = { '--time-progress': `${Math.min(360, Math.max(0, remaining / 45 * 360))}deg` } as CSSProperties;
  if (pausedMs !== undefined) return <span className="countdown paused" style={timerStyle} role="timer" aria-live="off" title={`Paused with ${remaining} seconds remaining`} aria-label={`Timer paused with ${remaining} seconds remaining`}><i /><i /></span>;
  return <span className={`countdown ${seconds <= 10 ? 'urgent' : seconds <= 20 ? 'warning' : ''}`} style={timerStyle} role="timer" aria-live="off" aria-label={`${seconds} seconds remaining`}>{seconds}s</span>;
}

function PauseBanner({ game, inline = false }: { game: GameView; inline?: boolean }) {
  const names = game.players.filter((player) => game.paused?.playerIds.includes(player.id)).map((player) => player.name);
  const label = names.length === 1 ? names[0] : `${names.length} players`;
  return <motion.div className={`pause-banner ${inline ? 'inline' : ''}`} role="status" aria-live="polite" initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }}><span className="pause-symbol" aria-hidden="true"><i /><i /></span><div><strong>Game paused</strong><small>Waiting for {label} to reconnect</small></div></motion.div>;
}

function PauseRecoveryControl({ room, game, sendRoom }: { room: RoomView; game: GameView; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const [open, setOpen] = useState(false);
  const [pendingPlayerId, setPendingPlayerId] = useState<string>();
  const closeDialog = useCallback(() => { if (!pendingPlayerId) setOpen(false); }, [pendingPlayerId]);
  const dialogRef = useModalFocus<HTMLDivElement>(open, closeDialog);
  const disconnected = game.players.filter((player) => game.paused?.playerIds.includes(player.id));
  const isHost = room.hostPlayerId === room.selfPlayerId;
  if (!game.paused || !isHost || disconnected.length === 0) return null;
  const remove = async (player: PlayerView) => {
    if (pendingPlayerId) return;
    setPendingPlayerId(player.id);
    try {
      const result = await sendRoom({ type: 'ROOM_REMOVE', playerId: player.id });
      if (result.ok && disconnected.length === 1) setOpen(false);
    } finally {
      setPendingPlayerId(undefined);
    }
  };
  return <>
    <button className="pause-recovery-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => { vibrate(10); setOpen(true); }}><UserRound size={15} /><span>Manage pause</span><b>{disconnected.length}</b></button>
    <AnimatePresence>{open && <motion.div ref={dialogRef} className="pause-recovery-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onPointerDown={() => !pendingPlayerId && setOpen(false)}>
      <motion.section className="pause-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-recovery-title" initial={{ opacity: 0, y: 14, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: .98 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }} onPointerDown={(event) => event.stopPropagation()}>
        <span className="pause-symbol" aria-hidden="true"><i /><i /></span>
        <div className="pause-recovery-copy"><p className="eyebrow">Host control</p><h2 id="pause-recovery-title">Keep waiting or continue?</h2><p>Every seat stays exactly where it was. Remove someone only if they are not coming back; their hand will forfeit and the round will resume when all remaining players are online.</p></div>
        <div className="pause-player-list">{disconnected.map((player) => <div key={player.id}><span className="pause-player-avatar">{player.name.slice(0, 2).toUpperCase()}</span><span><strong>{player.name}</strong><small>Seat saved · offline</small></span><button className="danger-outline" aria-busy={pendingPlayerId === player.id} disabled={Boolean(pendingPlayerId)} onClick={() => void remove(player)}>{pendingPlayerId === player.id ? <span className="button-spinner" /> : 'Forfeit hand'}</button></div>)}</div>
        <button className="secondary pause-wait-button" disabled={Boolean(pendingPlayerId)} onClick={() => setOpen(false)}>Keep waiting</button>
      </motion.section>
    </motion.div>}</AnimatePresence>
  </>;
}

function AccountPanel({ session, audio, close, force = false, onSaved, onLeave }: { session: ClientSession; audio: ReturnType<typeof useGameAudio>; close: () => void; force?: boolean; onSaved?: () => void; onLeave?: () => void }) {
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState(readStoredName);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState<'google' | 'email'>();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const permanent = !session.anonymous;
  const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const dialogRef = useModalFocus<HTMLDivElement>(true, force ? undefined : close);
  const authHeaders = { 'Content-Type': 'application/json', ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), 'x-visitor-id': session.visitorId };
  const google = async () => {
    if (linking) return;
    setLinking('google');
    setMessage('');
    try {
      const supabase = await getSupabase();
      if (!supabase) return setMessage('Account linking is temporarily unavailable. Guest play still works.');
      const { error } = session.anonymous ? await supabase.auth.linkIdentity({ provider: 'google', options: { redirectTo: window.location.href } }) : await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
      if (error) setMessage(friendlyAccountError(error));
    } catch {
      setMessage('Account linking is temporarily unavailable. Guest play still works.');
    } finally {
      setLinking(undefined);
    }
  };
  const emailLink = async () => {
    if (linking) return;
    if (!emailReady) return setMessage('Enter a valid email address first.');
    setLinking('email');
    setMessage('');
    try {
      const supabase = await getSupabase();
      if (!supabase) return setMessage('Account linking is temporarily unavailable. Guest play still works.');
      const { error } = session.anonymous ? await supabase.auth.updateUser({ email }) : await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
      setMessage(error ? friendlyAccountError(error) : 'Check your email to finish linking your account.');
    } catch {
      setMessage('Account linking is temporarily unavailable. Guest play still works.');
    } finally {
      setLinking(undefined);
    }
  };
  const saveProfile = async () => {
    if (saving) return;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch('/api/me/profile', { method: 'PUT', headers: authHeaders, body: JSON.stringify({ handle, displayName }) });
      if (!response.ok) return setMessage(await apiErrorMessage(response, 'Unable to save your profile right now.'));
      setMessage('Profile saved.');
      onSaved?.();
    } catch {
      setMessage('Profile service is temporarily unavailable. You can keep playing and try again later.');
    } finally {
      setSaving(false);
    }
  };
  return <motion.div ref={dialogRef} className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onPointerDown={() => !force && close()}>
    <motion.section className="account-panel glass" role="dialog" aria-modal="true" aria-labelledby="account-title" initial={{ y: 18 }} animate={{ y: 0 }} onPointerDown={(event) => event.stopPropagation()}>
      {!force && <button className="modal-close" aria-label="Close player panel" onClick={close}>×</button>}
      <p className="eyebrow">Player identity</p>
      <h2 id="account-title">{permanent ? force ? 'Choose your player handle' : 'Your Cambrio profile' : 'Save your wins'}</h2>
      {!permanent ? <>
        <p>Keep playing as a guest, or link this guest to an account. Wins already earned on this browser will come with you.</p>
        <button className={`google-button ${linking === 'google' ? 'is-pending' : ''}`} aria-busy={linking === 'google'} disabled={Boolean(linking)} onClick={() => void google()}>{linking === 'google' ? <span className="button-spinner" /> : null}{linking === 'google' ? 'Connecting…' : 'Continue with Google'}</button>
        <div className="or"><span>or use email</span></div>
        <div className="email-row"><input name="email" autoComplete="email" value={email} type="email" aria-invalid={Boolean(email) && !emailReady} placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /><button aria-busy={linking === 'email'} disabled={Boolean(linking) || !emailReady} onClick={() => void emailLink()}>{linking === 'email' ? 'Sending…' : 'Send link'}</button></div>
      </> : <>
        <p>Your unique handle creates your shareable public profile.</p>
        <label>Public handle<input name="handle" autoComplete="username" value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} placeholder="card_shark" /></label>
        <label>Display name<input name="displayName" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
        <button className={`primary wide ${saving ? 'is-pending' : ''}`} aria-busy={saving} disabled={saving || handle.length < 3 || displayName.trim().length < 2} onClick={() => void saveProfile()}>{saving && <span className="button-spinner" />}{saving ? 'Saving profile…' : 'Save public profile'}</button>
      </>}
      <div className="sound-settings" aria-label="Sound settings">
        <span><strong>Table sound</strong><small>Available on every device</small></span>
        <button className={audio.settings.effects ? 'active' : ''} aria-pressed={audio.settings.effects} onClick={audio.toggleEffects}>{audio.settings.effects ? <Volume2 size={16} /> : <VolumeX size={16} />} Effects</button>
        <button className={audio.settings.ambience ? 'active' : ''} aria-pressed={audio.settings.ambience} onClick={audio.toggleAmbience}><Waves size={16} /> Ambience</button>
      </div>
      {message && <p className="panel-message" role="status">{message}</p>}
      {onLeave && !force && <div className={`leave-table ${confirmLeave ? 'confirming' : ''}`}>{confirmLeave ? <><span><strong>Leave this table?</strong><small>You can rejoin later with the room link.</small></span><button onClick={() => setConfirmLeave(false)}>Stay</button><button className="danger" onClick={() => { close(); onLeave(); }}>Leave</button></> : <button className="leave-table-button" onClick={() => setConfirmLeave(true)}>Leave table</button>}</div>}
    </motion.section>
  </motion.div>;
}

function PublicProfile({ handle, onHome }: { handle: string; onHome: () => void }) {
  const [profile, setProfile] = useState<{ displayName?: string; handle: string; games: number; wins: number; winRate: number }>();
  const [status, setStatus] = useState<'loading' | 'missing' | 'unavailable'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setProfile(undefined);
    setStatus('loading');
    void fetch(`/api/profiles/${encodeURIComponent(handle)}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) return setStatus('missing');
        if (!response.ok) return setStatus('unavailable');
        setProfile(await response.json() as { displayName?: string; handle: string; games: number; wins: number; winRate: number });
      })
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('unavailable'); });
    return () => controller.abort();
  }, [handle, retry]);
  return <main className="profile-page"><button className="back-link" onClick={onHome}>← Cambrio</button>{status === 'missing' ? <div><h1>Player not found</h1><p>This profile does not exist or is not public.</p></div> : status === 'unavailable' ? <div><h1>Profile unavailable</h1><p>The profile service could not be reached. Your game is unaffected.</p><button onClick={() => setRetry((value) => value + 1)}>Try again</button></div> : !profile ? <div className="profile-loading" role="status" aria-live="polite"><div className="loader-cards" aria-hidden="true"><i /><i /><i /></div><p>Loading player profile…</p></div> : <section className="glass public-profile"><div className="profile-monogram">{(profile.displayName ?? profile.handle).slice(0, 2).toUpperCase()}</div><p className="eyebrow">Cambrio player</p><h1>{profile.displayName ?? profile.handle}</h1><p>@{profile.handle}</p><div className="stats-grid"><div><strong>{profile.wins}</strong><span>Wins</span></div><div><strong>{profile.games}</strong><span>Games</span></div><div><strong>{profile.winRate}%</strong><span>Win rate</span></div></div></section>}</main>;
}

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

function friendlyAccountError(error: { message?: string }): string {
  if (/rate|too many|wait/i.test(error.message ?? '')) return 'Too many account attempts. Wait a moment, then try again.';
  return 'Account linking could not start. Guest play still works, and you can try again later.';
}

function Toast({ notice }: { notice: ServerNotice }) { return <motion.div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live={notice.kind === 'error' ? 'assertive' : 'polite'} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}><span aria-hidden="true">{notice.kind === 'penalty' ? '!' : notice.kind === 'stack' ? '✓' : '•'}</span>{notice.message}</motion.div>; }
function isInlineNotice(notice: ServerNotice): boolean {
  return notice.message === 'The cards are dealt. Hold your two bottom cards to peek.'
    || notice.message === 'Back in the lobby. Ready up for another round.'
    || notice.kind === 'stack'
    || notice.kind === 'penalty'
    || notice.kind === 'cambio'
    || /^(Blind swap|Black King) · /.test(notice.message)
    || / swapped the draw into /.test(notice.message)
    || / gave a hidden card to /.test(notice.message);
}
function LoadingScreen({ label = 'Preparing the table…' }: { label?: string }) { return <main className="loading-screen" role="status" aria-live="polite"><div className="loader-cards" aria-hidden="true"><i /><i /><i /></div><p>{label}</p></main>; }
function FatalScreen({ message }: { message: string }) { return <main className="loading-screen" role="alert"><div className="fatal-mark" aria-hidden="true">!</div><h1>Couldn’t reach the table</h1><p>{message}</p><button onClick={() => window.location.reload()}>Try again</button></main>; }

type GameGlyphKind = 'cambio' | 'discard' | 'gift' | 'peek' | 'stack' | 'swap';

export function CambrioGlyph({ decorative = false, compact = false }: { decorative?: boolean; compact?: boolean }) {
  return <svg className={compact ? 'game-glyph' : 'cambrio-glyph'} viewBox="0 0 24 24" fill="none" role={decorative ? undefined : 'img'} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : 'Cambrio card'}>
    <rect x="4" y="6" width="9" height="12" rx="2" />
    <rect x="11" y="3" width="9" height="12" rx="2" />
    <path d="m6.5 10 2-2 2 2M17.5 11l-2 2-2-2" />
  </svg>;
}

function CardBackMark() {
  return <span className="card-back-mark" aria-hidden="true"><svg className="card-back-art" viewBox="0 0 48 64" fill="none"><path d="M12 21.5c3.2-5.1 7.1-7.6 12-7.6 5.3 0 9.4 2.6 12.4 7.8m-3.8-4.5 6.3-1.7-4.2-4.8M36 42.5c-3.2 5.1-7.1 7.6-12 7.6-5.3 0-9.4-2.6-12.4-7.8m3.8 4.5-6.3 1.7 4.2 4.8M24 24.2 31.8 32 24 39.8 16.2 32 24 24.2Z" /><path className="card-back-dots" d="M9 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm30 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM9 51.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm30 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" /></svg></span>;
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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

function useModalFocus<T extends HTMLElement>(active: boolean, onEscape?: () => void, preferred?: { current: HTMLElement | null }) {
  const root = useRef<T>(null);
  useEffect(() => {
    if (!active || !root.current) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusable = () => [...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null);
    const frame = window.requestAnimationFrame(() => (preferred?.current ?? focusable()[0])?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      window.requestAnimationFrame(() => previous?.focus());
    };
  }, [active, onEscape, preferred]);
  return root;
}

function friendlyActionMessage(result: ActionAck): string {
  if (result.code === 'STALE_STATE') return 'The table changed before that tap arrived. You’re synced—try once more.';
  if (result.code === 'STACK_CLOSED') return 'That stack race is over. Another move reached the table first.';
  if (result.code === 'RATE_LIMIT') return 'Too many quick taps. Give the table a moment, then try again.';
  if (result.code === 'GAME_PAUSED') return 'The round is paused until every remaining player is back.';
  if (result.code === 'ACTION_PENDING') return 'That action is already being sent.';
  return result.message ?? 'That action is not available now.';
}

function friendlyEntryMessage(message: string): string {
  if (/does not exist|expired/i.test(message)) return 'That room is no longer active. Check the code or ask the host for a fresh invite.';
  if (/full/i.test(message)) return 'That table is full. Join the queue to keep your place.';
  if (/reconnect|network|respond/i.test(message)) return 'The table could not be reached yet. Check your connection and try again.';
  return message;
}

function friendlyConnectionMessage(error?: Error): string {
  if (/unauthorized|forbidden|authentication/i.test(error?.message ?? '')) {
    return 'Your connection could not be verified. Reload to start a fresh guest session.';
  }
  return 'Cambrio could not connect to the game server. Check your connection, then try again.';
}

function readStoredName(): string {
  try {
    return localStorage.getItem('cambrio:name') ?? '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem('cambrio:name', name);
  } catch {
    // Remembering a convenience value must never block room entry.
  }
}

function ordinal(value: number): string {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? 'st' : value % 10 === 2 ? 'nd' : value % 10 === 3 ? 'rd' : 'th'}`;
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
