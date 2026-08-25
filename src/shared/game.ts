export const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const;
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export const MAX_HAND_CARDS = 6;

export type Suit = (typeof SUITS)[number];
export type Rank = (typeof RANKS)[number];
export type GamePhase = 'initial_peek' | 'playing' | 'ending' | 'results';
export type PowerKind = 'own_peek' | 'opponent_peek' | 'blind_swap' | 'black_king';
export type TurnStage = 'awaiting_draw' | 'deciding' | 'power';

export interface Card {
  id: string;
  rank: Rank;
  suit: Suit;
}

export interface EnginePlayer {
  id: string;
  userId: string;
  name: string;
  handle?: string;
  seat: number;
  cards: string[];
  cardSlots: Record<string, number>;
  initialPeekComplete: boolean;
  initialPeekOpen: boolean;
  connected: boolean;
  forfeited: boolean;
}

export interface PowerState {
  kind: PowerKind;
  status: 'offered' | 'selecting' | 'revealing' | 'choosing';
  targets: string[];
}

export interface TurnState {
  playerId: string;
  stage: TurnStage;
  drawnCardId?: string;
  power?: PowerState;
  deadlineAt: number;
}

export interface TransferState {
  fromPlayerId: string;
  toPlayerId: string;
  deadlineAt: number;
}

export interface EndingState {
  triggerPlayerId: string;
  reason: 'cambio' | 'zero_cards';
  queue: string[];
}

export interface PlayerResult {
  playerId: string;
  score: number | null;
  winner: boolean;
  forfeited: boolean;
}

export interface GameState {
  id: string;
  phase: GamePhase;
  version: number;
  cards: Record<string, Card>;
  deck: string[];
  discard: string[];
  burn: string[];
  players: EnginePlayer[];
  turnOrder: string[];
  turn?: TurnState;
  transfer?: TransferState;
  ending?: EndingState;
  stackOpen: boolean;
  discardGeneration: number;
  stackLocks: Record<string, number>;
  temporaryReveals: Record<string, string[]>;
  results?: PlayerResult[];
  createdAt: number;
}

export type GameCommand =
  | { type: 'INITIAL_PEEK_START'; playerId: string }
  | { type: 'INITIAL_PEEK_END'; playerId: string }
  | { type: 'DRAW'; playerId: string }
  | { type: 'DISCARD_DRAWN'; playerId: string }
  | { type: 'SWAP_DRAWN'; playerId: string; targetCardId: string }
  | { type: 'POWER_USE'; playerId: string }
  | { type: 'POWER_DECLINE'; playerId: string }
  | { type: 'POWER_SELECT'; playerId: string; targetCardId: string }
  | { type: 'POWER_CONCEAL'; playerId: string }
  | { type: 'POWER_COMPLETE'; playerId: string; swap?: boolean }
  | { type: 'STACK_ATTEMPT'; playerId: string; targetCardId: string; discardGeneration: number }
  | { type: 'TRANSFER_CARD'; playerId: string; cardId: string }
  | { type: 'CALL_CAMBIO'; playerId: string }
  | { type: 'SET_CONNECTED'; playerId: string; connected: boolean }
  | { type: 'FORFEIT_PLAYER'; playerId: string }
  | { type: 'TIMEOUT'; playerId: string };

export interface GameEffect {
  type: 'peek' | 'power' | 'penalty' | 'stack_lock' | 'stack' | 'transfer' | 'cambio' | 'turn' | 'results' | 'forfeit';
  playerId?: string;
  message?: string;
  cardIds?: string[];
}

export interface TransitionResult {
  state: GameState;
  effects: GameEffect[];
}

export interface CardView {
  id: string;
  slot: number;
  rank?: Rank;
  suit?: Suit;
}

export interface PlayerView {
  id: string;
  name: string;
  handle?: string;
  seat: number;
  cards: CardView[];
  connected: boolean;
  forfeited: boolean;
  initialPeekComplete: boolean;
}

export interface GameView {
  id: string;
  phase: GamePhase;
  version: number;
  viewerId: string;
  players: PlayerView[];
  deckCount: number;
  discard?: CardView;
  stackOpen: boolean;
  discardGeneration: number;
  stackLocked?: boolean;
  activePlayerId?: string;
  turnStage?: TurnStage;
  deadlineAt?: number;
  paused?: {
    playerIds: string[];
    remainingMs: number;
  };
  drawnCard?: CardView;
  power?: PowerState;
  transfer?: TransferState;
  ending?: { triggerPlayerId: string; reason: EndingState['reason']; turnsRemaining: number };
  results?: PlayerResult[];
}

