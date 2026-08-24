import { describe, expect, it } from 'vitest';
import { applyGameCommand, cardScore, createDeck, createGame, powerFor, projectGame, type GameState, type Rank, type Suit } from './game.js';

const people = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, userId: `u-${id}`, name: id.toUpperCase() }));
const fixedRandom = () => 0.42;

function readyGame(count = 4): GameState {
  let game = createGame('game-1', people.slice(0, count), 1_000, fixedRandom);
  for (const player of [...game.players]) {
    game = applyGameCommand(game, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_000, fixedRandom).state;
  }
  return game;
}

function forceDraw(game: GameState, rank: Rank, suit?: Suit): string {
  const cardId = game.deck.find((id) => game.cards[id].rank === rank && (!suit || game.cards[id].suit === suit))!;
  const index = game.deck.indexOf(cardId);
  [game.deck[index], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, cardId];
  return cardId;
}

function discardForced(game: GameState, rank: Rank, suit?: Suit): GameState {
  const active = game.turn!.playerId;
  forceDraw(game, rank, suit);
  game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
  return applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_001, fixedRandom).state;
}

describe('deck and scoring', () => {
  it('builds a unique 52-card deck without jokers', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((card) => card.id))).toHaveLength(52);
    expect(deck.some((card) => card.rank === ('JOKER' as never))).toBe(false);
  });

  it('scores red kings as -1 and black kings as 10', () => {
    const deck = createDeck();
    expect(cardScore(deck.find((card) => card.id === 'K-hearts')!)).toBe(-1);
    expect(cardScore(deck.find((card) => card.id === 'K-spades')!)).toBe(10);
  });

  it('maps every ability rank and never gives red kings a power', () => {
    const deck = createDeck();
    const powers = (rank: Rank) => [...new Set(deck.filter((card) => card.rank === rank).map((card) => powerFor(card)))];
    expect(powers('7')).toEqual(['own_peek']);
    expect(powers('8')).toEqual(['own_peek']);
    expect(powers('9')).toEqual(['opponent_peek']);
    expect(powers('10')).toEqual(['opponent_peek']);
    expect(powers('J')).toEqual(['blind_swap']);
    expect(powers('Q')).toEqual(['blind_swap']);
    expect(powerFor(deck.find((card) => card.id === 'K-clubs')!)).toBe('black_king');
    expect(powerFor(deck.find((card) => card.id === 'K-spades')!)).toBe('black_king');
    expect(powerFor(deck.find((card) => card.id === 'K-hearts')!)).toBeUndefined();
    expect(powerFor(deck.find((card) => card.id === 'K-diamonds')!)).toBeUndefined();
  });
});

describe('hidden information', () => {
  it('reveals only the viewer initial bottom cards while held', () => {
    let game = createGame('game-1', people.slice(0, 2), 1_000, fixedRandom);
    const viewer = game.players[0];
    game = applyGameCommand(game, { type: 'INITIAL_PEEK_START', playerId: viewer.id }, 1_000, fixedRandom).state;
    const view = projectGame(game, viewer.id);
    const ownCards = view.players.find((player) => player.id === viewer.id)!.cards;
    expect(ownCards.map((card) => card.slot)).toEqual([0, 1, 2, 3]);
    expect(ownCards.filter((card) => card.rank).map((card) => card.slot)).toEqual([2, 3]);
    expect(view.players.find((player) => player.id !== viewer.id)!.cards.some((card) => card.rank)).toBe(false);
  });
});

