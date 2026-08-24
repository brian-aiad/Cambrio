import { describe, expect, it } from 'vitest';
import { applyGameCommand, createGame, MAX_HAND_CARDS, projectGame, type GameState, type Rank, type Suit } from './game.js';

const participants = Array.from({ length: 4 }, (_, index) => ({ id: `p${index}`, userId: `u${index}`, name: `Player ${index}` }));
const random = () => 0.37;

function ready(count = 2): GameState {
  let state = createGame('edge-game', participants.slice(0, count), 1_000, random);
  for (const player of [...state.players]) {
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_001, random).state;
    state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_002, random).state;
  }
  return state;
}

function topDeck(state: GameState, rank: Rank, suit?: Suit): string {
  const cardId = state.deck.find((id) => state.cards[id].rank === rank && (!suit || state.cards[id].suit === suit))!;
  const index = state.deck.indexOf(cardId);
  [state.deck[index], state.deck[state.deck.length - 1]] = [state.deck.at(-1)!, cardId];
  return cardId;
}

function drawAndDiscard(state: GameState, rank?: Rank, suit?: Suit): GameState {
  const active = state.turn!.playerId;
  if (rank) topDeck(state, rank, suit);
  state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_000, random).state;
  return applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: active }, 2_001, random).state;
}

function emptyHand(state: GameState, playerId: string): void {
  const player = state.players.find((candidate) => candidate.id === playerId)!;
  state.burn.push(...player.cards);
  player.cards = [];
  player.cardSlots = {};
}