export class GameRuleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'GameRuleError';
  }
}

const TURN_MS = 45_000;

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: `${rank}-${suit}`, rank, suit })));
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

export function cardScore(card: Card): number {
  if (card.rank === 'A') return 1;
  if (card.rank === 'K') return card.suit === 'diamonds' || card.suit === 'hearts' ? -1 : 10;
  if (card.rank === 'J' || card.rank === 'Q') return 10;
  return Number(card.rank);
}

export function powerFor(card: Card): PowerKind | undefined {
  if (card.rank === '7' || card.rank === '8') return 'own_peek';
  if (card.rank === '9' || card.rank === '10') return 'opponent_peek';
  if (card.rank === 'J' || card.rank === 'Q') return 'blind_swap';
  if (card.rank === 'K' && (card.suit === 'clubs' || card.suit === 'spades')) return 'black_king';
  return undefined;
}

export function createGame(
  id: string,
  participants: Array<{ id: string; userId: string; name: string; handle?: string }>,
  now = Date.now(),
  random: () => number = Math.random,
): GameState {
  if (participants.length < 2 || participants.length > 8) {
    throw new GameRuleError('PLAYER_COUNT', 'Cambrio requires 2–8 players.');
  }
  const cards = createDeck();
  const cardMap = Object.fromEntries(cards.map((card) => [card.id, card]));
  const deck = shuffle(cards.map((card) => card.id), random);
  const ordered = shuffle(participants, random);
  const players: EnginePlayer[] = ordered.map((participant, seat) => ({
    ...participant,
    seat,
    cards: [],
    cardSlots: {},
    initialPeekComplete: false,
    initialPeekOpen: false,
    connected: true,
    forfeited: false,
  }));
  for (let cardNumber = 0; cardNumber < 4; cardNumber += 1) {
    for (const player of players) addOwnedCard(player, requireDeckCard(deck), cardNumber);
  }
  return {
    id,
    phase: 'initial_peek',
    version: 0,
    cards: cardMap,
    deck,
    discard: [],
    burn: [],
    players,
    turnOrder: players.map((player) => player.id),
    stackOpen: false,
    discardGeneration: 0,
    stackLocks: {},
    temporaryReveals: {},
    createdAt: now,
  };
}

