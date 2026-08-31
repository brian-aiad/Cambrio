import { ZodError } from 'zod';
import { displayNameSchema, handleSchema } from '../shared/protocol.js';
import { AuthService, type ServerIdentity } from './auth.js';
import { createPersistence, type Persistence, type StoredProfile, type StoredStats } from './persistence.js';

const MAX_PROFILE_BODY_BYTES = 8 * 1024;

export interface ProfileAuthenticator {
  authenticate(token?: string, visitorId?: string): Promise<ServerIdentity>;
  saveProfile(identity: ServerIdentity, input: { handle: string; displayName: string }): Promise<StoredProfile>;
}

export interface ProfileApiServices {
  auth: ProfileAuthenticator;
  persistence: Persistence;
}

export function createProfileApiServices(): ProfileApiServices {
  const persistence = createPersistence();
  return { persistence, auth: new AuthService(persistence) };
}

export async function currentProfileResponse(request: Request, services: ProfileApiServices): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  try {
    const identity = await identityFromRequest(request, services.auth);
    const stats = await services.persistence.getStats(identity.userId);
    return privateJson({ ...identity, stats });
  } catch (error) {
    if (error instanceof Error && (error.message === 'AUTH_REQUIRED' || error.message === 'INVALID_SESSION')) {
      return privateJson({ error: 'Authentication required.' }, 401);
    }
    return privateJson({ error: 'Profile service unavailable.' }, 503);
  }
}

export async function updateProfileResponse(request: Request, services: ProfileApiServices): Promise<Response> {
  if (request.method !== 'PUT') return methodNotAllowed('PUT');
  if (!sameOriginRequest(request)) return privateJson({ error: 'Origin not allowed.' }, 403);
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROFILE_BODY_BYTES) return privateJson({ error: 'Request too large.' }, 413);

  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_PROFILE_BODY_BYTES) return privateJson({ error: 'Request too large.' }, 413);
    const body = JSON.parse(rawBody) as { handle?: unknown; displayName?: unknown };
    const identity = await identityFromRequest(request, services.auth);
    const profile = await services.auth.saveProfile(identity, {
      handle: handleSchema.parse(body.handle),
      displayName: displayNameSchema.parse(body.displayName),
    });
    return privateJson(profile);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) return privateJson({ error: 'Enter a valid handle and display name.' }, 400);
    if (error instanceof Error && error.message === 'PERMANENT_ACCOUNT_REQUIRED') return privateJson({ error: 'Link a permanent account before creating a public profile.' }, 403);
    if (error instanceof Error && error.message === 'HANDLE_TAKEN') return privateJson({ error: 'That handle is already taken.' }, 409);
    if (error instanceof Error && (error.message === 'AUTH_REQUIRED' || error.message === 'INVALID_SESSION')) return privateJson({ error: 'Authentication required.' }, 401);
    return privateJson({ error: 'Unable to save profile.' }, 500);
  }
}

export async function publicProfileResponse(request: Request, rawHandle: string, persistence: Persistence): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const parsed = handleSchema.safeParse(rawHandle);
  if (!parsed.success) return publicJson({ error: 'Invalid handle.' }, 400);
  try {
    const profile = await persistence.getProfileByHandle(parsed.data);
    if (!profile || profile.anonymous) return publicJson({ error: 'Profile not found.' }, 404);
    return publicJson(toPublicProfile(profile));
  } catch {
    return publicJson({ error: 'Profile service unavailable.' }, 503);
  }
}

export function toPublicProfile(profile: StoredProfile & StoredStats) {
  return {
    handle: profile.handle,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    games: profile.games,
    wins: profile.wins,
    winRate: profile.winRate,
  };
}

async function identityFromRequest(request: Request, auth: ProfileAuthenticator): Promise<ServerIdentity> {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  const visitorId = request.headers.get('x-visitor-id') ?? undefined;
  return auth.authenticate(token, visitorId);
}

function sameOriginRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}

function methodNotAllowed(method: string): Response {
  return privateJson({ error: 'Method not allowed.' }, 405, { Allow: method });
}

function privateJson(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Authorization, x-visitor-id', ...headers } });
}

function publicJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': status === 200 ? 'public, max-age=60, stale-while-revalidate=300' : 'no-store' } });
}