describe('command safety matrix', () => {
  it('keeps the previous discard stackable until the active player draws, then closes it', () => {
    let state = ready(2);
    const first = state.turn!.playerId;
    state = drawAndDiscard(state, '6', 'hearts');
    const next = state.turn!.playerId;
    const nextPlayer = state.players.find((player) => player.id === next)!;
    const target = nextPlayer.cards[0];
    state.cards[target].rank = '6';

    expect(state.stackOpen).toBe(true);
    const beforeDraw = applyGameCommand(state, {
      type: 'STACK_ATTEMPT',
      playerId: next,
      targetCardId: target,
      discardGeneration: state.discardGeneration,
    }, 2_010, random);
    expect(beforeDraw.effects.some((effect) => effect.type === 'stack')).toBe(true);

    state = drawAndDiscard(ready(2), '6', 'hearts');
    const active = state.turn!.playerId;
    const other = state.players.find((player) => player.id !== active)!;
    const lateTarget = other.cards[0];
    state.cards[lateTarget].rank = '6';
    const generation = state.discardGeneration;
    state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_020, random).state;
    expect(state.stackOpen).toBe(false);
    expect(() => applyGameCommand(state, {
      type: 'STACK_ATTEMPT',
      playerId: other.id,
      targetCardId: lateTarget,
      discardGeneration: generation,
    }, 2_021, random)).toThrowError(/no longer stackable/i);
    expect(first).toBeDefined();
  });

  it('rejects out-of-turn draws, early discards, foreign swaps, and duplicate peeks', () => {
    let state = ready(2);
    const active = state.turn!.playerId;
    const other = state.players.find((player) => player.id !== active)!;
    expect(() => applyGameCommand(state, { type: 'DRAW', playerId: other.id }, 2_000, random)).toThrowError(/not your turn/i);
    expect(() => applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: active }, 2_000, random)).toThrowError(/deciding/i);
    state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_001, random).state;
    expect(() => applyGameCommand(state, { type: 'SWAP_DRAWN', playerId: active, targetCardId: other.cards[0] }, 2_002, random)).toThrowError(/owned/i);
    expect(() => applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: active }, 2_003, random)).toThrowError(/initial_peek/i);
  });

  it('declines every optional power cleanly and advances exactly one turn', () => {
    for (const [rank, suit] of [['7'], ['9'], ['J'], ['K', 'clubs']] as Array<[Rank, Suit?]>) {
      let state = ready(2);
      const active = state.turn!.playerId;
      state = drawAndDiscard(state, rank, suit);
      expect(state.turn?.stage).toBe('power');
      state = applyGameCommand(state, { type: 'POWER_DECLINE', playerId: active }, 2_100, random).state;
      expect(state.turn?.playerId).not.toBe(active);
      expect(state.turn?.stage).toBe('awaiting_draw');
      expect(state.temporaryReveals[active]).toBeUndefined();
    }
  });

  it('keeps both Black King card positions when the player chooses not to swap', () => {
    let state = ready(2);
    const activeId = state.turn!.playerId;
    const active = state.players.find((player) => player.id === activeId)!;
    const opponent = state.players.find((player) => player.id !== activeId)!;
    const own = active.cards[0];
    const theirs = opponent.cards[0];
    const beforeOwn = active.cardSlots[own];
    const beforeTheirs = opponent.cardSlots[theirs];
    const blackKing = state.deck.find((id) => state.cards[id].rank === 'K' && ['clubs', 'spades'].includes(state.cards[id].suit))!;
    state = drawAndDiscard(state, 'K', state.cards[blackKing].suit);
    state = applyGameCommand(state, { type: 'POWER_SELECT', playerId: activeId, targetCardId: own }, 2_100, random).state;
    state = applyGameCommand(state, { type: 'POWER_SELECT', playerId: activeId, targetCardId: theirs }, 2_101, random).state;
    state = applyGameCommand(state, { type: 'POWER_CONCEAL', playerId: activeId }, 2_102, random).state;
    state = applyGameCommand(state, { type: 'POWER_COMPLETE', playerId: activeId, swap: false }, 2_103, random).state;
    expect(state.players.find((player) => player.id === activeId)!.cardSlots[own]).toBe(beforeOwn);
    expect(state.players.find((player) => player.id === opponent.id)!.cardSlots[theirs]).toBe(beforeTheirs);
  });

  it('matches stacks by rank across different suits', () => {
    let state = ready(2);
    const activeId = state.turn!.playerId;
    const stacker = state.players.find((player) => player.id !== activeId)!;
    const target = stacker.cards[0];
    state.cards[target].rank = '6';
    state.cards[target].suit = 'clubs';
    state = drawAndDiscard(state, '6', 'hearts');
    const result = applyGameCommand(state, {
      type: 'STACK_ATTEMPT',
      playerId: stacker.id,
      targetCardId: target,
      discardGeneration: state.discardGeneration,
    }, 2_100, random);
    expect(result.effects.some((effect) => effect.type === 'stack')).toBe(true);
    expect(result.state.players.find((player) => player.id === stacker.id)!.cards).not.toContain(target);
  });

  it('caps a player at six cards and blocks risk-free stack spam at the limit', () => {
    let state = ready(2);
    const activeId = state.turn!.playerId;
    const actor = state.players.find((player) => player.id !== activeId)!;
    const wrongTarget = actor.cards[0];
    const discardRank = state.cards[wrongTarget].rank === '6' ? '5' : '6';
    state = drawAndDiscard(state, discardRank);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: wrongTarget, discardGeneration: state.discardGeneration }, 2_100 + attempt, random);
      expect(result.effects.some((effect) => effect.type === 'penalty')).toBe(true);
      state = result.state;
    }
    expect(state.players.find((player) => player.id === actor.id)!.cards).toHaveLength(MAX_HAND_CARDS);
    expect(() => applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: actor.id, targetCardId: wrongTarget, discardGeneration: state.discardGeneration }, 2_200, random)).toThrowError(/six cards/i);
    expect(state.players.find((player) => player.id === actor.id)!.cards).toHaveLength(MAX_HAND_CARDS);
  });
});