export function applyGameCommand(
  source: GameState,
  command: GameCommand,
  now = Date.now(),
  random: () => number = Math.random,
): TransitionResult {
  const state = structuredClone(source);
  const effects: GameEffect[] = [];
  const player = getPlayer(state, command.playerId);
  if (player.forfeited && command.type !== 'SET_CONNECTED') fail('FORFEITED', 'This player has forfeited.');

  switch (command.type) {
    case 'INITIAL_PEEK_START': {
      requirePhase(state, 'initial_peek');
      if (player.initialPeekComplete) fail('PEEK_COMPLETE', 'The initial peek is already complete.');
      player.initialPeekOpen = true;
      state.temporaryReveals[player.id] = player.cards.filter((cardId, index) => {
        const slot = cardSlot(player, cardId, index);
        return slot === 2 || slot === 3;
      });
      effects.push({ type: 'peek', playerId: player.id, cardIds: state.temporaryReveals[player.id] });
      break;
    }
    case 'INITIAL_PEEK_END': {
      requirePhase(state, 'initial_peek');
      player.initialPeekOpen = false;
      player.initialPeekComplete = true;
      delete state.temporaryReveals[player.id];
      if (activePlayers(state).every((candidate) => candidate.initialPeekComplete)) {
        state.phase = 'playing';
        const first = firstActiveTurnPlayer(state);
        if (!first) fail('NO_ACTIVE_PLAYER', 'No active player can begin the round.');
        startTurn(state, first, now);
        effects.push({ type: 'turn', playerId: first });
      }
      break;
    }
    case 'DRAW': {
      requireTurnCommand(state, player.id, 'awaiting_draw');
      if (state.transfer) fail('TRANSFER_PENDING', 'A mandatory card transfer is pending.');
      // The previous discard is fair game until the active player commits to
      // drawing. From this point on, only the new discard may open a stack race.
      state.stackOpen = false;
      const cardId = drawCard(state, random);
      if (!cardId) {
        finishRound(state);
        effects.push({ type: 'results' });
        break;
      }
      state.turn!.drawnCardId = cardId;
      state.turn!.stage = 'deciding';
      state.turn!.deadlineAt = now + TURN_MS;
      if (player.cards.length === 0) discardDrawn(state, player, now, effects);
      break;
    }
    case 'DISCARD_DRAWN': {
      requireTurnCommand(state, player.id, 'deciding');
      discardDrawn(state, player, now, effects);
      break;
    }
    case 'SWAP_DRAWN': {
      requireTurnCommand(state, player.id, 'deciding');
      if (player.cards.length === 0) fail('NO_CARDS', 'A zero-card player must discard the draw.');
      const targetIndex = player.cards.indexOf(command.targetCardId);
      if (targetIndex < 0) fail('NOT_OWNED', 'That card is not owned by the active player.');
      const drawn = state.turn!.drawnCardId;
      if (!drawn) fail('NO_DRAW', 'No card has been drawn.');
      const targetSlot = cardSlot(player, command.targetCardId, targetIndex);
      replaceOwnedCard(player, command.targetCardId, drawn);
      openDiscard(state, command.targetCardId);
      effects.push({ type: 'turn', playerId: player.id, message: `${player.name} swapped the draw into ${slotCode(targetSlot)}.` });
      endTurn(state, now, effects);
      break;
    }
    case 'POWER_USE': {
      requireTurnCommand(state, player.id, 'power');
      const power = state.turn!.power;
      if (!power || power.status !== 'offered') fail('NO_POWER', 'No power is available.');
      power.status = 'selecting';
      state.turn!.deadlineAt = now + TURN_MS;
      break;
    }
    case 'POWER_DECLINE': {
      requireTurnCommand(state, player.id, 'power');
      endTurn(state, now, effects);
      break;
    }
    case 'POWER_SELECT': {
      requireTurnCommand(state, player.id, 'power');
      selectPowerTarget(state, player, command.targetCardId, effects, now);
      break;
    }
    case 'POWER_CONCEAL': {
      requireTurnCommand(state, player.id, 'power');
      const power = state.turn!.power;
      if (!power || power.kind !== 'black_king' || power.status !== 'revealing') fail('POWER_NOT_REVEALED', 'No Black King reveal is ready to conceal.');
      power.status = 'choosing';
      delete state.temporaryReveals[player.id];
      state.turn!.deadlineAt = now + TURN_MS;
      break;
    }
    case 'POWER_COMPLETE': {
      requireTurnCommand(state, player.id, 'power');
      completePower(state, player, Boolean(command.swap), effects, now);
      break;
    }
    case 'STACK_ATTEMPT': {
      requireActiveGame(state);
      if (state.transfer) fail('TRANSFER_PENDING', 'A mandatory card transfer is pending.');
      if (!state.stackOpen || command.discardGeneration !== state.discardGeneration) {
        fail('STACK_CLOSED', 'That discard is no longer stackable.');
      }
      if (player.cards.length === 0) fail('NO_CARDS', 'A zero-card player cannot stack.');
      state.stackLocks ??= {};
      if (state.stackLocks[player.id] === state.discardGeneration) fail('STACK_LOCKED', 'Wait for the next discard before stacking again.');
      const owner = state.players.find((candidate) => candidate.cards.includes(command.targetCardId) && !candidate.forfeited);
      if (!owner) fail('BAD_TARGET', 'That table card is not available.');
      const top = state.discard.at(-1);
      if (!top) fail('NO_DISCARD', 'There is no active discard.');
      if (state.cards[command.targetCardId].rank !== state.cards[top].rank) {
        if (player.cards.length >= MAX_HAND_CARDS) {
          state.stackLocks[player.id] = state.discardGeneration;
          effects.push({ type: 'stack_lock', playerId: player.id, message: `${player.name} missed and must wait for the next discard.` });
          break;
        }
        const penalty = drawCard(state, random);
        if (!penalty) {
          finishRound(state);
          effects.push({ type: 'results' });
        } else {
          addOwnedCard(player, penalty);
          effects.push({ type: 'penalty', playerId: player.id, message: `${player.name} missed and drew a penalty.` });
        }
        break;
      }
      removeOwnedCard(owner, command.targetCardId);
      state.discard.push(command.targetCardId);
      state.stackOpen = false;
      delete state.temporaryReveals[player.id];
      effects.push({ type: 'stack', playerId: player.id, message: `${player.name} stacked successfully.` });
      if (owner.cards.length === 0) triggerEnding(state, owner.id, 'zero_cards');
      if (owner.id !== player.id && owner.cards.length > 0) {
        state.transfer = { fromPlayerId: player.id, toPlayerId: owner.id, deadlineAt: now + TURN_MS };
      }
      break;
    }
    case 'TRANSFER_CARD': {
      if (!state.transfer || state.transfer.fromPlayerId !== player.id) fail('NO_TRANSFER', 'No transfer is pending.');
      transferCard(state, command.cardId, now, effects);
      break;
    }
    case 'CALL_CAMBIO': {
      requireActiveGame(state);
      if (state.ending) fail('ENDING_STARTED', 'The ending sequence has already started.');
      triggerEnding(state, player.id, 'cambio');
      effects.push({ type: 'cambio', playerId: player.id, message: `${player.name} called Cambrio.` });
      break;
    }
    case 'SET_CONNECTED': {
      player.connected = command.connected;
      break;
    }
    case 'FORFEIT_PLAYER': {
      forfeitPlayer(state, player, now, effects);
      break;
    }
    case 'TIMEOUT': {
      handleTimeout(state, player, now, random, effects);
      break;
    }
  }

  state.version += 1;
  return { state, effects };
}

