import { describe, expect, it } from 'vitest';
import { applyGameCommand, createGame, MAX_HAND_CARDS, projectGame, type GameCommand, type GameState, type PowerKind } from './game.js';

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

function assertCardInvariant(state: GameState, context = '') {
  const locations = [
    ...state.deck,
    ...state.discard,
    ...state.burn,
    ...state.players.flatMap((player) => player.cards),
    ...(state.turn?.drawnCardId ? [state.turn.drawnCardId] : []),
  ];
  if (locations.length !== 52 || new Set(locations).size !== 52) {
    const missing = Object.keys(state.cards).filter((id) => !locations.includes(id));
    const duplicates = locations.filter((id, index) => locations.indexOf(id) !== index);
    throw new Error(`Card conservation failed in ${state.id} v${state.version}${context ? ` (${context})` : ''}: ${locations.length}/52 locations, missing=${missing.join(',') || 'none'}, duplicates=${duplicates.join(',') || 'none'}, phase=${state.phase}, turn=${state.turn?.playerId ?? 'none'}:${state.turn?.stage ?? 'none'}`);
  }
  expect(locations).toHaveLength(52);
  expect(new Set(locations)).toHaveLength(52);
  expect(Object.keys(state.cards)).toHaveLength(52);
  for (const id of locations) expect(state.cards[id]).toBeDefined();
  for (const player of state.players) {
    expect(player.cards.length).toBeLessThanOrEqual(MAX_HAND_CARDS);
    expect(Object.keys(player.cardSlots).sort()).toEqual([...player.cards].sort());
    expect(new Set(Object.values(player.cardSlots)).size).toBe(player.cards.length);
    for (const slot of Object.values(player.cardSlots)) expect(Number.isInteger(slot) && slot >= 0).toBe(true);
  }
  if (state.turn) expect(state.players.find((player) => player.id === state.turn?.playerId)?.forfeited).toBe(false);
  if (state.transfer) {
    expect(state.players.find((player) => player.id === state.transfer?.fromPlayerId)).toMatchObject({ forfeited: false });
    expect(state.players.find((player) => player.id === state.transfer?.fromPlayerId)?.cards.length).toBeGreaterThan(0);
    expect(state.players.find((player) => player.id === state.transfer?.toPlayerId)).toMatchObject({ forfeited: false });
    expect(state.transfer.fromPlayerId).not.toBe(state.transfer.toPlayerId);
  }
  if (state.ending) {
    expect(state.ending.queue.every((id) => !state.players.find((player) => player.id === id)?.forfeited)).toBe(true);
  }
}