describe('zero-card irreversibility', () => {
  it('auto-discards a zero-card draw, still permits an opponent-peek power, and cannot retain the draw', () => {
    let state = ready(2);
    const activeId = state.turn!.playerId;
    emptyHand(state, activeId);
    topDeck(state, '9');
    state = applyGameCommand(state, { type: 'DRAW', playerId: activeId }, 2_000, random).state;
    expect(state.players.find((player) => player.id === activeId)!.cards).toHaveLength(0);
    expect(state.discard.at(-1)).toBeDefined();
    expect(state.turn).toMatchObject({ playerId: activeId, stage: 'power', power: { kind: 'opponent_peek' } });
    const opponentCard = state.players.find((player) => player.id !== activeId)!.cards[0];
    state = applyGameCommand(state, { type: 'POWER_SELECT', playerId: activeId, targetCardId: opponentCard }, 2_001, random).state;
    state = applyGameCommand(state, { type: 'POWER_COMPLETE', playerId: activeId }, 2_002, random).state;
    expect(state.players.find((player) => player.id === activeId)!.cards).toHaveLength(0);
  });

  it('forbids a zero-card stack attempt even while a race is open', () => {
    let state = ready(2);
    const zeroId = state.players.find((player) => player.id !== state.turn!.playerId)!.id;
    emptyHand(state, zeroId);
    state = drawAndDiscard(state, '4');
    const target = state.players.find((player) => player.cards.length)!.cards[0];
    expect(() => applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: zeroId, targetCardId: target, discardGeneration: state.discardGeneration }, 2_100, random)).toThrowError(/zero-card/i);
  });

  it("does not gift a card back when another player stacks an opponent's final card", () => {
    let state = ready(2);
    const activeId = state.turn!.playerId;
    const owner = state.players.find((player) => player.id === activeId)!;
    const stacker = state.players.find((player) => player.id !== activeId)!;
    const finalCard = owner.cards[0];
    state.burn.push(...owner.cards.slice(1));
    owner.cards = [finalCard];
    owner.cardSlots = { [finalCard]: 0 };
    const matching = state.deck.find((id) => state.cards[id].rank === state.cards[finalCard].rank)!;
    const index = state.deck.indexOf(matching);
    [state.deck[index], state.deck[state.deck.length - 1]] = [state.deck.at(-1)!, matching];
    state = applyGameCommand(state, { type: 'DRAW', playerId: activeId }, 2_000, random).state;
    state = applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_001, random).state;
    state = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: stacker.id, targetCardId: finalCard, discardGeneration: state.discardGeneration }, 2_002, random).state;
    expect(state.players.find((player) => player.id === owner.id)!.cards).toHaveLength(0);
    expect(state.transfer).toBeUndefined();
    expect(state.ending).toMatchObject({ triggerPlayerId: owner.id, reason: 'zero_cards' });
  });

  it('resolves every special rank consistently when the active player has no cards', () => {
    for (const [rank, suit, expectedPower] of [
      ['7', undefined, undefined],
      ['8', undefined, undefined],
      ['9', undefined, 'opponent_peek'],
      ['10', undefined, 'opponent_peek'],
      ['J', undefined, undefined],
      ['Q', undefined, undefined],
      ['K', 'clubs', 'black_king'],
      ['K', 'spades', 'black_king'],
    ] as Array<[Rank, Suit | undefined, 'opponent_peek' | 'black_king' | undefined]>) {
      let state = ready(2);
      const activeId = state.turn!.playerId;
      const opponent = state.players.find((player) => player.id !== activeId)!;
      emptyHand(state, activeId);
      topDeck(state, rank, suit);
      state = applyGameCommand(state, { type: 'DRAW', playerId: activeId }, 2_000, random).state;
      expect(state.players.find((player) => player.id === activeId)!.cards).toHaveLength(0);
      if (!expectedPower) {
        expect(state.turn?.playerId).not.toBe(activeId);
        continue;
      }
      expect(state.turn).toMatchObject({ playerId: activeId, stage: 'power', power: { kind: expectedPower } });
      const opponentCard = opponent.cards[0];
      const opponentSlot = opponent.cardSlots[opponentCard];
      state = applyGameCommand(state, { type: 'POWER_SELECT', playerId: activeId, targetCardId: opponentCard }, 2_001, random).state;
      expect(state.temporaryReveals[activeId]).toEqual([opponentCard]);
      if (expectedPower === 'black_king') state = applyGameCommand(state, { type: 'POWER_CONCEAL', playerId: activeId }, 2_002, random).state;
      state = applyGameCommand(state, { type: 'POWER_COMPLETE', playerId: activeId, swap: true }, 2_003, random).state;
      expect(state.players.find((player) => player.id === opponent.id)!.cardSlots[opponentCard]).toBe(opponentSlot);
      expect(state.players.find((player) => player.id === activeId)!.cards).toHaveLength(0);
    }
  });
});