export function projectGame(state: GameState, viewerId: string): GameView {
  getPlayer(state, viewerId);
  const visible = new Set(state.temporaryReveals[viewerId] ?? []);
  if (state.phase === 'results') {
    for (const player of state.players) for (const cardId of player.cards) visible.add(cardId);
  }
  const cardView = (cardId: string, slot: number, force = false): CardView => {
    const card = state.cards[cardId];
    return force || visible.has(cardId) ? { ...card, slot } : { id: card.id, slot };
  };
  const top = state.discard.at(-1);
  const drawn = state.turn?.drawnCardId;
  return {
    id: state.id,
    phase: state.phase,
    version: state.version,
    viewerId,
    players: state.players.map((player) => ({
      id: player.id,
      name: player.name,
      handle: player.handle,
      seat: player.seat,
      cards: player.cards
        .map((cardId, index) => cardView(cardId, cardSlot(player, cardId, index)))
        .sort((first, second) => first.slot - second.slot),
      connected: player.connected,
      forfeited: player.forfeited,
      initialPeekComplete: player.initialPeekComplete,
    })),
    deckCount: state.deck.length,
    discard: top ? cardView(top, -1, true) : undefined,
    stackOpen: state.stackOpen,
    discardGeneration: state.discardGeneration,
    stackLocked: (state.stackLocks ?? {})[viewerId] === state.discardGeneration,
    activePlayerId: state.turn?.playerId,
    turnStage: state.turn?.stage,
    deadlineAt: state.transfer?.deadlineAt ?? state.turn?.deadlineAt,
    drawnCard: drawn && state.turn?.playerId === viewerId ? cardView(drawn, -1, true) : undefined,
    power: state.turn?.playerId === viewerId ? state.turn.power : undefined,
    transfer: state.transfer?.fromPlayerId === viewerId ? state.transfer : undefined,
    ending: state.ending
      ? { triggerPlayerId: state.ending.triggerPlayerId, reason: state.ending.reason, turnsRemaining: state.ending.queue.length }
      : undefined,
    results: state.results,
  };
}

function requireDeckCard(deck: string[]): string {
  const card = deck.pop();
  if (!card) throw new GameRuleError('DECK_EMPTY', 'The deck is unexpectedly empty.');
  return card;
}

function ensureCardSlots(player: EnginePlayer): Record<string, number> {
  player.cardSlots ??= {};
  const occupied = new Set(Object.values(player.cardSlots));
  for (const [index, cardId] of player.cards.entries()) {
    if (player.cardSlots[cardId] !== undefined) continue;
    let slot = index;
    while (occupied.has(slot)) slot += 1;
    player.cardSlots[cardId] = slot;
    occupied.add(slot);
  }
  return player.cardSlots;
}