describe('turns and stacking', () => {
  it('starts with an empty discard and opens stacking on a normal discard', () => {
    let game = readyGame(2);
    expect(game.discard).toEqual([]);
    const active = game.turn!.playerId;
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, fixedRandom).state;
    expect(game.discard).toHaveLength(1);
    expect(game.stackOpen).toBe(true);
  });

  it('penalizes a wrong stack and permits another attempt', () => {
    let game = readyGame(2);
    const active = game.turn!.playerId;
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, fixedRandom).state;
    const guesser = game.players.find((player) => player.id !== active)!;
    const topRank = game.cards[game.discard.at(-1)!].rank;
    const wrongCard = guesser.cards.find((id) => game.cards[id].rank !== topRank)!;
    const before = guesser.cards.length;
    const openSlot = guesser.cardSlots[wrongCard];
    game = applyGameCommand(
      game,
      { type: 'STACK_ATTEMPT', playerId: guesser.id, targetCardId: wrongCard, discardGeneration: game.discardGeneration },
      2_100,
      fixedRandom,
    ).state;
    expect(game.players.find((player) => player.id === guesser.id)!.cards).toHaveLength(before + 1);
    const updated = game.players.find((player) => player.id === guesser.id)!;
    expect(updated.cardSlots[wrongCard]).toBe(openSlot);
    expect(new Set(Object.values(updated.cardSlots)).size).toBe(updated.cards.length);
    expect(game.stackOpen).toBe(true);
  });

  it('allows exactly one successful stack and never chains it', () => {
    let game = readyGame(2);
    const active = game.turn!.playerId;
    const stacker = game.players.find((player) => player.id !== active)!;
    const targetId = stacker.cards[0];
    const rememberedSlots = { ...stacker.cardSlots };
    const matchingDraw = game.deck.find((id) => game.cards[id].rank === game.cards[targetId].rank)!;
    [game.deck[game.deck.indexOf(matchingDraw)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, matchingDraw];
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'STACK_ATTEMPT', playerId: stacker.id, targetCardId: targetId, discardGeneration: game.discardGeneration }, 2_100, fixedRandom).state;
    expect(game.stackOpen).toBe(false);
    const stackedPlayer = game.players.find((player) => player.id === stacker.id)!;
    expect(stackedPlayer.cards).toHaveLength(3);
    for (const cardId of stackedPlayer.cards) expect(stackedPlayer.cardSlots[cardId]).toBe(rememberedSlots[cardId]);
    expect(() => applyGameCommand(game, { type: 'STACK_ATTEMPT', playerId: active, targetCardId: game.players.find((player) => player.id === active)!.cards[0], discardGeneration: game.discardGeneration }, 2_200, fixedRandom)).toThrowError(/no longer stackable/i);
  });

  it('stacks an opponent card into its exact slot, then fills that vacancy with the gifted card', () => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    const active = game.players.find((player) => player.id === activeId)!;
    const stacker = game.players.find((player) => player.id !== activeId)!;
    const opponentCard = active.cards[2];
    const vacatedSlot = active.cardSlots[opponentCard];
    const gift = stacker.cards[1];
    const giftOriginalSlot = stacker.cardSlots[gift];
    const matching = game.deck.find((id) => game.cards[id].rank === game.cards[opponentCard].rank)!;
    const index = game.deck.indexOf(matching);
    [game.deck[index], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, matching];

    game = applyGameCommand(game, { type: 'DRAW', playerId: activeId }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_001, fixedRandom).state;
    const stacked = applyGameCommand(game, { type: 'STACK_ATTEMPT', playerId: stacker.id, targetCardId: opponentCard, discardGeneration: game.discardGeneration }, 2_002, fixedRandom);
    game = stacked.state;
    expect(stacked.effects.some((effect) => effect.type === 'stack')).toBe(true);
    expect(game.transfer).toEqual(expect.objectContaining({ fromPlayerId: stacker.id, toPlayerId: activeId }));
    expect(game.discard.at(-1)).toBe(opponentCard);
    expect(game.players.find((player) => player.id === activeId)!.cardSlots[opponentCard]).toBeUndefined();

    game = applyGameCommand(game, { type: 'TRANSFER_CARD', playerId: stacker.id, cardId: gift }, 2_003, fixedRandom).state;
    const recipient = game.players.find((player) => player.id === activeId)!;
    const giver = game.players.find((player) => player.id === stacker.id)!;
    expect(recipient.cardSlots[gift]).toBe(vacatedSlot);
    expect(giver.cardSlots[gift]).toBeUndefined();
    expect(giftOriginalSlot).toBe(1);
  });

  it('adds a wrong-stack penalty after the four remembered slots without shifting them', () => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    game = discardForced(game, 'A');
    const guesser = game.players.find((player) => player.id !== activeId)!;
    const before = { ...guesser.cardSlots };
    const wrong = guesser.cards.find((id) => game.cards[id].rank !== 'A')!;
    game = applyGameCommand(game, { type: 'STACK_ATTEMPT', playerId: guesser.id, targetCardId: wrong, discardGeneration: game.discardGeneration }, 2_100, fixedRandom).state;
    const updated = game.players.find((player) => player.id === guesser.id)!;
    for (const cardId of Object.keys(before)) expect(updated.cardSlots[cardId]).toBe(before[cardId]);
    const penalty = updated.cards.find((id) => !(id in before))!;
    expect(updated.cardSlots[penalty]).toBe(4);
  });
});

