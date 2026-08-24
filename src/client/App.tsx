import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import type { CardView, GameView, PlayerView, PowerKind } from '../shared/game.js';
import type { ActionAck, GameAction, RoomAction, RoomPlayerView, RoomView, ServerNotice } from '../shared/protocol.js';
import { ensureClientSession, supabase, type ClientSession } from './auth.js';
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
  const sendRoom = useCallback(async (input: RoomActionInput) => showActionError(await emitAction(socket, 'room:action', { ...input, clientActionId: nanoid() })), [showActionError, socket]);
  const sendGame = useCallback((input: GameActionInput) => {
    if (!room?.game) return Promise.resolve<ActionAck>({ clientActionId: '', ok: false, message: 'No active game.' });
    return emitAction(socket, 'game:action', { ...input, clientActionId: nanoid(), expectedVersion: room.game.version }).then(showActionError);
  }, [room, showActionError, socket]);

  if (fatal) return <FatalScreen message={fatal} />;
  if (!session || !socket) return <LoadingScreen />;

  const profileMatch = window.location.pathname.match(/^\/u\/([a-z0-9_]+)$/);
  if (profileMatch && !room) return <PublicProfile handle={profileMatch[1]} onHome={() => { window.history.pushState({}, '', '/'); window.location.reload(); }} />;

  return (
    <div className="app-shell">
      <TopBar connected={connected} session={session} audio={audio} forceProfile={!session.anonymous && profileReady === false} onProfileSaved={() => setProfileReady(true)} />
      <AnimatePresence mode="wait">
        {!room ? (
          <Landing key="landing" send={sendRoom} initialCode={roomCodeFromPath()} />
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

function TopBar({ connected, session, audio, forceProfile, onProfileSaved }: { connected: boolean; session: ClientSession; audio: ReturnType<typeof useGameAudio>; forceProfile: boolean; onProfileSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Cambrio home"><span className="brand-mark">C</span><span>CAMBRIO</span></a>
      <div className="top-actions">
        <span className={`connection ${connected ? 'online' : ''}`}><i />{connected ? 'Live' : 'Reconnecting'}</span>
        <button className="icon-button" onClick={audio.toggleEffects} aria-label="Toggle sound effects">{audio.settings.effects ? '♪' : '×♪'}</button>
        <button className={`icon-button ${audio.settings.ambience ? 'active' : ''}`} onClick={audio.toggleAmbience} aria-label="Toggle ambience">≈</button>
        <button className="profile-chip" onClick={() => setOpen(true)}>{session.anonymous ? 'Guest' : session.session?.user.email?.split('@')[0] ?? 'Profile'}</button>
      </div>
      <AnimatePresence>{(open || forceProfile) && <AccountPanel session={session} close={() => setOpen(false)} force={forceProfile} onSaved={onProfileSaved} />}</AnimatePresence>
    </header>
  );
}

function Landing({ send, initialCode }: { send: (action: RoomActionInput) => Promise<ActionAck>; initialCode?: string }) {
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
    if (!initialCode || name.trim().length < 2 || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void submit('join');
  // The saved name and invite code are intentionally sampled once on arrival.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <motion.main className="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="hero-copy">
        <p className="eyebrow">Memory. Nerve. Perfect timing.</p>
        <h1>Know your cards.<br /><em>Trust your read.</em></h1>
        <p className="lede">The private-room card game where every hidden card matters—and one fearless stack can change everything.</p>
        <div className="feature-row"><span>2–8 players</span><span>Private rooms</span><span>No download</span></div>
      </div>
      <section className="join-panel glass">
        <div className="mini-cards" aria-hidden="true"><i /><i /><i /></div>
        <h2>{initialCode ? 'Join this table' : 'Take a seat'}</h2>
        <label>Your display name<input value={name} maxLength={20} onChange={(event) => setName(event.target.value)} placeholder="What should friends call you?" /></label>
        {initialCode ? (
          <button className="primary wide" disabled={busy || name.trim().length < 2} onClick={() => void submit('join')}>Join room <span>→</span></button>
        ) : (
          <>
            <button className="primary wide" disabled={busy || name.trim().length < 2} onClick={() => void submit('create')}>Create private room <span>→</span></button>
            <div className="or"><span>or join with a code</span></div>
            <div className="code-row"><input aria-label="Room code" className="code-input" value={code} maxLength={8} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ABCD2345" /><button disabled={busy || code.length !== 8 || name.trim().length < 2} onClick={() => void submit('join')}>Join</button></div>
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
      <section className="lobby-heading"><div><p className="eyebrow">Private table</p><h1>Room <span>{room.code}</span></h1><p>Share the link, ready up, then the host deals.</p></div><button className="share-button" onClick={() => void copy()}>{copied ? 'Copied!' : 'Copy invite link'}</button></section>
      <div className="lobby-grid">
        <section className="glass player-list"><div className="section-heading"><h2>Players</h2><span>{room.players.length}/8 seated</span></div>{room.players.map((player) => <LobbyPlayer key={player.id} player={player} self={player.id === room.selfPlayerId} canRemove={Boolean(isHost && player.id !== room.selfPlayerId)} remove={() => void send({ type: 'ROOM_REMOVE', playerId: player.id })} />)}</section>
        <aside className="glass lobby-rules"><p className="eyebrow">Round briefing</p><h2>Low score wins.</h2><ul><li>Peek at your two bottom cards once.</li><li>Draw, discard, or trade into your hand.</li><li>Stack matching ranks—even from another hand.</li><li>Call Cambrio when the moment feels right.</li></ul><p className="king-note">Red Kings <strong>−1</strong></p></aside>
      </div>
      <div className="lobby-footer">
        {!isHost && self && <button className={self.ready ? 'secondary ready' : 'primary'} onClick={() => void send({ type: 'ROOM_READY', ready: !self.ready })}>{self.ready ? '✓ Ready' : 'Ready up'}</button>}
        {isHost && <button className="primary deal" disabled={!allReady} onClick={() => void send({ type: 'ROOM_START' })}>{allReady ? 'Deal the cards' : room.players.length < 2 ? 'Waiting for players' : 'Waiting for ready players'}</button>}
      </div>
    </motion.main>
  );
}

function LobbyPlayer({ player, self, canRemove, remove }: { player: RoomPlayerView; self: boolean; canRemove: boolean; remove: () => void }) {
  const initials = player.name.slice(0, 2).toUpperCase();
  return <div className={`lobby-player ${!player.connected ? 'offline' : ''}`}><div className="avatar">{initials}</div><div className="player-info"><strong>{player.name}{self ? ' (you)' : ''}</strong><span>{player.handle ? <a href={`/u/${player.handle}`}>@{player.handle}</a> : 'Guest player'} · {player.stats?.wins ?? 0} wins</span></div>{player.isHost ? <span className="host-badge">HOST</span> : <span className={`ready-dot ${player.ready ? 'yes' : ''}`}>{player.ready ? 'READY' : 'WAITING'}</span>}{canRemove && <button className="remove-player" onClick={remove} aria-label={`Remove ${player.name}`}>×</button>}</div>;
}

function GameTable({ room, send, sendRoom }: { room: RoomView; send: (action: GameActionInput) => Promise<ActionAck>; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const game = room.game!;
  const self = game.players.find((player) => player.id === room.selfPlayerId)!;
  const [stackArmed, setStackArmed] = useState(false);
  const [revealHeld, setRevealHeld] = useState(false);
  const [inspectedKing, setInspectedKing] = useState(false);
  const previousGeneration = useRef(game.discardGeneration);
  useEffect(() => {
    if (previousGeneration.current !== game.discardGeneration || !game.stackOpen) setStackArmed(false);
    previousGeneration.current = game.discardGeneration;
  }, [game.discardGeneration, game.stackOpen]);
  useEffect(() => { setRevealHeld(false); setInspectedKing(false); }, [game.power?.status, game.version]);
  useEffect(() => {
    const conceal = () => {
      if (!revealHeld || game.power?.status !== 'revealing') return;
      setRevealHeld(false);
      if (game.power.kind === 'black_king') setInspectedKing(true);
      else void send({ type: 'POWER_COMPLETE' });
    };
    window.addEventListener('blur', conceal);
    return () => window.removeEventListener('blur', conceal);
  }, [game.power, revealHeld, send]);

  if (game.phase === 'initial_peek') return <InitialPeek game={game} self={self} send={send} />;
  if (game.phase === 'results') return <Results room={room} game={game} sendRoom={sendRoom} />;

  const opponents = game.players.filter((player) => player.id !== self.id && !player.forfeited);
  const isTurn = game.activePlayerId === self.id;
  const power = isTurn ? game.power : undefined;
  const selectingPower = power?.status === 'selecting';
  const transferring = game.transfer?.fromPlayerId === self.id;
  const canSwapDrawn = isTurn && game.turnStage === 'deciding' && Boolean(game.drawnCard) && self.cards.length > 0;
  const actionCard = (card: CardView, owner: PlayerView) => {
    if (transferring && owner.id === self.id) return void send({ type: 'TRANSFER_CARD', cardId: card.id });
    if (selectingPower) return void send({ type: 'POWER_SELECT', targetCardId: card.id });
    if (stackArmed) return void send({ type: 'STACK_ATTEMPT', targetCardId: card.id, discardGeneration: game.discardGeneration });
    if (canSwapDrawn && owner.id === self.id) return void send({ type: 'SWAP_DRAWN', targetCardId: card.id });
  };
  const cardInteractive = (owner: PlayerView) => transferring ? owner.id === self.id : Boolean(selectingPower || stackArmed || (canSwapDrawn && owner.id === self.id));

  return (
    <motion.main className={`game-page ${stackArmed ? 'stack-mode' : ''}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="game-status"><span className="room-pill">{room.code}</span><TurnBanner game={game} self={self} /><Countdown deadline={game.deadlineAt} /></div>
      {game.ending && <div className="ending-banner"><strong>{game.ending.reason === 'cambio' ? 'CAMBRIO CALLED' : 'ZERO CARDS'}</strong><span>{game.ending.turnsRemaining} turns remain</span></div>}
      <section className="opponent-rail">{opponents.map((opponent) => <PlayerHand key={opponent.id} player={opponent} compact interactive={cardInteractive(opponent)} reveal={revealHeld} onCard={(card) => actionCard(card, opponent)} active={game.activePlayerId === opponent.id} />)}</section>
      <section className="table-center">
        <div className="pile-zone">
          <div className="pile"><Card card={game.discard} faceDown={!game.discard} label={game.discard ? 'Discard' : 'Empty'} /><span>DISCARD</span></div>
          <button className={`deck-card ${isTurn && game.turnStage === 'awaiting_draw' ? 'draw-ready' : ''}`} disabled={!isTurn || game.turnStage !== 'awaiting_draw' || Boolean(game.transfer)} onClick={() => void send({ type: 'DRAW' })}><span className="card-back-pattern">C</span><small>{game.deckCount}</small></button>
        </div>
        {game.drawnCard && <div className="drawn-panel"><span>You drew</span><Card card={game.drawnCard} /><div className="drawn-actions"><button className="primary" onClick={() => void send({ type: 'DISCARD_DRAWN' })}>Discard</button>{self.cards.length > 0 && <small>or choose one of your cards to swap</small>}</div></div>}
      </section>
      <section className="self-zone"><PlayerHand player={self} interactive={cardInteractive(self)} reveal={revealHeld} onCard={(card) => actionCard(card, self)} active={isTurn} /><span className="you-label">YOU · {self.cards.length ? `${self.cards.length} CARDS` : 'OUT'}</span></section>
      <div className="game-actions">
        {game.stackOpen && self.cards.length > 0 && <button className={`stack-button ${stackArmed ? 'armed' : ''}`} onClick={() => setStackArmed((value) => !value)}>{stackArmed ? 'Cancel stack' : 'Stack'}<span>{stackArmed ? 'Choose any hidden card' : 'Match the discard rank'}</span></button>}
        {!game.ending && <button className="cambio-button" onClick={() => void send({ type: 'CALL_CAMBIO' })}>Call Cambrio</button>}
      </div>
      <InteractionOverlay game={game} self={self} revealHeld={revealHeld} inspectedKing={inspectedKing} setRevealHeld={setRevealHeld} setInspectedKing={setInspectedKing} send={send} />
    </motion.main>
  );
}

function InitialPeek({ game, self, send }: { game: GameView; self: PlayerView; send: (action: GameActionInput) => Promise<ActionAck> }) {
  const [holding, setHolding] = useState(false);
  const begin = () => { if (self.initialPeekComplete) return; setHolding(true); void send({ type: 'INITIAL_PEEK_START' }); };
  const end = () => { if (!holding) return; setHolding(false); void send({ type: 'INITIAL_PEEK_END' }); };
  useEffect(() => {
    window.addEventListener('blur', end);
    return () => window.removeEventListener('blur', end);
  });
  return (
    <main className="peek-screen"><div className="peek-copy"><p className="eyebrow">One look. Then remember.</p><h1>Your bottom two cards</h1><p>Press and hold below to reveal them. Once you let go, they are gone from view for the round.</p></div><div className="peek-hand">{self.cards.map((card, index) => <Card key={card.id} card={card} faceDown={!holding || index < 2} />)}</div>{self.initialPeekComplete ? <div className="waiting-ready"><span className="spinner" />Waiting for everyone…</div> : <button className="hold-button" onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onPointerLeave={end}>Hold to peek</button>}<div className="ready-progress">{game.players.filter((player) => player.initialPeekComplete).length}/{game.players.length} ready</div></main>
  );
}

function InteractionOverlay({ game, self, revealHeld, inspectedKing, setRevealHeld, setInspectedKing, send }: { game: GameView; self: PlayerView; revealHeld: boolean; inspectedKing: boolean; setRevealHeld: (value: boolean) => void; setInspectedKing: (value: boolean) => void; send: (action: GameActionInput) => Promise<ActionAck> }) {
  if (game.transfer?.fromPlayerId === self.id) return <div className="interaction-prompt"><strong>Give a card</strong><span>Choose any one of your cards to send across.</span></div>;
  const power = game.power;
  if (!power) return null;
  if (power.status === 'offered') return <div className="interaction-prompt power-prompt"><strong>{powerName(power.kind)}</strong><span>{powerDescription(power.kind)}</span><div><button className="primary" onClick={() => void send({ type: 'POWER_USE' })}>Use power</button><button onClick={() => void send({ type: 'POWER_DECLINE' })}>Decline</button></div></div>;
  if (power.status === 'selecting') return <div className="interaction-prompt"><strong>{powerTargetInstruction(power.kind, power.targets.length, self.cards.length)}</strong><span>Eligible card backs are ready to select.</span><button onClick={() => void send({ type: 'POWER_DECLINE' })}>Cancel power</button></div>;
  const blackKing = power.kind === 'black_king';
  const release = () => {
    setRevealHeld(false);
    if (blackKing) setInspectedKing(true);
    else void send({ type: 'POWER_COMPLETE' });
  };
  return <div className="interaction-prompt power-prompt"><strong>{blackKing ? 'Read both cards' : 'Private peek'}</strong>{!inspectedKing ? <button className="hold-reveal" onPointerDown={() => setRevealHeld(true)} onPointerUp={release} onPointerCancel={release} onPointerLeave={() => revealHeld && release()}>Hold to reveal</button> : <div className="power-choice"><button className="primary" disabled={power.targets.length < 2} onClick={() => void send({ type: 'POWER_COMPLETE', swap: true })}>Swap them</button><button onClick={() => void send({ type: 'POWER_COMPLETE', swap: false })}>Keep them</button></div>}</div>;
}

function Results({ room, game, sendRoom }: { room: RoomView; game: GameView; sendRoom: (action: RoomActionInput) => Promise<ActionAck> }) {
  const rows = game.results!.map((result) => ({ result, player: game.players.find((player) => player.id === result.playerId)! })).sort((a, b) => (a.result.score ?? 999) - (b.result.score ?? 999));
  const winnerNames = rows.filter((row) => row.result.winner).map((row) => row.player.name).join(' & ');
  const isHost = room.hostPlayerId === room.selfPlayerId;
  return <motion.main className="results-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><p className="eyebrow">Round complete</p><h1>{winnerNames} {rows.filter((row) => row.result.winner).length > 1 ? 'win' : 'wins'}!</h1><p>Lowest score takes the table.</p><section className="results-list glass">{rows.map(({ player, result }, index) => <div key={player.id} className={`result-row ${result.winner ? 'winner' : ''}`}><span className="place">{result.forfeited ? '—' : index + 1}</span><div><strong>{player.name}{player.id === room.selfPlayerId ? ' (you)' : ''}</strong><div className="result-cards">{player.cards.map((card) => <Card key={card.id} card={card} mini />)}</div></div><strong className="score">{result.score ?? 'Forfeit'}</strong></div>)}</section>{isHost ? <button className="primary deal" onClick={() => void sendRoom({ type: 'ROOM_REMATCH' })}>Return to lobby</button> : <p className="waiting-host">Waiting for the host to return to the lobby…</p>}</motion.main>;
}

function PlayerHand({ player, compact = false, interactive = false, reveal = false, active = false, onCard }: { player: PlayerView; compact?: boolean; interactive?: boolean; reveal?: boolean; active?: boolean; onCard: (card: CardView) => void }) {
  return <div className={`player-hand ${compact ? 'compact' : ''} ${active ? 'active-turn' : ''}`}><div className="seat-name"><span>{player.name}</span>{!player.connected && <i>OFFLINE</i>}</div><div className="hand-cards">{player.cards.map((card) => <Card key={card.id} card={card} faceDown={!reveal} interactive={interactive} onClick={() => onCard(card)} />)}{player.cards.length === 0 && <div className="out-badge">OUT</div>}</div></div>;
}

function Card({ card, faceDown = false, interactive = false, mini = false, label, onClick }: { card?: CardView; faceDown?: boolean; interactive?: boolean; mini?: boolean; label?: string; onClick?: () => void }) {
  const hidden = faceDown || !card?.rank;
  const red = card?.suit === 'hearts' || card?.suit === 'diamonds';
  return <motion.button layout className={`playing-card ${hidden ? 'face-down' : ''} ${red ? 'red' : ''} ${interactive ? 'interactive' : ''} ${mini ? 'mini' : ''} ${!card ? 'empty' : ''}`} disabled={!interactive} onClick={onClick} whileHover={interactive ? { y: -5 } : undefined} whileTap={interactive ? { scale: 0.96 } : undefined}>{hidden ? <span className="card-back-pattern">C</span> : <><span className="corner">{card!.rank}<small>{suitGlyph(card!.suit)}</small></span><span className="suit">{suitGlyph(card!.suit)}</span></>} {label && <em>{label}</em>}</motion.button>;
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
  const google = async () => { if (!supabase) return setMessage('Connect Supabase to enable accounts.'); const { error } = session.anonymous ? await supabase.auth.linkIdentity({ provider: 'google', options: { redirectTo: window.location.href } }) : await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } }); if (error) setMessage(error.message); };
  const emailLink = async () => { if (!supabase) return setMessage('Connect Supabase to enable accounts.'); const { error } = session.anonymous ? await supabase.auth.updateUser({ email }) : await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } }); setMessage(error ? error.message : 'Check your email to finish linking your account.'); };
  const saveProfile = async () => { const response = await fetch('/api/me/profile', { method: 'PUT', headers: authHeaders, body: JSON.stringify({ handle, displayName }) }); const body = await response.json(); setMessage(response.ok ? 'Profile saved.' : body.error); if (response.ok) onSaved?.(); };
  return <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => !force && close()}><motion.section className="account-panel glass" initial={{ y: 18 }} animate={{ y: 0 }} onMouseDown={(event) => event.stopPropagation()}>{!force && <button className="modal-close" onClick={close}>×</button>}<p className="eyebrow">Player identity</p><h2>{permanent ? force ? 'Choose your player handle' : 'Your Cambrio profile' : 'Save your wins'}</h2>{!permanent ? <><p>Keep playing as a guest, or link this guest to an account. Wins already earned on this browser will come with you.</p><button className="google-button" onClick={() => void google()}>Continue with Google</button><div className="or"><span>or use email</span></div><div className="email-row"><input value={email} type="email" placeholder="you@example.com" onChange={(event) => setEmail(event.target.value)} /><button onClick={() => void emailLink()}>Send link</button></div></> : <><p>Your unique handle creates your shareable public profile.</p><label>Public handle<input value={handle} onChange={(event) => setHandle(event.target.value.toLowerCase())} placeholder="card_shark" /></label><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label><button className="primary wide" disabled={handle.length < 3 || displayName.trim().length < 2} onClick={() => void saveProfile()}>Save public profile</button></>}{message && <p className="panel-message">{message}</p>}</motion.section></motion.div>;
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

function emitAction(socket: ClientSocket | undefined, event: 'room:action' | 'game:action', payload: unknown): Promise<ActionAck> {
  return new Promise((resolve) => {
    if (!socket?.connected) return resolve({ clientActionId: '', ok: false, message: 'Still reconnecting…' });
    socket.timeout(8_000).emit(event, payload, (error: Error | null, result: ActionAck) => resolve(error ? { clientActionId: '', ok: false, message: 'The server did not respond.' } : result));
  });
}

function roomCodeFromPath(): string | undefined { return window.location.pathname.match(/^\/room\/([A-HJ-NP-Z2-9]{8})$/i)?.[1]?.toUpperCase(); }
function suitGlyph(suit?: CardView['suit']): string { return suit === 'hearts' ? '♥' : suit === 'diamonds' ? '♦' : suit === 'clubs' ? '♣' : '♠'; }
function powerName(power: PowerKind): string { return power === 'own_peek' ? 'Private peek' : power === 'opponent_peek' ? 'Read an opponent' : power === 'blind_swap' ? 'Blind swap' : 'Black King'; }
function powerDescription(power: PowerKind): string { return power === 'own_peek' ? 'Look at one of your hidden cards.' : power === 'opponent_peek' ? "Look at one opponent's hidden card." : power === 'blind_swap' ? 'Trade one of your cards with an opponent—without looking.' : 'Read one of yours and one of theirs, then choose whether to swap.'; }
function powerTargetInstruction(power: PowerKind, selected: number, ownCount: number): string { if (power === 'own_peek') return 'Choose one of your cards'; if (power === 'opponent_peek' || (power === 'black_king' && ownCount === 0)) return "Choose an opponent's card"; if (selected === 0) return 'Choose one of your cards'; return "Now choose an opponent's card"; }
