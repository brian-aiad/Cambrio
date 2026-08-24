import { UserRound } from 'lucide-react';
import { useState } from 'react';
import { RANKS, SUITS, type CardView, type GameView, type PlayerView, type PowerKind, type PowerState } from '../shared/game.js';
import type { ActionAck, RoomView } from '../shared/protocol.js';
import { CambrioGlyph, Card, GameTable } from './App.js';

const names = ['Brian', 'Alex', 'Maya', 'Jordan', 'Sam', 'Chris', 'Taylor', 'Devin'];
const suits = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
const ranks = ['A', '3', '5', '7', '9', '10', 'J', 'K'] as const;

export function VisualAuditApp() {
  const query = new URLSearchParams(window.location.search);
  const scene = query.get('scene') ?? 'awaiting';
  const playerCount = Math.min(8, Math.max(2, Number(query.get('players') ?? 4)));
  const [room, setRoom] = useState(() => makeRoom(scene, playerCount));
  if (scene === 'cards') return <CardGallery />;
  const send = async (action: { type: string; targetCardId?: string; swap?: boolean }): Promise<ActionAck> => {
    let outcome: ActionAck['outcome'];
    setRoom((current) => {
      const result = applyAuditAction(current, action, scene);
      outcome = result.outcome;
      return result.room;
    });
    return { clientActionId: 'visual-audit', ok: true, outcome };
  };
  const noop = async (): Promise<ActionAck> => ({ clientActionId: 'visual-audit', ok: true });
  return <div className="app-shell visual-audit" data-scene={scene}>
    <header className="topbar game-topbar">
      <a className="brand" href="/" title="Cambrio home"><span className="brand-mark" aria-hidden="true"><CambrioGlyph decorative /></span><span className="brand-word">cambrio</span></a>
      <div className="top-actions"><span className="connection online"><i />Live</span><button className="profile-chip" aria-label="Profile"><UserRound size={15} /><span>Brian</span></button></div>
    </header>
    <GameTable room={room} send={send} sendRoom={noop} />
  </div>;
}

function CardGallery() {
  return <main className="card-gallery-page"><p className="eyebrow">Visual audit</p><h1>Every card face</h1><section className="card-gallery">{SUITS.flatMap((suit) => RANKS.map((rank, index) => <div key={`${rank}-${suit}`}><Card card={{ id: `gallery-${rank}-${suit}`, slot: index, rank, suit }} /><span>{rank} · {suit}</span></div>))}</section></main>;
}

function makeRoom(scene: string, playerCount: number): RoomView {
  const players = Array.from({ length: playerCount }, (_, index) => makePlayer(index, scene === 'six' && index === 0 ? 6 : scene === 'zero' && index === 0 ? 0 : 4));
  const self = players[0];
  const activePlayerId = scene === 'opponent-turn' ? players[1].id : self.id;
  const game: GameView = {
    id: `audit-${scene}`,
    phase: scene === 'results' ? 'results' : scene.startsWith('initial') ? 'initial_peek' : scene === 'ending' ? 'ending' : 'playing',
    version: 12,
    viewerId: self.id,
    players,
    deckCount: 38,
    discard: faceCard('discard-8', -1, '8', 'diamonds'),
    stackOpen: scene === 'awaiting' || scene === 'opponent-turn' || scene.startsWith('stack-'),
    discardGeneration: 4,
    activePlayerId,
    turnStage: 'awaiting_draw',
    deadlineAt: Date.now() + 38_000,
  };

  if (scene === 'drawn') {
    game.stackOpen = false;
    game.turnStage = 'deciding';
    game.drawnCard = faceCard('drawn-10', -1, '10', 'hearts');
  }
  const power = powerForScene(scene, players);
  if (power) {
    game.stackOpen = false;
    game.turnStage = 'power';
    game.power = power;
    game.discard = powerDiscard(power.kind);
    for (const targetId of power.status === 'revealing' ? power.targets : []) revealTarget(players, targetId);
  }
  if (scene === 'transfer') {
    game.stackOpen = false;
    game.transfer = { fromPlayerId: self.id, toPlayerId: players[1].id, deadlineAt: Date.now() + 38_000 };
  }
  if (scene === 'ending') game.ending = { triggerPlayerId: players[1].id, reason: 'cambio', turnsRemaining: playerCount + 1 };
  if (scene === 'zero') game.ending = { triggerPlayerId: self.id, reason: 'zero_cards', turnsRemaining: playerCount };
  if (scene === 'results') {
    players[0].cards.push({ id: 'p0-card-4', slot: 4 }, { id: 'p0-card-5', slot: 5 });
    players[1].cards.push({ id: 'p1-card-4', slot: 4 });
    game.players = players.map((player, playerIndex) => ({ ...player, cards: player.cards.map((card, cardIndex) => faceCard(card.id, card.slot, ranks[(playerIndex + cardIndex) % ranks.length], suits[(playerIndex + cardIndex) % suits.length])) }));
    game.results = game.players.map((player, index) => ({ playerId: player.id, score: 12 + index * 7, winner: index === 0, forfeited: false }));
    game.activePlayerId = undefined;
    game.turnStage = undefined;
    game.deadlineAt = undefined;
  }

  return {
    code: 'PLAY2458',
    phase: scene === 'results' ? 'results' : 'game',
    selfPlayerId: self.id,
    hostPlayerId: self.id,
    players: players.map((player, index) => ({ id: player.id, name: player.name, ready: true, connected: true, isHost: index === 0, joinedAt: index })),
    waiting: [],
    game,
  };
}

