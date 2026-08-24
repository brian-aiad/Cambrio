import { describe, expect, it } from 'vitest';
import { applyGameCommand, createGame, type GameCommand, type GameState, type PowerKind } from './game.js';

function seeded(seed: number) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

function choose<T>(values: T[], random: () => number): T {
  return values[Math.floor(random() * values.length)];
}

function assertCardInvariant(state: GameState) {
  const locations = [
    ...state.deck,
    ...state.discard,
    ...state.burn,
    ...state.players.flatMap((player) => player.cards),
    ...(state.turn?.drawnCardId ? [state.turn.drawnCardId] : []),
  ];
  expect(locations).toHaveLength(52);
  expect(new Set(locations)).toHaveLength(52);
  expect(Object.keys(state.cards)).toHaveLength(52);
  for (const id of locations) expect(state.cards[id]).toBeDefined();
  if (state.turn) expect(state.players.find((player) => player.id === state.turn?.playerId)?.forfeited).toBe(false);
  if (state.transfer) {
    expect(state.players.find((player) => player.id === state.transfer?.fromPlayerId)?.cards.length).toBeGreaterThan(0);
    expect(state.transfer.fromPlayerId).not.toBe(state.transfer.toPlayerId);
  }
}

function legalOpponentCard(state: GameState, playerId: string): string | undefined {
  return state.players.find((player) => player.id !== playerId && !player.forfeited && player.cards.length)?.cards[0];
}

function powerCommand(state: GameState, random: () => number): GameCommand {
  const turn = state.turn!;
  const player = state.players.find((candidate) => candidate.id === turn.playerId)!;
  const power = turn.power!;
  if (power.status === 'offered') {
    return random() < 0.32 ? { type: 'POWER_DECLINE', playerId: player.id } : { type: 'POWER_USE', playerId: player.id };
  }
  if (power.status === 'revealing') {
    return { type: 'POWER_COMPLETE', playerId: player.id, swap: power.kind === 'black_king' && random() < 0.5 };
  }
  const opponent = legalOpponentCard(state, player.id);
  const own = player.cards[0];
  const selectByPower: Record<PowerKind, string | undefined> = {
    own_peek: own,
    opponent_peek: opponent,
    blind_swap: power.targets.length ? opponent : own,
    black_king: player.cards.length === 0 ? opponent : power.targets.length ? opponent : own,
  };
  const targetCardId = selectByPower[power.kind];
  return targetCardId ? { type: 'POWER_SELECT', playerId: player.id, targetCardId } : { type: 'POWER_DECLINE', playerId: player.id };
}

function possibleStack(state: GameState, random: () => number): GameCommand | undefined {
  if (!state.stackOpen || state.transfer || !state.discard.length) return undefined;
  const actors = state.players.filter((player) => !player.forfeited && player.cards.length);
  if (!actors.length) return undefined;
  const actor = choose(actors, random);
  const allTargets = state.players.filter((player) => !player.forfeited).flatMap((player) => player.cards);
  const topRank = state.cards[state.discard.at(-1)!].rank;
  const matching = allTargets.filter((id) => state.cards[id].rank === topRank);
  const wrong = allTargets.filter((id) => state.cards[id].rank !== topRank);
  const pool = matching.length && random() < 0.62 ? matching : wrong;
  if (!pool.length) return undefined;
  return { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: choose(pool, random), discardGeneration: state.discardGeneration };
}

function simulate(seed: number, playerCount: number): GameState {
  const random = seeded(seed);
  const participants = Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, userId: `u${index}`, name: `Player ${index}` }));
  let state = createGame(`stress-${seed}`, participants, 1_000, random);
  for (const player of [...state.players]) {
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_000, random).state;
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_001, random).state;
  }
  let actions = 0;
  let called = false;
  while (state.phase !== 'results' && actions < 1_000) {
    assertCardInvariant(state);
    let command: GameCommand;
    if (state.transfer) {
      const from = state.players.find((player) => player.id === state.transfer?.fromPlayerId)!;
      command = { type: 'TRANSFER_CARD', playerId: from.id, cardId: choose(from.cards, random) };
    } else if (!called && actions > 28) {
      const caller = choose(state.players.filter((player) => !player.forfeited), random);
      command = { type: 'CALL_CAMBIO', playerId: caller.id };
      called = true;
    } else {
      const stack = random() < 0.16 ? possibleStack(state, random) : undefined;
      if (stack) command = stack;
      else if (state.turn!.stage === 'power') command = powerCommand(state, random);
      else if (state.turn!.stage === 'awaiting_draw') command = { type: 'DRAW', playerId: state.turn!.playerId };
      else {
        const player = state.players.find((candidate) => candidate.id === state.turn!.playerId)!;
        command = player.cards.length && random() < 0.52
          ? { type: 'SWAP_DRAWN', playerId: player.id, targetCardId: choose(player.cards, random) }
          : { type: 'DISCARD_DRAWN', playerId: player.id };
      }
    }
    state = applyGameCommand(state, command, 2_000 + actions, random).state;
    actions += 1;
  }
  expect(actions).toBeLessThan(1_000);
  expect(state.phase).toBe('results');
  assertCardInvariant(state);
  expect(state.results?.filter((result) => result.winner).length).toBeGreaterThanOrEqual(1);
  return state;
}

describe('randomized game stress', () => {
  it('completes 350 deterministic games across every supported room size', () => {
    let completed = 0;
    for (let seed = 1; seed <= 350; seed += 1) {
      simulate(seed, 2 + (seed % 7));
      completed += 1;
    }
    expect(completed).toBe(350);
  }, 30_000);
});