function cardSlot(player: EnginePlayer, cardId: string, fallback = 0): number {
  return player.cardSlots?.[cardId] ?? fallback;
}

function nextOpenSlot(player: EnginePlayer): number {
  const occupied = new Set(Object.values(ensureCardSlots(player)));
  let slot = 0;
  while (occupied.has(slot)) slot += 1;
  return slot;
}

function addOwnedCard(player: EnginePlayer, cardId: string, preferredSlot?: number): void {
  const slots = ensureCardSlots(player);
  const slot = preferredSlot ?? nextOpenSlot(player);
  if (Object.values(slots).includes(slot)) fail('SLOT_OCCUPIED', 'That card position is already occupied.');
  player.cards.push(cardId);
  slots[cardId] = slot;
}

function removeOwnedCard(player: EnginePlayer, cardId: string): number {
  const index = player.cards.indexOf(cardId);
  if (index < 0) fail('NOT_OWNED', 'That card is not owned by this player.');
  const slots = ensureCardSlots(player);
  const slot = slots[cardId];
  player.cards.splice(index, 1);
  delete slots[cardId];
  return slot;
}

function replaceOwnedCard(player: EnginePlayer, targetCardId: string, replacementCardId: string): void {
  const index = player.cards.indexOf(targetCardId);
  if (index < 0) fail('NOT_OWNED', 'That card is not owned by this player.');
  const slots = ensureCardSlots(player);
  const slot = slots[targetCardId] ?? index;
  player.cards[index] = replacementCardId;
  delete slots[targetCardId];
  slots[replacementCardId] = slot;
}

function getPlayer(state: GameState, playerId: string): EnginePlayer {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) fail('PLAYER_NOT_FOUND', 'Player is not part of this game.');
  return player;
}

function activePlayers(state: GameState): EnginePlayer[] {
  return state.players.filter((player) => !player.forfeited);
}

function requirePhase(state: GameState, phase: GamePhase): void {
  if (state.phase !== phase) fail('WRONG_PHASE', `This action requires the ${phase} phase.`);
}

function requireActiveGame(state: GameState): void {
  if (state.phase !== 'playing' && state.phase !== 'ending') fail('WRONG_PHASE', 'The round is not active.');
}

function requireTurnCommand(state: GameState, playerId: string, stage: TurnStage): void {
  requireActiveGame(state);
  if (state.transfer) fail('TRANSFER_PENDING', 'A mandatory transfer must finish first.');
  if (state.turn?.playerId !== playerId) fail('NOT_YOUR_TURN', 'It is not your turn.');
  if (state.turn.stage !== stage) fail('WRONG_STAGE', `This action requires the ${stage} turn stage.`);
}

function drawCard(state: GameState, random: () => number): string | undefined {
  if (state.deck.length === 0) {
    if (state.discard.length <= 1) return undefined;
    const top = state.discard.pop()!;
    state.deck = shuffle(state.discard, random);
    state.discard = [top];
  }
  return state.deck.pop();
}

function openDiscard(state: GameState, cardId: string): void {
  state.discard.push(cardId);
  state.discardGeneration += 1;
  state.stackOpen = true;
}

function discardDrawn(
  state: GameState,
  player: EnginePlayer,
  now: number,
  effects: GameEffect[],
): void {
  const cardId = state.turn?.drawnCardId;
  if (!cardId) fail('NO_DRAW', 'No card has been drawn.');
  openDiscard(state, cardId);
  const power = powerFor(state.cards[cardId]);
  if (power && hasLegalPowerTarget(state, player, power)) {
    state.turn = { playerId: player.id, stage: 'power', power: { kind: power, status: 'selecting', targets: [] }, deadlineAt: now + TURN_MS };
    effects.push({ type: 'power', playerId: player.id });
  } else {
    endTurn(state, now, effects);
  }
}

function hasLegalPowerTarget(state: GameState, player: EnginePlayer, power: PowerKind): boolean {
  const opponentsHaveCards = activePlayers(state).some((candidate) => candidate.id !== player.id && candidate.cards.length > 0);
  if (power === 'own_peek') return player.cards.length > 0;
  if (power === 'opponent_peek') return opponentsHaveCards;
  if (power === 'blind_swap') return player.cards.length > 0 && opponentsHaveCards;
  return opponentsHaveCards;
}

