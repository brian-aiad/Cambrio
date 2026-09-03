import { describe, expect, it } from 'vitest';
import { displayNameSchema, stackOutcomeSchema } from './protocol.js';

describe('display names', () => {
  it.each([
    ['bryguy', 'Bryguy'],
    ['JOE', 'Joe'],
    ['  mary   jane  ', 'Mary Jane'],
    ["o'BRIEN", "O'Brien"],
    ['blue-wHALE', 'Blue-Whale'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(displayNameSchema.parse(input)).toBe(expected);
  });
});

describe('stack action outcomes', () => {
  it.each(['stack_success', 'stack_wrong', 'stack_race_lost', 'stack_blocked'])('accepts %s', (outcome) => {
    expect(stackOutcomeSchema.parse(outcome)).toBe(outcome);
  });

  it('rejects transport strings that blur a lost race into an effect', () => {
    expect(stackOutcomeSchema.safeParse('penalty').success).toBe(false);
    expect(stackOutcomeSchema.safeParse('stack').success).toBe(false);
  });
});
