import { describe, expect, it } from 'vitest';
import { MemoryPersistence } from './persistence.js';

describe('room checkpoint persistence', () => {
  it('does not let a slower stale checkpoint overwrite a newer room state', async () => {
    const persistence = new MemoryPersistence();
    const expiresAt = Date.now() + 60_000;

    await persistence.saveRoom('ROOM1234', { marker: 'newer' }, 12, expiresAt);
    await persistence.saveRoom('ROOM1234', { marker: 'stale' }, 11, expiresAt);

    await expect(persistence.loadRoom<{ marker: string }>('ROOM1234')).resolves.toEqual({ marker: 'newer' });
  });

  it('allows a same-version retry to refresh an idempotent checkpoint', async () => {
    const persistence = new MemoryPersistence();
    const expiresAt = Date.now() + 60_000;

    await persistence.saveRoom('ROOM1234', { marker: 'first' }, 12, expiresAt);
    await persistence.saveRoom('ROOM1234', { marker: 'retry' }, 12, expiresAt);

    await expect(persistence.loadRoom<{ marker: string }>('ROOM1234')).resolves.toEqual({ marker: 'retry' });
  });
});