function assertProjectionInvariant(state: GameState) {
  const invariant = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Projection invariant failed in ${state.id} v${state.version}: ${message}`);
  };
  for (const viewer of state.players) {
    const view = projectGame(state, viewer.id);
    const revealed = new Set(state.temporaryReveals[viewer.id] ?? []);
    const results = state.phase === 'results';
    for (const player of view.players) {
      const enginePlayer = state.players.find((candidate) => candidate.id === player.id)!;
      const expectedIds = [...enginePlayer.cards].sort((first, second) => enginePlayer.cardSlots[first] - enginePlayer.cardSlots[second]);
      invariant(player.cards.map((card) => card.id).join('|') === expectedIds.join('|'), `${viewer.id} received moved or missing card identities`);
      for (const card of player.cards) {
        const shouldBeVisible = results || revealed.has(card.id);
        invariant((card.rank !== undefined) === shouldBeVisible, `${viewer.id} rank visibility was wrong for ${card.id}`);
        invariant((card.suit !== undefined) === shouldBeVisible, `${viewer.id} suit visibility was wrong for ${card.id}`);
        invariant(card.slot === enginePlayer.cardSlots[card.id], `${viewer.id} received the wrong slot for ${card.id}`);
      }
    }
    invariant(Boolean(view.drawnCard) === Boolean(state.turn?.drawnCardId && state.turn.playerId === viewer.id), `${viewer.id} drawn-card privacy was wrong`);
    invariant(Boolean(view.power) === Boolean(state.turn?.power && state.turn.playerId === viewer.id), `${viewer.id} power privacy was wrong`);
    invariant(Boolean(view.transfer) === Boolean(state.transfer && state.transfer.fromPlayerId === viewer.id), `${viewer.id} transfer privacy was wrong`);
    if (view.discard) {
      invariant(view.discard.rank !== undefined && view.discard.suit !== undefined, 'the public discard was hidden');
    }
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
    return power.kind === 'black_king' ? { type: 'POWER_CONCEAL', playerId: player.id } : { type: 'POWER_COMPLETE', playerId: player.id };
  }
  if (power.status === 'choosing') {
    return { type: 'POWER_COMPLETE', playerId: player.id, swap: random() < 0.5 };
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
  const actors = state.players.filter((player) => !player.forfeited && player.cards.length > 0 && state.stackLocks[player.id] !== state.discardGeneration);
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
    assertProjectionInvariant(state);
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_001, random).state;
    assertProjectionInvariant(state);
  }
  let actions = 0;
  let called = false;
  while (state.phase !== 'results' && actions < 1_000) {
    assertCardInvariant(state);
    assertProjectionInvariant(state);
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
    assertProjectionInvariant(state);
    actions += 1;
  }
  expect(actions).toBeLessThan(1_000);
  expect(state.phase).toBe('results');
  assertCardInvariant(state);
  assertProjectionInvariant(state);
  expect(state.results?.filter((result) => result.winner).length).toBeGreaterThanOrEqual(1);
  return state;
}

function simulateDisruptions(seed: number, playerCount: number, observed = new Set<string>()): GameState {
  const random = seeded(seed * 97);
  const participants = Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, userId: `u${index}`, name: `Player ${index}` }));
  let state = createGame(`disruption-${seed}`, participants, 1_000, random);

  for (const player of [...state.players]) {
    if (player.forfeited) continue;
    const remaining = state.players.filter((candidate) => !candidate.forfeited).length;
    if (remaining > 2 && random() < 0.22) {
      observed.add('initial-forfeit');
      state = applyGameCommand(state, { type: 'FORFEIT_PLAYER', playerId: player.id }, 1_010, random).state;
    } else if (random() < 0.32) {
      observed.add('initial-timeout');
      state = applyGameCommand(state, { type: 'TIMEOUT', playerId: player.id }, 1_011, random).state;
    } else {
      state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_012, random).state;
      state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_013, random).state;
    }
    assertCardInvariant(state, `initial player ${player.id}`);
    assertProjectionInvariant(state);
  }

  let actions = 0;
  let previousCommand: GameCommand | undefined;
  while (state.phase !== 'results' && actions < 1_000) {
    assertCardInvariant(state, `before disruption action ${actions}; previous=${previousCommand ? JSON.stringify(previousCommand) : 'none'}`);
    assertProjectionInvariant(state);
    const active = state.players.filter((player) => !player.forfeited);
    let command: GameCommand;
    if (active.length > 2 && random() < 0.055) {
      observed.add('forfeit');
      command = { type: 'FORFEIT_PLAYER', playerId: choose(active, random).id };
    } else if (state.transfer) {
      const from = state.players.find((player) => player.id === state.transfer?.fromPlayerId)!;
      if (random() < 0.5) {
        observed.add('transfer-timeout');
        command = { type: 'TIMEOUT', playerId: from.id };
      } else command = { type: 'TRANSFER_CARD', playerId: from.id, cardId: choose(from.cards, random) };
    } else if (!state.ending && actions > 18 && random() < 0.2) {
      command = { type: 'CALL_CAMBIO', playerId: choose(active, random).id };
    } else {
      const stack = random() < 0.18 ? possibleStack(state, random) : undefined;
      if (stack) command = stack;
      else if (random() < 0.14) {
        observed.add(`${state.turn!.stage}-timeout`);
        command = { type: 'TIMEOUT', playerId: state.turn!.playerId };
      }
      else if (state.turn!.stage === 'power') command = powerCommand(state, random);
      else if (state.turn!.stage === 'awaiting_draw') command = { type: 'DRAW', playerId: state.turn!.playerId };
      else {
        const player = state.players.find((candidate) => candidate.id === state.turn!.playerId)!;
        command = player.cards.length && random() < 0.5
          ? { type: 'SWAP_DRAWN', playerId: player.id, targetCardId: choose(player.cards, random) }
          : { type: 'DISCARD_DRAWN', playerId: player.id };
      }
    }
    state = applyGameCommand(state, command, 2_000 + actions, random).state;
    previousCommand = command;
    actions += 1;
  }

  expect(actions).toBeLessThan(1_000);
  expect(state.phase).toBe('results');
  assertCardInvariant(state);
  assertProjectionInvariant(state);
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
  }, 60_000);

  it('settles 1,000 competing stack races with one winner and stable slots', () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const random = seeded(seed * 17);
      const playerCount = 2 + (seed % 7);
      const participants = Array.from({ length: playerCount }, (_, index) => ({ id: `p${index}`, userId: `u${index}`, name: `Player ${index}` }));
      let state = createGame(`race-${seed}`, participants, 1_000, random);
      for (const player of [...state.players]) {
        state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_000, random).state;
        state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_001, random).state;
      }

      const activeId = state.turn!.playerId;
      const matchingTarget = state.players.flatMap((player) => player.cards).find((target) => state.deck.some((id) => state.cards[id].rank === state.cards[target].rank))!;
      const owner = state.players.find((player) => player.cards.includes(matchingTarget))!;
      const matchingDraw = state.deck.find((id) => state.cards[id].rank === state.cards[matchingTarget].rank)!;
      const deckIndex = state.deck.indexOf(matchingDraw);
      [state.deck[deckIndex], state.deck[state.deck.length - 1]] = [state.deck.at(-1)!, matchingDraw];
      state = applyGameCommand(state, { type: 'DRAW', playerId: activeId }, 2_000, random).state;
      state = applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_001, random).state;
      const generation = state.discardGeneration;
      const stacker = seed % 2 === 0 ? owner : state.players.find((player) => player.id !== owner.id)!;
      const success = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: stacker.id, targetCardId: matchingTarget, discardGeneration: generation }, 2_002, random);
      state = success.state;
      expect(success.effects.filter((effect) => effect.type === 'stack')).toHaveLength(1);
      expect(state.stackOpen).toBe(false);
      if (state.transfer) {
        const giver = state.players.find((player) => player.id === state.transfer!.fromPlayerId)!;
        state = applyGameCommand(state, { type: 'TRANSFER_CARD', playerId: giver.id, cardId: giver.cards[0] }, 2_003, random).state;
      }
      const staleActor = state.players.find((player) => player.cards.length)!;
      const staleTarget = state.players.flatMap((player) => player.cards)[0];
      expect(() => applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: staleActor.id, targetCardId: staleTarget, discardGeneration: generation }, 2_004, random)).toThrow();
      assertCardInvariant(state);
    }
  }, 20_000);

  it('survives 750 wrong-then-correct stack gambles without moving remembered cards', () => {
    for (let seed = 1; seed <= 750; seed += 1) {
      const random = seeded(seed * 31);
      const participants = Array.from({ length: 2 + (seed % 5) }, (_, index) => ({ id: `p${index}`, userId: `u${index}`, name: `Player ${index}` }));
      let state = createGame(`gamble-${seed}`, participants, 1_000, random);
      for (const player of [...state.players]) {
        state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_000, random).state;
        state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_001, random).state;
      }
      const activeId = state.turn!.playerId;
      const actor = state.players.find((player) => player.id !== activeId)!;
      const beforeSlots = { ...actor.cardSlots };
      const wrongTarget = actor.cards[0];
      const forcedDraw = state.deck.find((id) => state.cards[id].rank !== state.cards[wrongTarget].rank && state.players.flatMap((player) => player.cards).some((target) => state.cards[target].rank === state.cards[id].rank))!;
      const deckIndex = state.deck.indexOf(forcedDraw);
      [state.deck[deckIndex], state.deck[state.deck.length - 1]] = [state.deck.at(-1)!, forcedDraw];
      state = applyGameCommand(state, { type: 'DRAW', playerId: activeId }, 2_000, random).state;
      state = applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_001, random).state;
      const wrong = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: wrongTarget, discardGeneration: state.discardGeneration }, 2_002, random);
      state = wrong.state;
      expect(wrong.effects.some((effect) => effect.type === 'penalty')).toBe(true);
      expect(state.stackOpen).toBe(true);
      for (const [cardId, slot] of Object.entries(beforeSlots)) expect(state.players.find((player) => player.id === actor.id)!.cardSlots[cardId]).toBe(slot);
      const topRank = state.cards[state.discard.at(-1)!].rank;
      const correctTarget = state.players.flatMap((player) => player.cards).find((id) => state.cards[id].rank === topRank)!;
      const correct = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: correctTarget, discardGeneration: state.discardGeneration }, 2_003, random);
      state = correct.state;
      expect(correct.effects.some((effect) => effect.type === 'stack')).toBe(true);
      assertCardInvariant(state);
    }
  }, 20_000);

  it('completes 500 disrupted games with forfeits and every timeout stage', () => {
    const observed = new Set<string>();
    for (let seed = 1; seed <= 500; seed += 1) simulateDisruptions(seed, 2 + (seed % 7), observed);
    expect([...observed]).toEqual(expect.arrayContaining(['initial-forfeit', 'initial-timeout', 'forfeit', 'transfer-timeout', 'awaiting_draw-timeout', 'deciding-timeout', 'power-timeout']));
  }, 45_000);
});
