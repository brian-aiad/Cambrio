import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { ArrowRight, Check, Copy, Link2, UserRound, Volume2, VolumeX, Waves, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { io, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { MAX_HAND_CARDS, type CardView, type GameView, type PlayerView, type PowerKind } from '../shared/game.js';
import type { ActionAck, GameAction, RoomAction, RoomPlayerView, RoomView, ServerNotice } from '../shared/protocol.js';
import { ensureClientSession, getSupabase, type ClientSession } from './auth.js';
import { useGameAudio } from './audio.js';

const serverUrl = (import.meta.env.VITE_SERVER_URL as string | undefined) || window.location.origin;
type ClientSocket = Socket;
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
  const audio = useGameAudio();
  const audioRef = useRef(audio.playNotice);
  const pendingRoomActions = useRef(new Set<string>());
  const pendingGameActions = useRef(new Set<string>());
  useEffect(() => { audioRef.current = audio.playNotice; }, [audio.playNotice]);

  useEffect(() => {
    let active = true;
    void ensureClientSession().then((value) => active && setSession(value)).catch((error) => setFatal(error.message));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    const next = io(serverUrl, { auth: { token: session.token, visitorId: session.visitorId }, transports: ['websocket', 'polling'] });
    next.on('connect', () => setConnected(true));
    next.on('disconnect', () => setConnected(false));
    next.on('connect_error', (error) => setFatal(error.message));
    next.on('room:state', (state: RoomView) => {
      setRoom(state);
      const expectedPath = `/room/${state.code}`;
      if (window.location.pathname !== expectedPath) window.history.replaceState({}, '', expectedPath);
    });
    next.on('notice', (value: ServerNotice) => {
      setNotice(value);
      audioRef.current(value);
      window.setTimeout(() => setNotice((current) => current === value ? undefined : current), 3_500);
    });
    setSocket(next);
    return () => { next.disconnect(); };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const headers = new Headers(session.token ? { Authorization: `Bearer ${session.token}` } : { 'x-visitor-id': session.visitorId });
    void fetch('/api/me', { headers }).then((response) => response.json()).then((value) => setProfileReady(Boolean(value.handle))).catch(() => setProfileReady(false));
  }, [session]);

  const showActionError = useCallback((result: ActionAck) => {
    if (!result.ok) setNotice({ kind: 'error', message: result.message ?? 'That action is not available.' });
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
    if (!room?.game) return Promise.resolve<ActionAck>({ clientActionId: '', ok: false, message: 'No active game.' });
    const key = gameActionGroup(input.type);
    if (pendingGameActions.current.has(key)) return { clientActionId: 'pending', ok: false, code: 'ACTION_PENDING' };
    pendingGameActions.current.add(key);
    try {
      return showActionError(await emitAction(socket, 'game:action', { ...input, clientActionId: nanoid(), expectedVersion: room.game.version }));
    } finally {
      pendingGameActions.current.delete(key);
    }
  }, [room, showActionError, socket]);

  if (fatal) return <FatalScreen message={fatal} />;
  if (!session || !socket) return <LoadingScreen />;

  const profileMatch = window.location.pathname.match(/^\/u\/([a-z0-9_]+)$/);
  if (profileMatch && !room) return <PublicProfile handle={profileMatch[1]} onHome={() => { window.history.pushState({}, '', '/'); window.location.reload(); }} />;

  return (
    <div className="app-shell">
      <TopBar connected={connected} session={session} audio={audio} compact={Boolean(room?.game)} forceProfile={!session.anonymous && profileReady === false} onProfileSaved={() => setProfileReady(true)} />
      <AnimatePresence mode="wait">
        {!room ? (
          <Landing key="landing" connected={connected} send={sendRoom} initialCode={roomCodeFromPath()} />
        ) : room.phase === 'lobby' ? (
          <Lobby key="lobby" room={room} send={sendRoom} />
        ) : room.game ? (
          <GameTable key="game" room={room} send={sendGame} sendRoom={sendRoom} />
        ) : (
          <LoadingScreen key="waiting" label="Waiting for the next lobby…" />
        )}
      </AnimatePresence>
      <AnimatePresence>{notice && <Toast notice={notice} />}</AnimatePresence>
    </div>
  );
}

function TopBar({ connected, session, audio, compact, forceProfile, onProfileSaved }: { connected: boolean; session: ClientSession; audio: ReturnType<typeof useGameAudio>; compact: boolean; forceProfile: boolean; onProfileSaved: () => void }) {
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
      <AnimatePresence>{(open || forceProfile) && <AccountPanel session={session} close={() => setOpen(false)} force={forceProfile} onSaved={onProfileSaved} />}</AnimatePresence>
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
          <button className="primary wide" disabled={busy || name.trim().length < 2} onClick={() => void submit('join')}>Join room <ArrowRight size={17} /></button>
        ) : (
          <>
            <button className="primary wide" disabled={busy || name.trim().length < 2} onClick={() => void submit('create')}>Create private room <ArrowRight size={17} /></button>
            <div className="or"><span>or join with a code</span></div>
            <div className="code-row"><input name="roomCode" aria-label="Room code" className="code-input" value={code} maxLength={8} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD2345" /><button disabled={busy || code.length !== 8 || name.trim().length < 2} onClick={() => void submit('join')}>Join</button></div>
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
  const copy = async () => { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  return (
    <motion.main className="lobby page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
      <section className="lobby-heading"><div><p className="eyebrow">Private table</p><h1>Room <span>{room.code}</span></h1><p>Share the link, ready up, then the host deals.</p></div><button className="share-button" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied!' : 'Copy invite link'}</button></section>
      <div className="lobby-grid">
        <section className="glass player-list"><div className="section-heading"><h2>Players</h2><span>{room.players.length}/8 seated</span></div>{room.players.map((player) => <LobbyPlayer key={player.id} player={player} self={player.id === room.selfPlayerId} canRemove={Boolean(isHost && player.id !== room.selfPlayerId)} remove={() => void send({ type: 'ROOM_REMOVE', playerId: player.id })} />)}</section>
        <aside className="glass lobby-rules"><p className="eyebrow">Round briefing</p><h2>Low score wins.</h2><ul><li>Peek at your two bottom cards once.</li><li>Draw, discard, or trade into your hand.</li><li>Stack matching ranks—even from another hand.</li><li>Call Cambrio when the moment feels right.</li></ul><p className="king-note">Red Kings <strong>−1</strong></p></aside>
      </div>
      <div className="lobby-footer">
        {!isHost && self && <button className={self.ready ? 'secondary ready' : 'primary'} onClick={() => void send({ type: 'ROOM_READY', ready: !self.ready })}>{self.ready && <Check size={16} />}{self.ready ? 'Ready' : 'Ready up'}</button>}
        {isHost && <button className="primary deal" disabled={!allReady} onClick={() => void send({ type: 'ROOM_START' })}>{allReady ? 'Deal the cards' : room.players.length < 2 ? 'Waiting for players' : 'Waiting for ready players'}</button>}
      </div>
    </motion.main>
  );
}

function LobbyPlayer({ player, self, canRemove, remove }: { player: RoomPlayerView; self: boolean; canRemove: boolean; remove: () => void }) {
  const initials = player.name.slice(0, 2).toUpperCase();
  return <div className={`lobby-player ${!player.connected ? 'offline' : ''}`}><div className="avatar">{initials}</div><div className="player-info"><strong>{player.name}{self ? ' (you)' : ''}</strong><span>{player.handle ? <a href={`/u/${player.handle}`}>@{player.handle}</a> : 'Guest player'} · {player.stats?.wins ?? 0} wins</span></div>{player.isHost ? <span className="host-badge">HOST</span> : <span className={`ready-dot ${player.ready ? 'yes' : ''}`}>{player.ready ? 'READY' : 'WAITING'}</span>}{canRemove && <button className="remove-player" onClick={remove} aria-label={`Remove ${player.name}`}><X size={15} /></button>}</div>;
}

export function GameTable({ room, send, sendRoom }: { room: RoomView; send: (action: GameActionInput) => Promise<ActionAck>; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const game = room.game!;
  const self = game.players.find((player) => player.id === room.selfPlayerId)!;
  const [revealVisible, setRevealVisible] = useState(false);
  const [inspectedKing, setInspectedKing] = useState(false);
  const [stackFeedback, setStackFeedback] = useState<{ cardId: string; kind: StackFeedback }>();
  const [tableCue, setTableCue] = useState<TableCue>();
  const feedbackTimer = useRef<number | undefined>(undefined);
  const cueTimer = useRef<number | undefined>(undefined);
  const sendRef = useRef(send);
  const motionSnapshot = useRef<TableSnapshot | undefined>(undefined);

  useEffect(() => () => { window.clearTimeout(feedbackTimer.current); window.clearTimeout(cueTimer.current); }, []);
  useEffect(() => { sendRef.current = send; }, [send]);
  useLayoutEffect(() => {
    const current = snapshotTable(game);
    const previous = motionSnapshot.current;
    motionSnapshot.current = current;
    if (!previous) return;
    const moved = [...current.locations.entries()].filter(([cardId, location]) => {
      const before = previous.locations.get(cardId);
      return before && before.playerId !== location.playerId;
    });
    let cue: TableCue | undefined;
    if (moved.length >= 2) {
      const movements = moved.slice(0, 2).map(([cardId, destination]) => ({ cardId, from: previous.locations.get(cardId)!, to: destination }));
      cue = { id: game.version, kind: 'exchange', title: previous.powerKind === 'black_king' ? 'Black King swap' : 'Blind swap', movements, from: locationLabel(movements[0].from), to: locationLabel(movements[0].to) };
    } else if (moved.length === 1) {
      const [cardId, destination] = moved[0];
      const source = previous.locations.get(cardId)!;
      const movements = [{ cardId, from: source, to: destination }];
      cue = { id: game.version, kind: 'transfer', title: 'Card transfer', movements, from: locationLabel(source), to: locationLabel(destination) };
    } else if (current.discardId && current.discardId !== previous.discardId) {
      const source = previous.locations.get(current.discardId);
      if (source) {
        const kind = previous.stackOpen ? 'stack' : 'discard';
        const discard: TableLocation = { zone: 'discard' };
        cue = { id: game.version, kind, title: kind === 'stack' ? 'Card stacked' : 'Card swapped', movements: [{ cardId: current.discardId, from: source, to: discard, face: game.discard }], from: locationLabel(source), to: 'Discard' };
      }
    }
    if (!cue) return;
    setTableCue(cue);
    window.clearTimeout(cueTimer.current);
    cueTimer.current = window.setTimeout(() => setTableCue(undefined), cue.kind === 'exchange' ? 2_100 : 1_650);
  // A new authoritative game version is the animation trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.version]);
  const revealKey = game.power?.status === 'revealing' ? `${game.power.kind}:${game.power.targets.join(':')}` : '';
  useEffect(() => {
    if (!revealKey || game.power?.status !== 'revealing') {
      setRevealVisible(false);
      setInspectedKing(false);
      return;
    }
    let finished = false;
    setRevealVisible(true);
    setInspectedKing(false);
    const finish = () => {
      if (finished) return;
      finished = true;
      setRevealVisible(false);
      if (game.power?.kind === 'black_king') setInspectedKing(true);
      else void sendRef.current({ type: 'POWER_COMPLETE' });
    };
    const timer = window.setTimeout(finish, 1_700);
    window.addEventListener('blur', finish);
    return () => { window.clearTimeout(timer); window.removeEventListener('blur', finish); };
  // revealKey represents a new server-approved private reveal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealKey]);

  if (game.phase === 'initial_peek') return <InitialPeek game={game} self={self} send={send} />;
  if (game.phase === 'results') return <Results room={room} game={game} sendRoom={sendRoom} />;

  const opponents = game.players.filter((player) => player.id !== self.id && !player.forfeited);
  const isTurn = game.activePlayerId === self.id;
  const power = isTurn ? game.power : undefined;
  const selectingPower = power?.status === 'selecting';
  const transferring = game.transfer?.fromPlayerId === self.id;
  const canSwapDrawn = isTurn && game.turnStage === 'deciding' && Boolean(game.drawnCard) && self.cards.length > 0;
  const canRiskStack = self.cards.length > 0 && self.cards.length < MAX_HAND_CARDS;
  const stackReady = game.stackOpen && canRiskStack && !transferring && !selectingPower;
  const stackBlockedByLimit = game.stackOpen && self.cards.length >= MAX_HAND_CARDS && !transferring && !selectingPower;
  const endingPlayer = game.ending ? game.players.find((player) => player.id === game.ending?.triggerPlayerId) : undefined;

  const attemptStack = async (card: CardView) => {
    if (stackFeedback?.kind === 'trying') return;
    setStackFeedback({ cardId: card.id, kind: 'trying' });
    const result = await send({ type: 'STACK_ATTEMPT', targetCardId: card.id, discardGeneration: game.discardGeneration });
    const kind: StackFeedback = result.outcome === 'stack' ? 'correct' : result.outcome === 'penalty' ? 'wrong' : 'closed';
    vibrate(kind === 'correct' ? 32 : kind === 'wrong' ? [18, 35, 18] : 12);
    setStackFeedback({ cardId: card.id, kind });
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setStackFeedback(undefined), kind === 'wrong' ? 1_500 : 1_100);
  };
  const actionCard = (card: CardView, owner: PlayerView) => {
    if (transferring && owner.id === self.id) { vibrate(10); return void send({ type: 'TRANSFER_CARD', cardId: card.id }); }
    if (selectingPower) { vibrate(10); return void send({ type: 'POWER_SELECT', targetCardId: card.id }); }
    if (canSwapDrawn && owner.id === self.id) { vibrate(14); return void send({ type: 'SWAP_DRAWN', targetCardId: card.id }); }
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

  return (
    <LayoutGroup id={`table-${game.id}`}>
    <motion.main className={`game-page ${stackReady ? 'stack-mode' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="game-status"><span className="room-pill" data-short={room.code.slice(0, 2)}>{room.code}</span><TurnBanner game={game} self={self} /><Countdown deadline={game.deadlineAt} /></div>
      {game.ending && <div className="ending-banner"><strong>{game.ending.reason === 'cambio' ? 'CAMBRIO CALLED' : 'ZERO CARDS'}</strong><span>{endingPlayer?.name ? `${endingPlayer.name} · ` : ''}{game.ending.turnsRemaining === 0 ? 'Final turn' : `${game.ending.turnsRemaining} ${game.ending.turnsRemaining === 1 ? 'turn' : 'turns'} after this one`}</span></div>}

      <section className="opponent-rail" aria-label="Other players" style={{ '--opponent-count': Math.max(1, opponents.length) } as CSSProperties}>
        {opponents.map((opponent) => <PlayerHand key={opponent.id} player={opponent} compact canInteract={() => canInteract(opponent)} highlight={() => isContextTarget(opponent)} selectedCards={power?.targets} arrivingSlots={flightSlots(tableCue, opponent.id)} feedback={stackFeedback} reveal={revealVisible} onCard={(card) => actionCard(card, opponent)} active={game.activePlayerId === opponent.id} />)}
      </section>

      <section className="table-center">
        <div className="pile-zone">
          <div className={`pile ${tableCue?.movements.some((movement) => movement.to.zone === 'discard') ? 'receiving-flight' : ''}`} data-table-zone="discard"><Card card={game.discard} faceDown={!game.discard} /><span>{game.discard ? 'DISCARD' : 'EMPTY'}</span></div>
          <button className={`deck-card ${isTurn && game.turnStage === 'awaiting_draw' ? 'draw-ready' : ''}`} disabled={!isTurn || game.turnStage !== 'awaiting_draw' || Boolean(game.transfer)} onClick={() => { vibrate(10); void send({ type: 'DRAW' }); }} title={`Draw from deck; ${game.deckCount} cards remain`}><CardBackMark /><small>{game.deckCount}</small></button>
        </div>
        <AnimatePresence mode="wait">
          {game.drawnCard ? <motion.div key="drawn" className="drawn-panel" initial={{ opacity: 0, x: 34, scale: .94 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: -18, scale: .97 }} transition={{ duration: .2, ease: [0.22, 1, 0.36, 1] }}><span>DRAWN</span><Card card={game.drawnCard} /><div className="drawn-actions"><button className="primary discard-drawn" onClick={() => { vibrate(12); void send({ type: 'DISCARD_DRAWN' }); }}><GameGlyph kind="discard" />Discard</button>{self.cards.length > 0 && <small>or tap a glowing slot to keep it</small>}</div></motion.div> : stackReady ? <motion.div key="stack-open" className="stack-hint" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .1 }}><GameGlyph kind="stack" /><strong>STACK OPEN</strong><span>Tap any remembered matching card</span></motion.div> : stackBlockedByLimit ? <motion.div key="stack-limit" className="stack-hint limit" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .1 }}><GameGlyph kind="stack" /><strong>6-CARD LIMIT</strong><span>Reduce your hand before stacking again</span></motion.div> : null}
        </AnimatePresence>
      </section>

      <section className="self-zone"><PlayerHand player={self} canInteract={() => canInteract(self)} highlight={() => isContextTarget(self)} selectedCards={power?.targets} arrivingSlots={flightSlots(tableCue, self.id)} feedback={stackFeedback} reveal={revealVisible} onCard={(card) => actionCard(card, self)} active={isTurn} /><span className="you-label">YOU · {self.cards.length ? `${self.cards.length}/${MAX_HAND_CARDS} CARDS` : 'OUT'}</span></section>
      <div className="game-actions">{!game.ending && <button className="cambio-button" onClick={() => { vibrate(24); void send({ type: 'CALL_CAMBIO' }); }}><GameGlyph kind="cambio" />Call Cambrio</button>}</div>
      <AnimatePresence>{stackFeedback && stackFeedback.kind !== 'trying' && <motion.div className={`stack-result ${stackFeedback.kind}`} initial={{ opacity: 0, scale: .8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, y: -8 }}>{stackFeedback.kind === 'correct' ? 'MATCH — STACKED' : stackFeedback.kind === 'wrong' ? 'NO MATCH — PENALTY CARD' : 'STACK ALREADY TAKEN'}</motion.div>}</AnimatePresence>
      <AnimatePresence>{tableCue && <SwapFlightLayer key={`flight-${tableCue.id}`} cue={tableCue} />}</AnimatePresence>
      <AnimatePresence>{tableCue && tableCue.kind !== 'stack' && <TableActionCue key={`cue-${tableCue.id}`} cue={tableCue} />}</AnimatePresence>
      <InteractionOverlay game={game} self={self} revealVisible={revealVisible} inspectedKing={inspectedKing} send={send} />
    </motion.main>
    </LayoutGroup>
  );
}

function InitialPeek({ game, self, send }: { game: GameView; self: PlayerView; send: (action: GameActionInput) => Promise<ActionAck> }) {
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false);
  const begin = () => {
    if (self.initialPeekComplete) return;
    vibrate(8);
    holdingRef.current = true;
    setHolding(true);
    void send({ type: 'INITIAL_PEEK_START' });
  };
  const end = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    void send({ type: 'INITIAL_PEEK_END' });
  }, [send]);
  useEffect(() => {
    window.addEventListener('blur', end);
    return () => window.removeEventListener('blur', end);
  }, [end]);
  return (
    <main className="peek-screen">
      <div className="peek-copy"><p className="eyebrow">One look. Then remember.</p><h1>Your bottom two cards</h1><p>Hold below to see bottom left and bottom right. Their positions will never shift.</p></div>
      <div className="peek-hand">{self.cards.map((card) => <div className="hand-slot" key={card.id} style={{ gridColumn: card.slot % 2 + 1, gridRow: Math.floor(card.slot / 2) + 1 }}><Card card={card} faceDown={!holding || card.slot < 2} positioned slot={card.slot} /></div>)}</div>
      {self.initialPeekComplete ? <div className="waiting-ready"><span className="spinner" />Waiting for everyone…</div> : <button className="hold-button" onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onPointerLeave={end}><GameGlyph kind="peek" />Hold to peek</button>}
      <div className="ready-progress">{game.players.filter((player) => player.initialPeekComplete).length}/{game.players.length} ready</div>
    </main>
  );
}

function InteractionOverlay({ game, self, revealVisible, inspectedKing, send }: { game: GameView; self: PlayerView; revealVisible: boolean; inspectedKing: boolean; send: (action: GameActionInput) => Promise<ActionAck> }) {
  if (game.transfer?.fromPlayerId === self.id) return <div className="interaction-prompt"><span className="ability-chip"><GameGlyph kind="gift" />STACK REWARD</span><strong>Tap one of your cards to give away</strong></div>;
  const power = game.power;
  if (!power || game.activePlayerId !== self.id) return null;
  if (power.status === 'offered') return <div className="interaction-prompt"><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{powerName(power.kind)}</span><strong>{powerDescription(power.kind)}</strong><button className="text-button" onClick={() => void send({ type: 'POWER_DECLINE' })}>Skip ability</button></div>;
  if (power.status === 'selecting') return <div className="interaction-prompt"><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{powerName(power.kind)}</span><strong>{powerTargetInstruction(power.kind, power.targets.length, self.cards.length)}</strong><button className="text-button" onClick={() => void send({ type: 'POWER_DECLINE' })}>Skip ability</button></div>;
  const blackKing = power.kind === 'black_king';
  return <div className={`interaction-prompt power-prompt ${revealVisible ? 'is-revealing' : ''}`}><span className="ability-chip"><GameGlyph kind={powerGlyph(power.kind)} />{blackKing ? 'BLACK KING' : powerName(power.kind)}</span>{!inspectedKing ? <div className="reveal-status"><GameGlyph kind="peek" /><strong>Memorize {blackKing ? 'both cards' : 'this card'}</strong><span className="reveal-progress" /></div> : <div className="power-choice"><strong>Swap positions?</strong><button className="primary" disabled={power.targets.length < 2} onClick={() => void send({ type: 'POWER_COMPLETE', swap: true })}><GameGlyph kind="swap" />Swap</button><button onClick={() => void send({ type: 'POWER_COMPLETE', swap: false })}>Keep</button></div>}</div>;
}

function Results({ room, game, sendRoom }: { room: RoomView; game: GameView; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const rows = game.results!.map((result) => ({ result, player: game.players.find((player) => player.id === result.playerId)! })).sort((a, b) => (a.result.score ?? 999) - (b.result.score ?? 999));
  const winnerNames = rows.filter((row) => row.result.winner).map((row) => row.player.name).join(' & ');
  const isHost = room.hostPlayerId === room.selfPlayerId;
  return <motion.main className="results-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><p className="eyebrow">Round complete</p><h1>{winnerNames} {rows.filter((row) => row.result.winner).length > 1 ? 'win' : 'wins'}!</h1><p>Lowest score takes the table.</p><section className="results-list glass">{rows.map(({ player, result }, index) => <div key={player.id} className={`result-row ${result.winner ? 'winner' : ''}`}><span className="place">{result.forfeited ? '—' : index + 1}</span><div><strong>{player.name}{player.id === room.selfPlayerId ? ' (you)' : ''}</strong><div className="result-cards">{player.cards.map((card) => <Card key={card.id} card={card} mini />)}</div></div><strong className="score">{result.score ?? 'Forfeit'}</strong></div>)}</section>{isHost ? <button className="primary deal" onClick={() => void sendRoom({ type: 'ROOM_REMATCH' })}>Return to lobby</button> : <p className="waiting-host">Waiting for the host to return to the lobby…</p>}</motion.main>;
}

type StackFeedback = 'trying' | 'correct' | 'wrong' | 'closed';
type HandLocation = { zone: 'hand'; playerId: string; playerName: string; slot: number };
type TableLocation = HandLocation | { zone: 'discard' };
type TableMovement = { cardId: string; from: TableLocation; to: TableLocation; face?: CardView };
type TableCue = { id: number; kind: 'exchange' | 'transfer' | 'discard' | 'stack'; title: string; from: string; to: string; movements: TableMovement[] };
type TableSnapshot = { locations: Map<string, HandLocation>; discardId?: string; powerKind?: PowerKind; stackOpen: boolean };

function snapshotTable(game: GameView): TableSnapshot {
  return {
    locations: new Map(game.players.flatMap((player) => player.cards.map((card) => [card.id, { zone: 'hand', playerId: player.id, playerName: player.name, slot: card.slot }] as const))),
    discardId: game.discard?.id,
    powerKind: game.power?.kind,
    stackOpen: game.stackOpen,
  };
}

function locationLabel(location: TableLocation): string {
  return location.zone === 'discard' ? 'Discard' : `${location.playerName} ${slotTag(location.slot)}`;
}

function flightSlots(cue: TableCue | undefined, playerId: string): number[] {
  return cue?.movements.flatMap((movement) => movement.to.zone === 'hand' && movement.to.playerId === playerId ? [movement.to.slot] : []) ?? [];
}

type FlightGeometry = { cardId: string; from: DOMRect; to: DOMRect; fromLabel: string; toLabel: string; face?: CardView };

function SwapFlightLayer({ cue }: { cue: TableCue }) {
  const [flights, setFlights] = useState<FlightGeometry[]>([]);
  useLayoutEffect(() => {
    const measured = cue.movements.flatMap((movement) => {
      const from = locationRect(movement.from);
      const to = locationRect(movement.to);
      return from && to ? [{ cardId: movement.cardId, from, to, fromLabel: locationLabel(movement.from), toLabel: locationLabel(movement.to), face: movement.face }] : [];
    });
    setFlights(measured);
  }, [cue]);
  if (!flights.length) return null;
  return <motion.div className={`swap-flight-layer ${cue.kind}`} initial={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true">
    {flights.map((flight, index) => {
      const middleLeft = (flight.from.left + flight.to.left) / 2 + (index === 0 ? -16 : 16);
      const middleTop = (flight.from.top + flight.to.top) / 2 + (index === 0 ? -34 : 34);
      return <motion.span key={flight.cardId} className={`card-flight flight-${index + 1}`} data-flight-card={flight.cardId}
        initial={{ left: flight.from.left, top: flight.from.top, width: flight.from.width, height: flight.from.height, rotate: index === 0 ? -2 : 2, scale: 1 }}
        animate={{ left: [flight.from.left, middleLeft, flight.to.left], top: [flight.from.top, middleTop, flight.to.top], width: [flight.from.width, Math.max(30, (flight.from.width + flight.to.width) / 2), flight.to.width], height: [flight.from.height, Math.max(42, (flight.from.height + flight.to.height) / 2), flight.to.height], rotate: index === 0 ? [-2, -8, 0] : [2, 8, 0], scale: [1, 1.08, 1] }}
        transition={{ duration: 1.12, times: [0, .5, 1], ease: [0.22, 1, 0.36, 1] }}><span className="flight-surface flight-back"><CardBackMark /></span>{flight.face?.rank && flight.face.suit && <span className="flight-surface flight-front"><strong>{flight.face.rank}</strong><SuitMark suit={flight.face.suit} /></span>}<b>{index + 1}</b></motion.span>;
    })}
    {flights.map((flight) => <motion.span key={`endpoint-${flight.cardId}`} className="flight-endpoint" style={{ left: flight.from.left, top: flight.from.top, width: flight.from.width, height: flight.from.height }} initial={{ opacity: 0, scale: .86 }} animate={{ opacity: [0, 1, 1, 0], scale: [0.86, 1.07, 1.02, 1] }} transition={{ duration: 1.3, times: [0, .12, .72, 1] }}><em>{flight.fromLabel}</em></motion.span>)}
  </motion.div>;
}

function locationRect(location: TableLocation): DOMRect | undefined {
  if (location.zone === 'discard') return document.querySelector<HTMLElement>('[data-table-zone="discard"] .playing-card')?.getBoundingClientRect();
  return document.querySelector<HTMLElement>(`.hand-slot[data-player-id="${location.playerId}"][data-slot="${location.slot}"]`)?.getBoundingClientRect();
}

function TableActionCue({ cue }: { cue: TableCue }) {
  return <motion.div className={`table-action-cue ${cue.kind}`} initial={{ opacity: 0, y: 10, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, transition: { duration: .12 } }} transition={{ delay: .42, duration: .18 }}>
    <span className="cue-cards" aria-hidden="true"><i /><i /></span>
    <span><strong>{cue.title}</strong><small>{cue.from} <b>{cue.kind === 'exchange' ? '↔' : '→'}</b> {cue.to}</small></span>
  </motion.div>;
}

function PlayerHand({ player, compact = false, canInteract, highlight, selectedCards = [], arrivingSlots = [], feedback, reveal = false, active = false, onCard }: { player: PlayerView; compact?: boolean; canInteract?: (card: CardView) => boolean; highlight?: (card: CardView) => boolean; selectedCards?: string[]; arrivingSlots?: number[]; feedback?: { cardId: string; kind: StackFeedback }; reveal?: boolean; active?: boolean; onCard: (card: CardView) => void }) {
  const highestSlot = player.cards.reduce((highest, card) => Math.max(highest, card.slot), 3);
  const slotCount = Math.max(4, highestSlot + 1);
  const cardsBySlot = new Map(player.cards.map((card) => [card.slot, card]));
  return <div className={`player-hand ${compact ? 'compact' : ''} ${active ? 'active-turn' : ''}`}>
    <div className="seat-name"><span>{player.name}</span>{!player.connected && <i>OFFLINE</i>}</div>
    <div className="hand-cards" aria-label={`${player.name}'s cards`}>
      {Array.from({ length: slotCount }, (_, slot) => {
        const card = cardsBySlot.get(slot);
        return <div className={`hand-slot ${card ? '' : 'vacant'} ${arrivingSlots.includes(slot) ? 'flight-receiving' : ''}`} key={slot} data-player-id={player.id} data-slot={slot} data-position={slotTag(slot)}>{card ? <Card card={card} faceDown={!reveal} positioned slot={slot} targetOption={highlight?.(card)} selected={selectedCards.includes(card.id)} feedback={feedback?.cardId === card.id ? feedback.kind : undefined} interactive={canInteract?.(card)} onClick={() => onCard(card)} /> : <span className="vacant-marker" aria-hidden="true" />}</div>;
      })}
      {player.cards.length === 0 && <div className="out-badge">OUT</div>}
    </div>
  </div>;
}

export function Card({ card, faceDown = false, interactive = false, mini = false, positioned = false, targetOption = false, selected = false, feedback, slot, label, onClick }: { card?: CardView; faceDown?: boolean; interactive?: boolean; mini?: boolean; positioned?: boolean; targetOption?: boolean; selected?: boolean; feedback?: StackFeedback; slot?: number; label?: string; onClick?: () => void }) {
  const hidden = faceDown || !card?.rank;
  const red = card?.suit === 'hearts' || card?.suit === 'diamonds';
  const actualSlot = slot ?? card?.slot;
  const description = !card ? 'Empty discard pile' : hidden ? `${actualSlot === undefined || actualSlot < 0 ? 'Hidden' : slotName(actualSlot)} card${interactive ? '; tap to select' : ''}` : `${card.rank} of ${card.suit}${interactive ? '; tap to select' : ''}`;
  return <motion.button data-card-id={card?.id} data-slot={actualSlot} layout="position" layoutId={card ? `card-${card.id}` : undefined} initial={{ opacity: 0, y: hidden ? -8 : 0, scale: .96 }} title={description} aria-label={description} className={`playing-card ${hidden ? 'face-down' : ''} ${red ? 'red' : ''} ${interactive ? 'interactive' : ''} ${targetOption ? 'target-option' : ''} ${mini ? 'mini' : ''} ${positioned ? 'positioned' : ''} ${selected ? 'selected' : ''} ${feedback ? `stack-${feedback}` : ''} ${!card ? 'empty' : ''}`} disabled={!interactive} onClick={onClick} animate={feedback === 'wrong' ? { opacity: 1, y: 0, x: [0, -7, 7, -5, 5, 0], rotate: [0, -1.4, 1.4, -.8, .8, 0] } : feedback === 'correct' ? { opacity: 1, y: 0, scale: [1, 1.08, 1] } : { opacity: 1, y: 0, scale: 1 }} transition={feedback ? { duration: .38, ease: 'easeOut' } : { layout: { type: 'spring', stiffness: 190, damping: 23, mass: .9 }, opacity: { duration: .16 } }} whileHover={interactive ? { y: -3 } : undefined} whileTap={interactive ? { scale: .96 } : undefined}>
    <AnimatePresence initial={false} mode="popLayout">
      {hidden ? <motion.span key="back" className="card-surface card-reverse" initial={{ opacity: 0, rotateY: -88 }} animate={{ opacity: 1, rotateY: 0 }} exit={{ opacity: 0, rotateY: 88 }} transition={{ duration: .22, ease: [0.22, 1, 0.36, 1] }}><CardBackMark /></motion.span> : <motion.span key="front" className="card-surface card-front" initial={{ opacity: 0, rotateY: 88 }} animate={{ opacity: 1, rotateY: 0 }} exit={{ opacity: 0, rotateY: -88 }} transition={{ duration: .22, ease: [0.22, 1, 0.36, 1] }}><span className="corner" data-rank={card!.rank}><b>{card!.rank}</b><SuitMark suit={card!.suit!} /></span><SuitMark suit={card!.suit!} className="center-suit" /></motion.span>}
    </AnimatePresence>
    {positioned && actualSlot !== undefined && <span className="slot-tag">{slotTag(actualSlot)}</span>}
    {label && <em>{label}</em>}
  </motion.button>;
}

function TurnBanner({ game, self }: { game: GameView; self: PlayerView }) {
  const active = game.players.find((player) => player.id === game.activePlayerId);
  if (game.transfer) return <div className="turn-banner"><strong>Card transfer</strong><span>Finish the successful stack</span></div>;
  return <div className={`turn-banner ${active?.id === self.id ? 'your-turn' : ''}`}><strong>{active?.id === self.id ? 'Your turn' : `${active?.name ?? 'Player'}'s turn`}</strong><span>{game.turnStage === 'awaiting_draw' ? 'Draw from the deck' : game.turnStage === 'deciding' ? 'Discard or swap' : 'Resolving a power'}</span></div>;
}

function Countdown({ deadline }: { deadline?: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const update = () => setSeconds(Math.max(0, Math.ceil(((deadline ?? Date.now()) - Date.now()) / 1000))); update(); const timer = window.setInterval(update, 250); return () => clearInterval(timer); }, [deadline]);
  return <span className={`countdown ${seconds <= 10 ? 'urgent' : ''}`}>{seconds}s</span>;
}

function AccountPanel({ session, close, force = false, onSaved }: { session: ClientSession; close: () => void; force?: boolean; onSaved?: () => void }) {
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('cambrio:name') ?? '');
  const [message, setMessage] = useState('');
  const permanent = !session.anonymous;
  const authHeaders = { 'Content-Type': 'application/json', ...(session.token ? { Authorization: `Bearer ${session.token}` } : {}), 'x-visitor-id': session.visitorId };
  const google = async () => { const supabase = await getSupabase(); if (!supabase) return setMessage('Connect Supabase to enable accounts.'); const { error } = session.anonymous ? await supabase.auth.linkIdentity({ provider: 'google', options: { redirectTo: window.location.href } }) : await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } }); if (error) setMessage(error.message); };
  const emailLink = async () => { const supabase = await getSupabase(); if (!supabase) return setMessage('Connect Supabase to enable accounts.'); const { error } = session.anonymous ? await supabase.auth.updateUser({ email }) : await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } }); setMessage(error ? error.message : 'Check your email to finish linking your account.'); };
  const saveProfile = async () => { const response = await fetch('/api/me/profile', { method: 'PUT', headers: authHeaders, body: JSON.stringify({ handle, displayName }) }); const body = await response.json(); setMessage(response.ok ? 'Profile saved.' : body.error); if (response.ok) onSaved?.(); };
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => !force && close()}><motion.section className="account-panel glass" initial={{ y: 18 }} animate={{ y: 0 }} onMouseDown={(event) => event.stopPropagation()}>{!force && <button className="modal-close" onClick={close}>×</button>}<p className="eyebrow">Player identity</p><h2>{permanent ? force ? 'Choose your player handle' : 'Your Cambrio profile' : 'Save your wins'}</h2>{!permanent ? <><p>Keep playing as a guest, or link this guest to an account. Wins already earned on this browser will come with you.</p><button className="google-button" onClick={() => void google()}>Continue with Google</button><div className="or"><span>or use email</span></div><div className="email-row"><input name="email" autoComplete="email" value={email} type="email" placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /><button onClick={() => void emailLink()}>Send link</button></div></> : <><p>Your unique handle creates your shareable public profile.</p><label>Public handle<input name="handle" autoComplete="username" value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} placeholder="card_shark" /></label><label>Display name<input name="displayName" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><button className="primary wide" disabled={handle.length < 3 || displayName.trim().length < 2} onClick={() => void saveProfile()}>Save public profile</button></>}{message && <p className="panel-message">{message}</p>}</motion.section></motion.div>;
}