describe('deck recycling and exhaustion', () => {
  it('keeps the visible top discard and shuffles all older discards into a fresh deck', () => {
    let state = ready(2);
    state.discard = [...state.deck];
    state.deck = [];
    const visibleTop = state.discard.at(-1)!;
    const recyclableCount = state.discard.length - 1;
    const active = state.turn!.playerId;
    state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_000, random).state;
    expect(state.discard).toEqual([visibleTop]);
    expect(state.deck).toHaveLength(recyclableCount - 1);
    expect(state.turn?.drawnCardId).toBeDefined();
  });

  it('reveals and scores immediately when neither deck nor discard can supply a draw', () => {
    let state = ready(2);
    state.burn.push(...state.deck);
    state.deck = [];
    state.discard = [];
    const active = state.turn!.playerId;
    state = applyGameCommand(state, { type: 'DRAW', playerId: active }, 2_000, random).state;
    expect(state.phase).toBe('results');
    expect(state.results).toHaveLength(2);
    expect(projectGame(state, active).players.flatMap((player) => player.cards).every((card) => card.rank)).toBe(true);
  });
});

describe('timeout fallbacks', () => {
  it('auto draw-discards an awaiting turn and an already drawn card', () => {
    let state = ready(2);
    const first = state.turn!.playerId;
    state = applyGameCommand(state, { type: 'TIMEOUT', playerId: first }, 100_000, random).state;
    expect(state.discard).toHaveLength(1);
    const second = state.turn!.playerId;
    state = applyGameCommand(state, { type: 'DRAW', playerId: second }, 100_001, random).state;
    const drawn = state.turn!.drawnCardId;
    state = applyGameCommand(state, { type: 'TIMEOUT', playerId: second }, 200_000, random).state;
    expect(state.discard.at(-1)).toBe(drawn);
    expect(state.turn?.playerId).not.toBe(second);
  });

  it('declines a selecting or revealing power on timeout without leaking or swapping cards', () => {
    let selecting = ready(2);
    const selectingId = selecting.turn!.playerId;
    selecting = drawAndDiscard(selecting, '7');
    selecting = applyGameCommand(selecting, { type: 'TIMEOUT', playerId: selectingId }, 100_000, random).state;
    expect(selecting.turn?.playerId).not.toBe(selectingId);
    expect(selecting.temporaryReveals[selectingId]).toBeUndefined();

    let revealing = ready(2);
    const revealingId = revealing.turn!.playerId;
    const target = revealing.players.find((player) => player.id === revealingId)!.cards[0];
    revealing = drawAndDiscard(revealing, '8');
    revealing = applyGameCommand(revealing, { type: 'POWER_SELECT', playerId: revealingId, targetCardId: target }, 2_100, random).state;
    expect(revealing.temporaryReveals[revealingId]).toEqual([target]);
    revealing = applyGameCommand(revealing, { type: 'TIMEOUT', playerId: revealingId }, 100_000, random).state;
    expect(revealing.temporaryReveals[revealingId]).toBeUndefined();
    expect(revealing.turn?.playerId).not.toBe(revealingId);
  });

  it('chooses a legal hidden gift when a successful opponent stack times out', () => {
    let state = ready(2);
    const activeId = state.turn!.playerId;
    const owner = state.players.find((player) => player.id === activeId)!;
    const stacker = state.players.find((player) => player.id !== activeId)!;
    const target = owner.cards[0];
    const targetSlot = owner.cardSlots[target];
    const matching = state.deck.find((id) => state.cards[id].rank === state.cards[target].rank)!;
    const index = state.deck.indexOf(matching);
    [state.deck[index], state.deck[state.deck.length - 1]] = [state.deck.at(-1)!, matching];
    state = applyGameCommand(state, { type: 'DRAW', playerId: activeId }, 2_000, random).state;
    state = applyGameCommand(state, { type: 'DISCARD_DRAWN', playerId: activeId }, 2_001, random).state;
    const beforeStacker = new Set(stacker.cards);
    state = applyGameCommand(state, { type: 'STACK_ATTEMPT', playerId: stacker.id, targetCardId: target, discardGeneration: state.discardGeneration }, 2_002, random).state;
    state = applyGameCommand(state, { type: 'TIMEOUT', playerId: stacker.id }, 100_000, random).state;
    const updatedOwner = state.players.find((player) => player.id === owner.id)!;
    const gift = updatedOwner.cards.find((id) => beforeStacker.has(id))!;
    expect(gift).toBeDefined();
    expect(updatedOwner.cardSlots[gift]).toBe(targetSlot);
    expect(state.transfer).toBeUndefined();
  });
});

