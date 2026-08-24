import { describe, expect, it } from 'vitest';
import { applyGameCommand, cardScore, createDeck, createGame, projectGame, type GameState } from './game.js';

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
});

describe('hidden information', () => {
  it('reveals only the viewer initial bottom cards while held', () => {
    let game = createGame('game-1', people.slice(0, 2), 1_000, fixedRandom);
    const viewer = game.players[0];
    game = applyGameCommand(game, { type: 'INITIAL_PEEK_START', playerId: viewer.id }, 1_000, fixedRandom).state;
    const view = projectGame(game, viewer.id);
    expect(view.players.find((player) => player.id === viewer.id)!.cards.filter((card) => card.rank)).toHaveLength(2);
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
    game = applyGameCommand(
      game,
      { type: 'STACK_ATTEMPT', playerId: guesser.id, targetCardId: wrongCard, discardGeneration: game.discardGeneration },
      2_100,
      fixedRandom,
    ).state;
    expect(game.players.find((player) => player.id === guesser.id)!.cards).toHaveLength(before + 1);
    expect(game.stackOpen).toBe(true);
  });

  it('allows exactly one successful stack and never chains it', () => {
    let game = readyGame(2);
    const active = game.turn!.playerId;
    const stacker = game.players.find((player) => player.id !== active)!;
    const targetId = stacker.cards[0];
    const matchingDraw = game.deck.find((id) => game.cards[id].rank === game.cards[targetId].rank)!;
    [game.deck[game.deck.indexOf(matchingDraw)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, matchingDraw];
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'STACK_ATTEMPT', playerId: stacker.id, targetCardId: targetId, discardGeneration: game.discardGeneration }, 2_100, fixedRandom).state;
    expect(game.stackOpen).toBe(false);
    expect(game.players.find((player) => player.id === stacker.id)!.cards).toHaveLength(3);
    expect(() => applyGameCommand(game, { type: 'STACK_ATTEMPT', playerId: active, targetCardId: game.players.find((player) => player.id === active)!.cards[0], discardGeneration: game.discardGeneration }, 2_200, fixedRandom)).toThrowError(/no longer stackable/i);
  });
});

describe('special powers', () => {
  it('offers a power only when the drawn card is immediately discarded', () => {
    let game = readyGame(2);
    const active = game.turn!.playerId;
    const seven = game.deck.find((id) => game.cards[id].rank === '7')!;
    [game.deck[game.deck.indexOf(seven)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, seven];
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, fixedRandom).state;
    expect(game.turn).toMatchObject({ playerId: active, stage: 'power', power: { kind: 'own_peek', status: 'offered' } });

    game = applyGameCommand(game, { type: 'POWER_USE', playerId: active }, 2_100, fixedRandom).state;
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
    player.cards[0] = special;
    game.deck[game.deck.indexOf(special)] = original;
    const ordinary = game.deck.find((id) => !['7', '8', '9', '10', 'J', 'Q', 'K'].includes(game.cards[id].rank))!;
    [game.deck[game.deck.indexOf(ordinary)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, ordinary];
    game = applyGameCommand(game, { type: 'DRAW', playerId: active }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'SWAP_DRAWN', playerId: active, targetCardId: special }, 2_100, fixedRandom).state;
    expect(game.discard.at(-1)).toBe(special);
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
    active.cards[0] = firstJack;
    game.deck[game.deck.indexOf(firstJack)] = replacedCard;
    [game.deck[game.deck.indexOf(secondJack)], game.deck[game.deck.length - 1]] = [game.deck.at(-1)!, secondJack];

    game = applyGameCommand(game, { type: 'DRAW', playerId: activeId }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_000, fixedRandom).state;
    game = applyGameCommand(game, { type: 'POWER_USE', playerId: activeId }, 2_100, fixedRandom).state;
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
