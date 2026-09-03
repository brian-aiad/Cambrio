import { describe, expect, it } from 'vitest';
import { applyGameCommand, createGame, type GameState, type Rank, type Suit } from './game.js';

const participants = Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}`, userId: `u${index + 1}`, name: `Player ${index + 1}` }));
const random = () => 0.41;

function ready(count = 8): GameState {
  let state = createGame(`race-${count}`, participants.slice(0, count), 1_000, random);
  for (const player of [...state.players]) {
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_001, random).state;
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_002, random).state;
  }
  return state;
}

function openStack(state: GameState, rank: Rank = '6', suit?: Suit): GameState {
  const active = state.turn!.playerId;
  const cardId = state.deck.find((id) => state.cards[id].rank === rank && (!suit || state.cards[id].suit === suit))!;
  const index = state.deck.indexOf(cardId);
  [state.deck[index], state.deck[state.deck.length - 1]] = [state.deck.at(-1)!, cardId];
  state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_000, random).state;
  return applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: active }, 2_001, random).state;
}

function cardCount(state: GameState): number {
  return state.deck.length + state.discard.length + state.burn.length + state.players.reduce((sum, player) => sum + player.cards.length, 0) + (state.turn?.drawnCardId ? 1 : 0);
}

describe('authoritative stack race classification', () => {
  it('classifies one same-generation winner and every later matching attempt as race lost without penalties', () => {
    let state = openStack(ready());
    const generation = state.discardGeneration;
    const attempts = state.players.map((player) => {
      const targetCardId = player.cards[0];
      state.cards[targetCardId].rank = '6';
      return { playerId: player.id, targetCardId };
    });
    const beforeCounts = new Map(state.players.map((player) => [player.id, player.cards.length]));
    const beforeTotal = cardCount(state);

    const winner = applyGameCommand(state, { type: 'STACK_ATTEMPT', ...attempts[0], discardGeneration: generation }, 2_010, random);
    expect(winner.outcome).toBe('stack_success');
    state = winner.state;
    const winningVersion = state.version;

    for (const attempt of attempts.slice(1)) {
      const result = applyGameCommand(state, { type: 'STACK_ATTEMPT', ...attempt, discardGeneration: generation }, 2_011, random);
      expect(result).toMatchObject({ outcome: 'stack_race_lost', actorPlayerId: attempts[0].playerId, effects: [] });
      expect(result.state.version).toBe(winningVersion);
      expect(result.state.players.find((player) => player.id === attempt.playerId)?.cards).toHaveLength(beforeCounts.get(attempt.playerId)!);
      state = result.state;
    }
    expect(cardCount(state)).toBe(beforeTotal);
    expect(state.discardGeneration).toBe(generation);
    expect(state.discard.at(-1)).toBe(attempts[0].targetCardId);
  });

  it('penalizes a wrong attempt processed before the winner, but not the same stale attempt after the winner', () => {
    const state = openStack(ready(3));
    const generation = state.discardGeneration;
    const wrongPlayer = state.players[1];
    const winner = state.players[2];
    const wrongCard = wrongPlayer.cards[0];
    const correctCard = winner.cards[0];
    state.cards[wrongCard].rank = '5';
    state.cards[correctCard].rank = '6';
    const wrongBefore = wrongPlayer.cards.length;

    const wrong = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: wrongPlayer.id, targetCardId: wrongCard, discardGeneration: generation }, 2_010, random);
    expect(wrong.outcome).toBe('stack_wrong');
    expect(wrong.state.players.find((player) => player.id === wrongPlayer.id)?.cards).toHaveLength(wrongBefore + 1);
    const success = applyGameCommand(wrong.state, { type: 'STACK_ATTEMPT', playerId: winner.id, targetCardId: correctCard, discardGeneration: generation }, 2_011, random);
    expect(success.outcome).toBe('stack_success');
    const afterWinner = success.state.players.find((player) => player.id === wrongPlayer.id)!.cards.length;
    const staleWrong = applyGameCommand(success.state, { type: 'STACK_ATTEMPT', playerId: wrongPlayer.id, targetCardId: wrongCard, discardGeneration: generation }, 2_012, random);
    expect(staleWrong.outcome).toBe('stack_race_lost');
    expect(staleWrong.state.players.find((player) => player.id === wrongPlayer.id)?.cards).toHaveLength(afterWinner);
  });

  it('recognizes a race loss before a pending mandatory transfer can block it', () => {
    const state = openStack(ready(3));
    const generation = state.discardGeneration;
    const actor = state.players[1];
    const loser = state.players[2];
    const owner = state.players[0];
    const opponentCard = owner.cards[0];
    const losingCard = loser.cards[0];
    state.cards[opponentCard].rank = '6';
    state.cards[losingCard].rank = '6';
    const won = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: opponentCard, discardGeneration: generation }, 2_010, random);
    expect(won.state.transfer).toMatchObject({ fromPlayerId: actor.id, toPlayerId: owner.id });
    const lost = applyGameCommand(won.state, { type: 'STACK_ATTEMPT', playerId: loser.id, targetCardId: losingCard, discardGeneration: generation }, 2_011, random);
    expect(lost).toMatchObject({ outcome: 'stack_race_lost', actorPlayerId: actor.id, effects: [] });
    expect(lost.state.transfer).toEqual(won.state.transfer);
  });

  it.each([
    ['7', undefined],
    ['9', undefined],
    ['J', undefined],
    ['K', 'clubs'],
  ] as Array<[Rank, Suit | undefined]>)('keeps race classification active during the %s power', (rank, suit) => {
    const state = openStack(ready(3), rank, suit);
    expect(state.turn?.stage).toBe('power');
    const generation = state.discardGeneration;
    const actor = state.players.find((player) => player.id !== state.turn?.playerId)!;
    const target = actor.cards[0];
    state.cards[target].rank = rank;
    const result = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: target, discardGeneration: generation }, 2_010, random);
    expect(result.outcome).toBe('stack_success');
  });

  it('returns blocked, not wrong, when no winner consumed a closed generation', () => {
    let state = openStack(ready(2));
    const generation = state.discardGeneration;
    const active = state.turn!.playerId;
    const other = state.players.find((player) => player.id !== active)!;
    const before = other.cards.length;
    state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_010, random).state;
    const result = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: other.id, targetCardId: other.cards[0], discardGeneration: generation }, 2_011, random);
    expect(result).toMatchObject({ outcome: 'stack_blocked', stackBlockReason: 'discard_closed', effects: [] });
    expect(result.state.players.find((player) => player.id === other.id)?.cards).toHaveLength(before);
  });
});