describe('ending edge cases', () => {
  it('ignores no later ending trigger by rejecting a second Cambio call', () => {
    let state = ready(4);
    const first = state.players[0].id;
    const second = state.players[1].id;
    state = applyGameCommand(state, { type: 'CALL_CAMBIO', playerId: first }, 2_000, random).state;
    const queue = [...state.ending!.queue];
    expect(() => applyGameCommand(state, { type: 'CALL_CAMBIO', playerId: second }, 2_001, random)).toThrowError(/already started/i);
    expect(state.ending?.queue).toEqual(queue);
  });

  it('awards every tied low score and applies no caller penalty', () => {
    let state = ready(2);
    for (const player of state.players) for (const cardId of player.cards) state.cards[cardId].rank = 'A';
    const caller = state.players[0].id;
    state = applyGameCommand(state, { type: 'CALL_CAMBIO', playerId: caller }, 2_000, random).state;
    while (state.phase !== 'results') state = applyGameCommand(state, { type: 'TIMEOUT', playerId: state.turn!.playerId }, 100_000 + state.version, random).state;
    expect(state.results?.map((result) => result.score)).toEqual([4, 4]);
    expect(state.results?.every((result) => result.winner)).toBe(true);
  });
});

describe('forfeit continuity', () => {
  it('advances from a forfeited middle active seat to the next occupied seat', () => {
    let state = ready(4);
    state = drawAndDiscard(state, '2');
    const removed = state.turn!.playerId;
    const removedIndex = state.turnOrder.indexOf(removed);
    const expected = state.turnOrder[(removedIndex + 1) % state.turnOrder.length];

    state = applyGameCommand(state, { type: 'FORFEIT_PLAYER', playerId: removed }, 2_100, random).state;

    expect(state.players.find((player) => player.id === removed)?.forfeited).toBe(true);
    expect(state.turn?.playerId).toBe(expected);
  });

  it('burns an active forfeiter\'s undecided draw without losing a card', () => {
    let state = ready(4);
    const removed = state.turn!.playerId;
    state = applyGameCommand(state, { type: 'DRAW', playerId: removed }, 2_100, random).state;
    const drawn = state.turn!.drawnCardId!;

    state = applyGameCommand(state, { type: 'FORFEIT_PLAYER', playerId: removed }, 2_101, random).state;

    const locations = [...state.deck, ...state.discard, ...state.burn, ...state.players.flatMap((player) => player.cards), ...(state.turn?.drawnCardId ? [state.turn.drawnCardId] : [])];
    expect(state.burn).toContain(drawn);
    expect(locations).toHaveLength(52);
    expect(new Set(locations)).toHaveLength(52);
  });

  it('never starts a forfeited first seat after the remaining peeks finish', () => {
    let state = createGame('peek-forfeit', participants, 1_000, random);
    const removed = state.turnOrder[0];
    state = applyGameCommand(state, { type: 'FORFEIT_PLAYER', playerId: removed }, 1_001, random).state;
    for (const player of state.players.filter((candidate) => !candidate.forfeited)) {
      state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_002, random).state;
      state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_003, random).state;
    }

    expect(state.phase).toBe('playing');
    expect(state.turn?.playerId).toBe(state.turnOrder.find((id) => id !== removed));
  });

  it('starts immediately when the only unfinished initial peek forfeits', () => {
    let state = createGame('last-peek-forfeit', participants, 1_000, random);
    const unfinished = state.players.at(-1)!;
    for (const player of state.players.filter((candidate) => candidate.id !== unfinished.id)) {
      state = applyGameCommand(state, { type: 'INITIAL_PEEK_START', playerId: player.id }, 1_001, random).state;
      state = applyGameCommand(state, { type: 'INITIAL_PEEK_END', playerId: player.id }, 1_002, random).state;
    }
    expect(state.phase).toBe('initial_peek');

    const transition = applyGameCommand(state, { type: 'FORFEIT_PLAYER', playerId: unfinished.id }, 1_003, random);

    expect(transition.state.phase).toBe('playing');
    expect(transition.state.turn?.playerId).toBe(transition.state.turnOrder.find((id) => id !== unfinished.id));
    expect(transition.effects).toContainEqual(expect.objectContaining({ type: 'turn' }));
  });
});