function PublicProfile({ handle, onHome }: { handle: string; onHome: () => void }) {
  const [profile, setProfile] = useState<{ displayName?: string; handle: string; games: number; wins: number; winRate: number }>();
  const [missing, setMissing] = useState(false);
  useEffect(() => { void fetch(`/api/profiles/${handle}`).then(async (response) => { if (!response.ok) setMissing(true); else setProfile(await response.json()); }); }, [handle]);
  return <main className="profile-page"><button className="back-link" onClick={onHome}>← Cambrio</button>{missing ? <div><h1>Player not found</h1><p>This profile may be private or unavailable.</p></div> : !profile ? <LoadingScreen /> : <section className="glass public-profile"><div className="profile-monogram">{(profile.displayName ?? profile.handle).slice(0, 2).toUpperCase()}</div><p className="eyebrow">Cambrio player</p><h1>{profile.displayName ?? profile.handle}</h1><p>@{profile.handle}</p><div className="stats-grid"><div><strong>{profile.wins}</strong><span>Wins</span></div><div><strong>{profile.games}</strong><span>Games</span></div><div><strong>{profile.winRate}%</strong><span>Win rate</span></div></div></section>}</main>;
}

function Toast({ notice }: { notice: ServerNotice }) { return <motion.div className={`toast ${notice.kind}`} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}><span>{notice.kind === 'penalty' ? '!' : notice.kind === 'stack' ? '✓' : '•'}</span>{notice.message}</motion.div>; }
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
function powerDescription(power: PowerKind): string { return power === 'own_peek' ? 'Look at one of your hidden cards.' : power === 'opponent_peek' ? "Look at one opponent's hidden card." : power === 'blind_swap' ? 'Trade one of your cards with an opponent—without looking.' : 'Read one of yours and one of theirs, then choose whether to swap.'; }
function powerTargetInstruction(power: PowerKind, selected: number, ownCount: number): string { if (power === 'own_peek') return 'Choose one of your cards'; if (power === 'opponent_peek' || (power === 'black_king' && ownCount === 0)) return "Choose an opponent's card"; if (selected === 0) return 'Choose one of your cards'; return "Now choose an opponent's card"; }