function powerDiscard(kind: PowerKind): CardView {
  return kind === 'own_peek' ? faceCard('discard-7', -1, '7', 'diamonds')
    : kind === 'opponent_peek' ? faceCard('discard-10', -1, '10', 'hearts')
      : kind === 'blind_swap' ? faceCard('discard-q', -1, 'Q', 'hearts')
        : faceCard('discard-black-king', -1, 'K', 'spades');
}

function applyAuditAction(room: RoomView, action: { type: string; targetCardId?: string; swap?: boolean }, scene: string): { room: RoomView; outcome?: ActionAck['outcome'] } {
  const next = structuredClone(room);
  const game = next.game!;
  const self = game.players.find((player) => player.id === next.selfPlayerId)!;
  const followingPlayer = game.players.find((player) => player.id !== self.id)?.id ?? self.id;

  if (action.type === 'INITIAL_PEEK_START' && game.phase === 'initial_peek') {
    self.cards = self.cards.map((card) => card.slot >= 2 ? faceCard(card.id, card.slot, card.slot === 2 ? '3' : '9', card.slot === 2 ? 'clubs' : 'hearts') : card);
  } else if (action.type === 'INITIAL_PEEK_END' && game.phase === 'initial_peek') {
    self.cards = self.cards.map((card) => ({ id: card.id, slot: card.slot }));
    self.initialPeekComplete = true;
  } else if (action.type === 'DRAW' && game.turnStage === 'awaiting_draw') {
    game.deckCount = Math.max(0, game.deckCount - 1);
    game.stackOpen = false;
    game.turnStage = 'deciding';
    game.drawnCard = faceCard('audit-drawn', -1, '10', 'hearts');
    if (self.cards.length === 0) {
      game.discard = game.drawnCard;
      game.drawnCard = undefined;
      game.discardGeneration += 1;
      game.stackOpen = true;
      game.turnStage = 'awaiting_draw';
      game.activePlayerId = followingPlayer;
    }
  } else if (action.type === 'DISCARD_DRAWN' && game.drawnCard) {
    game.discard = game.drawnCard;
    game.drawnCard = undefined;
    game.discardGeneration += 1;
    game.stackOpen = true;
    game.turnStage = 'awaiting_draw';
    game.activePlayerId = followingPlayer;
  } else if (action.type === 'SWAP_DRAWN' && game.drawnCard && action.targetCardId) {
    const index = self.cards.findIndex((card) => card.id === action.targetCardId);
    if (index >= 0) {
      const removed = self.cards[index];
      self.cards[index] = { id: game.drawnCard.id, slot: removed.slot };
      game.discard = faceCard(removed.id, -1, 'A', 'spades');
      game.drawnCard = undefined;
      game.discardGeneration += 1;
      game.stackOpen = true;
      game.turnStage = 'awaiting_draw';
      game.activePlayerId = followingPlayer;
    }
  } else if (action.type === 'POWER_SELECT' && action.targetCardId && game.power) {
    const power = game.power;
    if (power.kind === 'own_peek' || power.kind === 'opponent_peek') {
      power.targets = [action.targetCardId];
      power.status = 'revealing';
      revealTarget(game.players, action.targetCardId);
    } else if (power.targets.length === 0) {
      power.targets = [action.targetCardId];
    } else if (power.kind === 'blind_swap') {
      swapAuditCards(game.players, power.targets[0], action.targetCardId);
      game.power = undefined;
      game.turnStage = 'awaiting_draw';
      game.activePlayerId = followingPlayer;
    } else {
      power.targets.push(action.targetCardId);
      power.status = 'revealing';
      power.targets.forEach((target) => revealTarget(game.players, target));
    }
  } else if (action.type === 'POWER_CONCEAL' && game.power?.kind === 'black_king') {
    game.power.status = 'choosing';
    for (const player of game.players) player.cards = player.cards.map((card) => game.power!.targets.includes(card.id) ? { id: card.id, slot: card.slot } : card);
  } else if (action.type === 'POWER_COMPLETE') {
    if (game.power?.kind === 'black_king' && action.swap && game.power.targets.length === 2) swapAuditCards(game.players, game.power.targets[0], game.power.targets[1]);
    game.power = undefined;
    game.turnStage = 'awaiting_draw';
    game.activePlayerId = followingPlayer;
  } else if (action.type === 'POWER_DECLINE') {
    game.power = undefined;
    game.turnStage = 'awaiting_draw';
    game.activePlayerId = followingPlayer;
  } else if (action.type === 'CALL_CAMBRIO') {
    game.phase = 'ending';
    game.ending = { triggerPlayerId: self.id, reason: 'cambio', turnsRemaining: game.players.length + 1 };
  } else if (action.type === 'STACK_ATTEMPT' && action.targetCardId) {
    if (scene === 'stack-wrong') {
      const slot = Math.max(3, ...self.cards.map((card) => card.slot)) + 1;
      self.cards.push({ id: `penalty-${slot}`, slot });
      game.version += 1;
      return { room: next, outcome: 'penalty' };
    }
    const owner = game.players.find((player) => player.cards.some((card) => card.id === action.targetCardId));
    const target = owner?.cards.find((card) => card.id === action.targetCardId);
    if (owner && target) {
      owner.cards = owner.cards.filter((card) => card.id !== target.id);
      game.discard = faceCard(target.id, -1, '8', 'clubs');
      game.stackOpen = false;
      game.discardGeneration += 1;
      if (owner.id !== self.id) game.transfer = { fromPlayerId: self.id, toPlayerId: owner.id, deadlineAt: Date.now() + 38_000 };
    }
    game.version += 1;
    return { room: next, outcome: 'stack' };
  }
  game.version += 1;
  return { room: next };
}