function selectPowerTarget(
  state: GameState,
  player: EnginePlayer,
  cardId: string,
  effects: GameEffect[],
  now: number,
): void {
  const power = state.turn?.power;
  if (!power || power.status === 'offered') fail('POWER_NOT_STARTED', 'Start the power before selecting cards.');
  const owner = state.players.find((candidate) => candidate.cards.includes(cardId) && !candidate.forfeited);
  if (!owner) fail('BAD_TARGET', 'That card cannot be targeted.');

  if ((power.kind === 'blind_swap' || power.kind === 'black_king') && power.targets.length === 1) {
    const firstOwner = state.players.find((candidate) => candidate.cards.includes(power.targets[0]) && !candidate.forfeited);
    if (!firstOwner || firstOwner.id !== player.id) {
      power.targets = [];
      effects.push({ type: 'power', playerId: player.id, message: 'The selected card moved. Choose one of your cards again.' });
      if (owner.id !== player.id) return;
    }
  }

  if (power.kind === 'own_peek') {
    if (owner.id !== player.id) fail('OWN_TARGET_REQUIRED', 'Choose one of your cards.');
    power.targets = [cardId];
    power.status = 'revealing';
  } else if (power.kind === 'opponent_peek') {
    if (owner.id === player.id) fail('OPPONENT_TARGET_REQUIRED', "Choose an opponent's card.");
    power.targets = [cardId];
    power.status = 'revealing';
  } else if (power.kind === 'blind_swap') {
    if (power.targets.length === 0) {
      if (owner.id !== player.id) fail('OWN_TARGET_REQUIRED', 'Choose one of your cards first.');
      power.targets = [cardId];
    } else {
      if (owner.id === player.id) fail('OPPONENT_TARGET_REQUIRED', "Choose an opponent's card.");
      const summary = swapOwnedCards(state, power.targets[0], cardId);
      effects.push({ type: 'power', playerId: player.id, message: `Blind swap · ${summary}.` });
      endTurn(state, now, effects);
      return;
    }
  } else {
    if (player.cards.length === 0) {
      if (owner.id === player.id) fail('OPPONENT_TARGET_REQUIRED', "Choose an opponent's card.");
      power.targets = [cardId];
      power.status = 'revealing';
    } else if (power.targets.length === 0) {
      if (owner.id !== player.id) fail('OWN_TARGET_REQUIRED', 'Choose one of your cards first.');
      power.targets = [cardId];
    } else {
      if (owner.id === player.id) fail('OPPONENT_TARGET_REQUIRED', "Choose an opponent's card.");
      power.targets.push(cardId);
      power.status = 'revealing';
    }
  }
  if (power.status === 'revealing') {
    state.temporaryReveals[player.id] = [...power.targets];
    effects.push({ type: 'power', playerId: player.id, cardIds: [...power.targets] });
  }
}

function completePower(
  state: GameState,
  player: EnginePlayer,
  swap: boolean,
  effects: GameEffect[],
  now: number,
): void {
  const power = state.turn?.power;
  const canComplete = power?.kind === 'black_king' ? power.status === 'choosing' : power?.status === 'revealing';
  if (!power || !canComplete) fail('POWER_NOT_REVEALED', 'Finish viewing the power targets first.');
  if (power.kind === 'black_king' && swap && power.targets.length === 2) {
    if (canSwapOwnedCards(state, power.targets[0], power.targets[1])) {
      const summary = swapOwnedCards(state, power.targets[0], power.targets[1]);
      effects.push({ type: 'power', playerId: player.id, message: `Black King · ${summary}.` });
    } else {
      effects.push({ type: 'power', playerId: player.id, message: 'A selected card moved before the swap, so the cards stay where they are.' });
    }
  }
  delete state.temporaryReveals[player.id];
  endTurn(state, now, effects);
}