describe('special powers', () => {
  it('starts a power selection immediately when the drawn card is discarded', () => {
    let game = readyGame(2);
    const active = game.turn!.playerId;
    const seven = game.deck.find((id) => game.cards[id].rank === '7')!;
    [game.deck[game.deck.indexOf(seven)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, seven];
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, fixedRandom).state;
    expect(game.turn).toMatchObject({ playerId: active, stage: 'power', power: { kind: 'own_peek', status: 'selecting' } });

    const ownCard = game.players.find((player) => player.id === active)!.cards[0];
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: active, targetCardId: ownCard }, 2_100, fixedRandom).state;
    expect(projectGame(game, active).players.find((player) => player.id === active)!.cards.find((card) => card.id === ownCard)?.rank).toBeDefined();
    const opponent = game.players.find((player) => player.id !== active)!;
    expect(projectGame(game, opponent.id).players.flatMap((player) => player.cards).some((card) => card.rank)).toBe(false);
  });

  it('does not activate a special card swapped out of a hand', () => {
    let game = readyGame(2);
    const active = game.turn!.playerId;
    const player = game.players.find((candidate) => candidate.id === active)!;
    const special = game.deck.find((id) => game.cards[id].rank === '8')!;
    const original = player.cards[0];
    const originalSlot = player.cardSlots[original];
    player.cards[0] = special;
    delete player.cardSlots[original];
    player.cardSlots[special] = originalSlot;
    game.deck[game.deck.indexOf(special)] = original;
    const ordinary = game.deck.find((id) => !['7', '8', '9', '10', 'J', 'Q', 'K'].includes(game.cards[id].rank))!;
    [game.deck[game.deck.indexOf(ordinary)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, ordinary];
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'SWAP_DRAWN', playerId: active, targetCardId: special }, 2_100, fixedRandom).state;
    expect(game.discard.at(-1)).toBe(special);
    expect(game.players.find((candidate) => candidate.id === active)!.cardSlots[ordinary]).toBe(originalSlot);
    expect(game.turn?.stage).toBe('awaiting_draw');
    expect(game.turn?.playerId).not.toBe(active);
  });

  it('recovers when a concurrent stack moves the first blind-swap target', () => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    const active = game.players.find((player) => player.id === activeId)!;
    const opponent = game.players.find((player) => player.id !== activeId)!;
    const [firstJack, secondJack] = game.deck.filter((id) => game.cards[id].rank === 'J').slice(0, 2);

    const replacedCard = active.cards[0];
    const replacedSlot = active.cardSlots[replacedCard];
    active.cards[0] = firstJack;
    delete active.cardSlots[replacedCard];
    active.cardSlots[firstJack] = replacedSlot;
    game.deck[game.deck.indexOf(firstJack)] = replacedCard;
    [game.deck[game.deck.indexOf(secondJack)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, secondJack];

    game = applyGameCommand(game, { type: 'DRAW', playerId: activeId }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: firstJack }, 2_200, fixedRandom).state;

    game = applyGameCommand(
      game,
      { type: 'STACK_ATTEMPT', playerId: opponent.id, targetCardId: firstJack, discardGeneration: game.discardGeneration },
      2_300,
      fixedRandom,
    ).state;
    game = applyGameCommand(game, { type: 'TRANSFER_CARD', playerId: opponent.id, cardId: opponent.cards[0] }, 2_400, fixedRandom).state;

    const opponentTarget = game.players.find((player) => player.id === opponent.id)!.cards[0];
    const reset = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: opponentTarget }, 2_500, fixedRandom);
    game = reset.state;
    expect(game.turn?.power?.targets).toEqual([]);
    expect(reset.effects.some((effect) => effect.message?.includes('selected card moved'))).toBe(true);

    const newOwnTarget = game.players.find((player) => player.id === activeId)!.cards[0];
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: newOwnTarget }, 2_600, fixedRandom).state;
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: opponentTarget }, 2_700, fixedRandom).state;
    expect(game.turn?.playerId).toBe(opponent.id);
    expect(game.turn?.stage).toBe('awaiting_draw');
  });

  it.each(['9', '10'] as const)('%s reveals only the chosen opponent card to the acting player', (rank) => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    const active = game.players.find((player) => player.id === activeId)!;
    const opponent = game.players.find((player) => player.id !== activeId)!;
    game = discardForced(game, rank);
    expect(game.turn?.power).toMatchObject({ kind: 'opponent_peek', status: 'selecting' });
    expect(() => applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: active.cards[0] }, 2_100, fixedRandom)).toThrowError(/opponent/i);
    const target = opponent.cards[3];
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: target }, 2_101, fixedRandom).state;
    const actorView = projectGame(game, activeId);
    const opponentView = projectGame(game, opponent.id);
    expect(actorView.players.flatMap((player) => player.cards).find((card) => card.id === target)?.rank).toBeDefined();
    expect(opponentView.players.flatMap((player) => player.cards).find((card) => card.id === target)?.rank).toBeUndefined();
  });

  it.each(['J', 'Q'] as const)('%s blind-swaps card identities while both table positions stay fixed', (rank) => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    const active = game.players.find((player) => player.id === activeId)!;
    const opponent = game.players.find((player) => player.id !== activeId)!;
    const ownTarget = active.cards[1];
    const opponentTarget = opponent.cards[2];
    const ownSlot = active.cardSlots[ownTarget];
    const opponentSlot = opponent.cardSlots[opponentTarget];
    game = discardForced(game, rank);
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: ownTarget }, 2_100, fixedRandom).state;
    expect(game.turn?.power?.targets).toEqual([ownTarget]);
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: opponentTarget }, 2_101, fixedRandom).state;
    const updatedActive = game.players.find((player) => player.id === activeId)!;
    const updatedOpponent = game.players.find((player) => player.id === opponent.id)!;
    expect(updatedActive.cardSlots[opponentTarget]).toBe(ownSlot);
    expect(updatedOpponent.cardSlots[ownTarget]).toBe(opponentSlot);
    expect(game.temporaryReveals[activeId]).toBeUndefined();
  });

  it('Black King privately reveals one own and one opponent card, then swaps only after confirmation', () => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    const active = game.players.find((player) => player.id === activeId)!;
    const opponent = game.players.find((player) => player.id !== activeId)!;
    const ownTarget = active.cards[0];
    const opponentTarget = opponent.cards[3];
    const ownSlot = active.cardSlots[ownTarget];
    const opponentSlot = opponent.cardSlots[opponentTarget];
    const availableBlackKing = game.deck.find((id) => game.cards[id].rank === 'K' && ['clubs', 'spades'].includes(game.cards[id].suit))!;
    game = discardForced(game, 'K', game.cards[availableBlackKing].suit);
    expect(game.turn?.power).toMatchObject({ kind: 'black_king', status: 'selecting' });
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: ownTarget }, 2_100, fixedRandom).state;
    game = applyGameCommand(game, { type: 'POWER_SELECT', playerId: activeId, targetCardId: opponentTarget }, 2_101, fixedRandom).state;
    expect(game.temporaryReveals[activeId]).toEqual([ownTarget, opponentTarget]);
    const actorCards = projectGame(game, activeId).players.flatMap((player) => player.cards);
    const opponentCards = projectGame(game, opponent.id).players.flatMap((player) => player.cards);
    expect(actorCards.filter((card) => [ownTarget, opponentTarget].includes(card.id)).every((card) => card.rank)).toBe(true);
    expect(opponentCards.filter((card) => [ownTarget, opponentTarget].includes(card.id)).every((card) => !card.rank)).toBe(true);

    game = applyGameCommand(game, { type: 'POWER_COMPLETE', playerId: activeId, swap: true }, 2_102, fixedRandom).state;
    expect(game.players.find((player) => player.id === activeId)!.cardSlots[opponentTarget]).toBe(ownSlot);
    expect(game.players.find((player) => player.id === opponent.id)!.cardSlots[ownTarget]).toBe(opponentSlot);
    expect(game.temporaryReveals[activeId]).toBeUndefined();
  });

  it.each(['hearts', 'diamonds'] as const)('red King of %s ends the turn without offering Black King controls', (suit) => {
    let game = readyGame(2);
    const activeId = game.turn!.playerId;
    game = discardForced(game, 'K', suit);
    expect(game.turn?.playerId).not.toBe(activeId);
    expect(game.turn?.stage).toBe('awaiting_draw');
    expect(game.turn?.power).toBeUndefined();
  });
});

