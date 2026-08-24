import { describe, expect, it } from 'vitest';
import { displayNameSchema } from './protocol.js';

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