function swapOwnedCards(state: GameState, firstId: string, secondId: string): string {
  const firstOwner = state.players.find((player) => player.cards.includes(firstId));
  const secondOwner = state.players.find((player) => player.cards.includes(secondId));
  if (!firstOwner || !secondOwner || firstOwner.id === secondOwner.id) fail('BAD_SWAP', 'Choose cards owned by different players.');
  const firstSlot = cardSlot(firstOwner, firstId, firstOwner.cards.indexOf(firstId));
  const secondSlot = cardSlot(secondOwner, secondId, secondOwner.cards.indexOf(secondId));
  firstOwner.cards[firstOwner.cards.indexOf(firstId)] = secondId;
  secondOwner.cards[secondOwner.cards.indexOf(secondId)] = firstId;
  ensureCardSlots(firstOwner);
  ensureCardSlots(secondOwner);
  delete firstOwner.cardSlots[firstId];
  delete secondOwner.cardSlots[secondId];
  firstOwner.cardSlots[secondId] = firstSlot;
  secondOwner.cardSlots[firstId] = secondSlot;
  return `${firstOwner.name} ${slotCode(firstSlot)} ↔ ${secondOwner.name} ${slotCode(secondSlot)}`;
}

function slotCode(slot: number): string {
  return slot === 0 ? 'TL' : slot === 1 ? 'TR' : slot === 2 ? 'BL' : slot === 3 ? 'BR' : `+${slot - 3}`;
}

function canSwapOwnedCards(state: GameState, firstId: string, secondId: string): boolean {
  const firstOwner = state.players.find((player) => player.cards.includes(firstId));
  const secondOwner = state.players.find((player) => player.cards.includes(secondId));
  return Boolean(firstOwner && secondOwner && firstOwner.id !== secondOwner.id);
}

function transferCard(state: GameState, cardId: string, now: number, effects: GameEffect[]): void {
  const transfer = state.transfer!;
  const from = getPlayer(state, transfer.fromPlayerId);
  const to = getPlayer(state, transfer.toPlayerId);
  if (!from.cards.includes(cardId)) fail('NOT_OWNED', 'Choose one of your cards to give.');
  removeOwnedCard(from, cardId);
  addOwnedCard(to, cardId);
  state.transfer = undefined;
  effects.push({ type: 'transfer', playerId: from.id, message: `${from.name} gave a hidden card to ${to.name}.` });
  if (from.cards.length === 0) triggerEnding(state, from.id, 'zero_cards');
  if (state.turn) state.turn.deadlineAt = now + TURN_MS;
}

function triggerEnding(state: GameState, triggerPlayerId: string, reason: EndingState['reason']): void {
  if (state.ending || !state.turn) return;
  const order = state.turnOrder.filter((id) => !getPlayer(state, id).forfeited);
  const activeIndex = order.indexOf(state.turn.playerId);
  const triggerIndex = order.indexOf(triggerPlayerId);
  if (activeIndex < 0 || triggerIndex < 0) return;
  const segmentOne: string[] = [];
  if (state.turn.playerId !== triggerPlayerId) {
    let index = (activeIndex + 1) % order.length;
    while (true) {
      segmentOne.push(order[index]);
      if (order[index] === triggerPlayerId) break;
      index = (index + 1) % order.length;
    }
  }
  const segmentTwo: string[] = [];
  let index = (triggerIndex + 1) % order.length;
  while (true) {
    segmentTwo.push(order[index]);
    if (order[index] === triggerPlayerId) break;
    index = (index + 1) % order.length;
  }
  state.ending = { triggerPlayerId, reason, queue: [...segmentOne, ...segmentTwo] };
  state.phase = 'ending';
}

function startTurn(state: GameState, playerId: string, now: number): void {
  state.temporaryReveals = {};
  state.turn = { playerId, stage: 'awaiting_draw', deadlineAt: now + TURN_MS };
}

function endTurn(state: GameState, now: number, effects: GameEffect[]): void {
  if (!state.turn || state.phase === 'results') return;
  const currentId = state.turn.playerId;
  delete state.temporaryReveals[currentId];
  if (state.ending) {
    state.ending.queue = state.ending.queue.filter((id) => !getPlayer(state, id).forfeited);
    const next = state.ending.queue.shift();
    if (!next) {
      finishRound(state);
      effects.push({ type: 'results' });
      return;
    }
    startTurn(state, next, now);
    effects.push({ type: 'turn', playerId: next });
    return;
  }
  const next = nextActiveTurnPlayer(state, currentId);
  if (!next) {
    finishRound(state);
    effects.push({ type: 'results' });
    return;
  }
  startTurn(state, next, now);
  effects.push({ type: 'turn', playerId: next });
}