describe('caller-centered ending queue', () => {
  it('finishes through an out-of-turn caller and then runs one complete rotation', () => {
    const game = readyGame(4);
    const [active, next, third, fourth] = game.turnOrder;
    expect(game.turn!.playerId).toBe(active);
    const result = applyGameCommand(game, { type: 'CALL_CAMBIO', playerId: third }, 2_000, fixedRandom).state;
    expect(result.ending?.queue).toEqual([next, third, fourth, active, next, third]);
  });

  it('counts the trigger player current turn before one final rotation', () => {
    const game = readyGame(4);
    const [active, second, third, fourth] = game.turnOrder;
    const result = applyGameCommand(game, { type: 'CALL_CAMBIO', playerId: active }, 2_000, fixedRandom).state;
    expect(result.ending?.queue).toEqual([second, third, fourth, active]);
  });

  it('reveals and scores after every queued turn safely times out', () => {
    let game = readyGame(2);
    const caller = game.turn!.playerId;
    game = applyGameCommand(game, { type: 'CALL_CAMBIO', playerId: caller }, 2_000, fixedRandom).state;
    while (game.phase !== 'results') {
      game = applyGameCommand(game, { type: 'TIMEOUT', playerId: game.turn!.playerId }, 100_000 + game.version, fixedRandom).state;
    }
    expect(game.results).toHaveLength(2);
    expect(game.results?.some((result) => result.winner)).toBe(true);
    expect(projectGame(game, caller).players.flatMap((player) => player.cards).every((card) => card.rank)).toBe(true);
  });
});