function swapAuditCards(players: PlayerView[], firstId: string, secondId: string): void {
  const firstOwner = players.find((player) => player.cards.some((card) => card.id === firstId));
  const secondOwner = players.find((player) => player.cards.some((card) => card.id === secondId));
  if (!firstOwner || !secondOwner) return;
  const firstIndex = firstOwner.cards.findIndex((card) => card.id === firstId);
  const secondIndex = secondOwner.cards.findIndex((card) => card.id === secondId);
  const firstSlot = firstOwner.cards[firstIndex].slot;
  const secondSlot = secondOwner.cards[secondIndex].slot;
  firstOwner.cards[firstIndex] = { id: secondId, slot: firstSlot };
  secondOwner.cards[secondIndex] = { id: firstId, slot: secondSlot };
}

function makePlayer(index: number, count: number): PlayerView {
  return {
    id: `player-${index}`,
    name: names[index],
    seat: index,
    cards: Array.from({ length: count }, (_, slot) => ({ id: `p${index}-card-${slot}`, slot })),
    connected: true,
    forfeited: false,
    initialPeekComplete: false,
  };
}

function powerForScene(scene: string, players: PlayerView[]): PowerState | undefined {
  const selfCard = players[0].cards[0]?.id;
  const opponentCard = players[1].cards[3]?.id;
  const map: Record<string, { kind: PowerKind; status: PowerState['status']; targets: string[] }> = {
    'own-select': { kind: 'own_peek', status: 'selecting', targets: [] },
    'own-reveal': { kind: 'own_peek', status: 'revealing', targets: selfCard ? [selfCard] : [] },
    'opponent-select': { kind: 'opponent_peek', status: 'selecting', targets: [] },
    'opponent-reveal': { kind: 'opponent_peek', status: 'revealing', targets: opponentCard ? [opponentCard] : [] },
    'blind-own': { kind: 'blind_swap', status: 'selecting', targets: [] },
    'blind-opponent': { kind: 'blind_swap', status: 'selecting', targets: selfCard ? [selfCard] : [] },
    'black-own': { kind: 'black_king', status: 'selecting', targets: [] },
    'black-opponent': { kind: 'black_king', status: 'selecting', targets: selfCard ? [selfCard] : [] },
    'black-reveal': { kind: 'black_king', status: 'revealing', targets: selfCard && opponentCard ? [selfCard, opponentCard] : [] },
    'black-choice': { kind: 'black_king', status: 'choosing', targets: selfCard && opponentCard ? [selfCard, opponentCard] : [] },
  };
  return map[scene];
}

function revealTarget(players: PlayerView[], targetId: string): void {
  for (const player of players) {
    const index = player.cards.findIndex((card) => card.id === targetId);
    if (index >= 0) player.cards[index] = faceCard(targetId, player.cards[index].slot, index % 2 ? 'J' : '5', index % 2 ? 'hearts' : 'clubs');
  }
}

function faceCard(id: string, slot: number, rank: NonNullable<CardView['rank']>, suit: NonNullable<CardView['suit']>): CardView {
  return { id, slot, rank, suit };
}