function firstActiveTurnPlayer(state: GameState): string | undefined {
  return state.turnOrder.find((id) => !getPlayer(state, id).forfeited);
}

function nextActiveTurnPlayer(state: GameState, currentId: string): string | undefined {
  const currentIndex = state.turnOrder.indexOf(currentId);
  if (currentIndex < 0) return firstActiveTurnPlayer(state);
  for (let offset = 1; offset <= state.turnOrder.length; offset += 1) {
    const candidate = state.turnOrder[(currentIndex + offset) % state.turnOrder.length];
    if (!getPlayer(state, candidate).forfeited) return candidate;
  }
  return undefined;
}

function finishRound(state: GameState): void {
  const scores = state.players.map((player) => ({
    playerId: player.id,
    score: player.forfeited ? null : player.cards.reduce((total, cardId) => total + cardScore(state.cards[cardId]), 0),
    forfeited: player.forfeited,
  }));
  const validScores = scores.flatMap((entry) => (entry.score === null ? [] : [entry.score]));
  const lowest = validScores.length ? Math.min(...validScores) : Number.POSITIVE_INFINITY;
  state.results = scores.map((entry) => ({ ...entry, winner: entry.score === lowest }));
  state.phase = 'results';
  state.turn = undefined;
  state.transfer = undefined;
  state.stackOpen = false;
  state.temporaryReveals = {};
}

function forfeitPlayer(state: GameState, player: EnginePlayer, now: number, effects: GameEffect[]): void {
  if (player.forfeited) return;
  if (state.turn?.playerId === player.id && state.turn.drawnCardId) {
    state.burn.push(state.turn.drawnCardId);
    state.turn.drawnCardId = undefined;
  }
  player.forfeited = true;
  player.connected = false;
  state.burn.push(...player.cards);
  player.cards = [];
  player.cardSlots = {};
  delete state.temporaryReveals[player.id];
  if (state.ending) state.ending.queue = state.ending.queue.filter((id) => id !== player.id);
  if (state.transfer && (state.transfer.fromPlayerId === player.id || state.transfer.toPlayerId === player.id)) state.transfer = undefined;
  effects.push({ type: 'forfeit', playerId: player.id });
  if (activePlayers(state).length <= 1) {
    finishRound(state);
    effects.push({ type: 'results' });
  } else if (state.phase === 'initial_peek' && activePlayers(state).every((candidate) => candidate.initialPeekComplete)) {
    state.phase = 'playing';
    const first = firstActiveTurnPlayer(state);
    if (!first) fail('NO_ACTIVE_PLAYER', 'No active player can begin the round.');
    startTurn(state, first, now);
    effects.push({ type: 'turn', playerId: first });
  } else if (state.turn?.playerId === player.id) {
    endTurn(state, now, effects);
  }
}

function handleTimeout(
  state: GameState,
  player: EnginePlayer,
  now: number,
  random: () => number,
  effects: GameEffect[],
): void {
  if (state.phase === 'initial_peek') {
    player.initialPeekOpen = false;
    player.initialPeekComplete = true;
    delete state.temporaryReveals[player.id];
    if (activePlayers(state).every((candidate) => candidate.initialPeekComplete)) {
      state.phase = 'playing';
      const first = firstActiveTurnPlayer(state);
      if (!first) fail('NO_ACTIVE_PLAYER', 'No active player can begin the round.');
      startTurn(state, first, now);
      effects.push({ type: 'turn', playerId: first });
    }
    return;
  }
  if (state.transfer?.fromPlayerId === player.id) {
    const cardId = player.cards[Math.floor(random() * player.cards.length)];
    if (cardId) transferCard(state, cardId, now, effects);
    return;
  }
  if (state.turn?.playerId !== player.id) fail('NOT_TIMED_PLAYER', 'This player has no expiring action.');
  if (state.turn.stage === 'awaiting_draw') {
    const cardId = drawCard(state, random);
    if (!cardId) return finishRound(state);
    state.turn.drawnCardId = cardId;
    state.turn.stage = 'deciding';
  }
  if (state.turn.stage === 'deciding') {
    const cardId = state.turn.drawnCardId!;
    openDiscard(state, cardId);
  }
  endTurn(state, now, effects);
}

function fail(code: string, message: string): never {
  throw new GameRuleError(code, message);
}
