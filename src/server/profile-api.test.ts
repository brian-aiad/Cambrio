import { describe, expect, it } from 'vitest';
import type { ServerIdentity } from './auth.js';
import { currentProfileResponse, publicProfileResponse, updateProfileResponse, type ProfileApiServices } from './profile-api.js';
import { MemoryPersistence } from './persistence.js';

function services(): ProfileApiServices {
  const persistence = new MemoryPersistence();
  return {
    persistence,
    auth: {
      async authenticate(token, visitorId) {
        if (token === 'alpha') return { userId: 'user-alpha', anonymous: false, displayName: 'Alpha Player' };
        if (token === 'beta') return { userId: 'user-beta', anonymous: false, displayName: 'Beta Player' };
        if (visitorId) return { userId: `guest-${visitorId}`, anonymous: true };
        throw new Error('AUTH_REQUIRED');
      },
      async saveProfile(identity: ServerIdentity, input) {
        if (identity.anonymous) throw new Error('PERMANENT_ACCOUNT_REQUIRED');
        return persistence.saveProfile({ ...identity, ...input, anonymous: false });
      },
    },
  };
}

function request(path: string, init?: RequestInit) {
  return new Request(`https://cambrio.test${path}`, init);
}

describe('profile API parity handlers', () => {
  it('returns the authenticated profile and stats without caching it', async () => {
    const api = services();
    const response = await currentProfileResponse(request('/api/me', { headers: { Authorization: 'Bearer alpha' } }), api);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ userId: 'user-alpha', anonymous: false, stats: { games: 0, wins: 0, winRate: 0 } });
  });

  it('validates profile writes and reserves a handle for one permanent account', async () => {
    const api = services();
    const save = (token: string, body: unknown, origin = 'https://cambrio.test') => updateProfileResponse(request('/api/me/profile', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    }), api);

    expect((await save('alpha', { handle: 'table_reader', displayName: 'Alpha Player' })).status).toBe(200);
    expect((await save('beta', { handle: 'table_reader', displayName: 'Beta Player' })).status).toBe(409);
    expect((await save('alpha', { handle: 'No Spaces', displayName: 'Alpha Player' })).status).toBe(400);
    expect((await save('alpha', { handle: 'new_handle', displayName: 'Alpha Player' }, 'https://attacker.invalid')).status).toBe(403);
  });

  it('keeps guest play independent from permanent profile creation', async () => {
    const api = services();
    const response = await updateProfileResponse(request('/api/me/profile', {
      method: 'PUT',
      headers: { 'x-visitor-id': 'visitor-123456', 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'guest_handle', displayName: 'Guest Player' }),
    }), api);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Link a permanent account before creating a public profile.' });
  });

  it('publishes only the intended public fields', async () => {
    const api = services();
    await api.persistence.saveProfile({ userId: 'user-alpha', anonymous: false, handle: 'table_reader', displayName: 'Alpha Player', avatarUrl: 'https://images.example/avatar.png' });
    const response = await publicProfileResponse(request('/api/profiles/table_reader'), 'table_reader', api.persistence);
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toEqual({ handle: 'table_reader', displayName: 'Alpha Player', avatarUrl: 'https://images.example/avatar.png', games: 0, wins: 0, winRate: 0 });
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('anonymous');
  });

  it('returns bounded, user-safe method and parse failures', async () => {
    const api = services();
    expect((await currentProfileResponse(request('/api/me', { method: 'POST' }), api)).status).toBe(405);
    expect((await publicProfileResponse(request('/api/profiles/invalid-handle'), 'invalid-handle', api.persistence)).status).toBe(400);
    const malformed = await updateProfileResponse(request('/api/me/profile', {
      method: 'PUT', headers: { Authorization: 'Bearer alpha', 'Content-Type': 'application/json' }, body: '{',
    }), api);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Enter a valid handle and display name.' });
  });

  it('distinguishes profile-storage outages from invalid authentication', async () => {
    const unavailable = services();
    unavailable.persistence.getStats = async () => { throw new Error('storage offline'); };
    expect((await currentProfileResponse(request('/api/me', { headers: { Authorization: 'Bearer alpha' } }), unavailable)).status).toBe(503);

    const unauthorized = services();
    expect((await currentProfileResponse(request('/api/me'), unauthorized)).status).toBe(401);
  });
});
