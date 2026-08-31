import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';

export interface StoredProfile {
  userId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  anonymous: boolean;
}

export interface StoredStats {
  games: number;
  wins: number;
  winRate: number;
}

export interface MatchParticipantRecord {
  userId: string;
  displayName: string;
  seat: number;
  score: number | null;
  winner: boolean;
  forfeited: boolean;
}

export interface Persistence {
  saveRoom(code: string, snapshot: unknown, version: number, expiresAt: number): Promise<void>;
  loadRoom<T>(code: string): Promise<T | undefined>;
  deleteRoom(code: string): Promise<void>;
  getProfileByUser(userId: string): Promise<StoredProfile | undefined>;
  getProfileByHandle(handle: string): Promise<(StoredProfile & StoredStats) | undefined>;
  saveProfile(profile: StoredProfile): Promise<StoredProfile>;
  getStats(userId: string): Promise<StoredStats>;
  recordMatch(matchId: string, code: string, participants: MatchParticipantRecord[]): Promise<boolean>;
}

const emptyStats = (): StoredStats => ({ games: 0, wins: 0, winRate: 0 });

export class MemoryPersistence implements Persistence {
  private rooms = new Map<string, { snapshot: unknown; expiresAt: number; version: number }>();
  private profiles = new Map<string, StoredProfile>();
  private stats = new Map<string, StoredStats>();
  private matches = new Set<string>();

  async saveRoom(code: string, snapshot: unknown, version: number, expiresAt: number) {
    const current = this.rooms.get(code);
    if (!current || current.version <= version) this.rooms.set(code, { snapshot: structuredClone(snapshot), expiresAt, version });
  }
  async loadRoom<T>(code: string) {
    const room = this.rooms.get(code);
    if (!room || room.expiresAt <= Date.now()) return undefined;
    return structuredClone(room.snapshot) as T;
  }
  async deleteRoom(code: string) {
    this.rooms.delete(code);
  }
  async getProfileByUser(userId: string) {
    return this.profiles.get(userId);
  }
  async getProfileByHandle(handle: string) {
    const profile = [...this.profiles.values()].find((candidate) => candidate.handle?.toLowerCase() === handle.toLowerCase());
    return profile ? { ...profile, ...(this.stats.get(profile.userId) ?? emptyStats()) } : undefined;
  }
  async saveProfile(profile: StoredProfile) {
    if (profile.handle) {
      const collision = [...this.profiles.values()].find(
        (candidate) => candidate.userId !== profile.userId && candidate.handle?.toLowerCase() === profile.handle?.toLowerCase(),
      );
      if (collision) throw new Error('HANDLE_TAKEN');
    }
    this.profiles.set(profile.userId, profile);
    return profile;
  }
  async getStats(userId: string) {
    return this.stats.get(userId) ?? emptyStats();
  }
  async recordMatch(matchId: string, _code: string, participants: MatchParticipantRecord[]) {
    if (this.matches.has(matchId)) return false;
    this.matches.add(matchId);
    for (const participant of participants) {
      const current = this.stats.get(participant.userId) ?? emptyStats();
      const games = current.games + 1;
      const wins = current.wins + (participant.winner ? 1 : 0);
      this.stats.set(participant.userId, { games, wins, winRate: Math.round((wins / games) * 1000) / 10 });
    }
    return true;
  }
}

export class SupabasePersistence implements Persistence {
  private client: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async saveRoom(code: string, snapshot: unknown, version: number, expiresAt: number) {
    const { error } = await this.client.rpc('save_cambrio_room', {
      code_input: code,
      snapshot_input: snapshot,
      state_version_input: version,
      expires_at_input: new Date(expiresAt).toISOString(),
    });
    if (error) throw error;
  }
  async loadRoom<T>(code: string) {
    const { data, error } = await this.client
      .from('active_rooms')
      .select('snapshot,expires_at')
      .eq('code', code)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    return data?.snapshot as T | undefined;
  }
  async deleteRoom(code: string) {
    const { error } = await this.client.from('active_rooms').delete().eq('code', code);
    if (error) throw error;
  }
  async getProfileByUser(userId: string) {
    const { data, error } = await this.client.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw error;
    return data
      ? { userId: data.id, handle: data.handle ?? undefined, displayName: data.display_name ?? undefined, avatarUrl: data.avatar_url ?? undefined, anonymous: data.is_anonymous }
      : undefined;
  }
  async getProfileByHandle(handle: string) {
    const { data, error } = await this.client
      .from('profiles')
      .select('id,handle,display_name,avatar_url,is_anonymous,player_stats(games,wins)')
      .eq('handle', handle)
      .eq('is_anonymous', false)
      .maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    const relation = Array.isArray(data.player_stats) ? data.player_stats[0] : data.player_stats;
    const games = relation?.games ?? 0;
    const wins = relation?.wins ?? 0;
    return {
      userId: data.id,
      handle: data.handle,
      displayName: data.display_name,
      avatarUrl: data.avatar_url ?? undefined,
      anonymous: data.is_anonymous,
      games,
      wins,
      winRate: games ? Math.round((wins / games) * 1000) / 10 : 0,
    };
  }
  async saveProfile(profile: StoredProfile) {
    const { error } = await this.client.from('profiles').upsert({
      id: profile.userId,
      handle: profile.handle ?? null,
      display_name: profile.displayName ?? null,
      avatar_url: profile.avatarUrl ?? null,
      is_anonymous: profile.anonymous,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      if (error.code === '23505') throw new Error('HANDLE_TAKEN');
      throw error;
    }
    return profile;
  }
  async getStats(userId: string) {
    const { data, error } = await this.client.from('player_stats').select('games,wins').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    const games = data?.games ?? 0;
    const wins = data?.wins ?? 0;
    return { games, wins, winRate: games ? Math.round((wins / games) * 1000) / 10 : 0 };
  }
  async recordMatch(matchId: string, code: string, participants: MatchParticipantRecord[]) {
    const { data, error } = await this.client.rpc('record_cambrio_match', {
      match_id_input: matchId,
      room_code_input: code,
      participants_input: participants,
    });
    if (error) throw error;
    return Boolean(data);
  }
}

/**
 * Serverless room storage for the Vercel deployment. Every request can land on
 * a different function instance, so live room state must never depend on a
 * process-local map. Profile/stat keys are deliberately separate from room
 * snapshots so a two-hour room expiry cannot remove account history.
 */
export class RedisPersistence implements Persistence {
  private client: Redis;

  constructor(url: string, token: string) {
    this.client = new Redis({ url, token });
  }

  async saveRoom(code: string, snapshot: unknown, version: number, expiresAt: number) {
    const seconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1_000));
    await this.client.set(this.roomKey(code), { snapshot, version, expiresAt }, { ex: seconds });
  }

  async loadRoom<T>(code: string) {
    const stored = await this.client.get<{ snapshot: T; expiresAt: number }>(this.roomKey(code));
    if (!stored || stored.expiresAt <= Date.now()) return undefined;
    return stored.snapshot;
  }

  async deleteRoom(code: string) {
    await this.client.del(this.roomKey(code));
  }

  async getProfileByUser(userId: string) {
    return (await this.client.get<StoredProfile>(`cambrio:profile:${userId}`)) ?? undefined;
  }

  async getProfileByHandle(handle: string) {
    const userId = await this.client.get<string>(`cambrio:handle:${handle.toLowerCase()}`);
    if (!userId) return undefined;
    const profile = await this.getProfileByUser(userId);
    if (!profile || profile.handle?.toLowerCase() !== handle.toLowerCase()) return undefined;
    return { ...profile, ...(await this.getStats(userId)) };
  }

  async saveProfile(profile: StoredProfile) {
    const lockKey = `cambrio:profile-lock:${profile.userId}`;
    const lockOwner = nanoid();
    let acquired = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      acquired = Boolean(await this.client.set(lockKey, lockOwner, { nx: true, px: 10_000 }));
      if (acquired) break;
      await new Promise((resolve) => setTimeout(resolve, 15 + attempt * 5));
    }
    if (!acquired) throw new Error('PROFILE_BUSY');

    try {
      return await this.saveProfileLocked(profile);
    } finally {
      await this.client.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [lockKey],
        [lockOwner],
      ).catch(() => undefined);
    }
  }

  private async saveProfileLocked(profile: StoredProfile) {
    const previous = await this.getProfileByUser(profile.userId);
    let claimedHandleKey: string | undefined;
    if (profile.handle) {
      const handleKey = `cambrio:handle:${profile.handle.toLowerCase()}`;
      const owner = await this.client.get<string>(handleKey);
      if (owner && owner !== profile.userId) throw new Error('HANDLE_TAKEN');
      if (!owner) {
        const claimed = await this.client.set(handleKey, profile.userId, { nx: true });
        if (!claimed) throw new Error('HANDLE_TAKEN');
        claimedHandleKey = handleKey;
      }
    }
    try {
      await this.client.set(`cambrio:profile:${profile.userId}`, profile);
    } catch (error) {
      if (claimedHandleKey) {
        await this.client.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          [claimedHandleKey],
          [profile.userId],
        ).catch(() => undefined);
      }
      throw error;
    }
    if (previous?.handle && previous.handle.toLowerCase() !== profile.handle?.toLowerCase()) {
      await this.client.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        [`cambrio:handle:${previous.handle.toLowerCase()}`],
        [profile.userId],
      );
    }
    return profile;
  }

  async getStats(userId: string) {
    const stored = await this.client.hgetall<{ games?: number | string; wins?: number | string }>(`cambrio:stats:${userId}`);
    const games = Number(stored?.games ?? 0);
    const wins = Number(stored?.wins ?? 0);
    return { games, wins, winRate: games ? Math.round((wins / games) * 1_000) / 10 : 0 };
  }

  async recordMatch(matchId: string, _code: string, participants: MatchParticipantRecord[]) {
    const inserted = await this.client.set(`cambrio:match:${matchId}`, 1, { nx: true });
    if (!inserted) return false;
    const pipeline = this.client.pipeline();
    for (const participant of participants) {
      const key = `cambrio:stats:${participant.userId}`;
      pipeline.hincrby(key, 'games', 1);
      if (participant.winner) pipeline.hincrby(key, 'wins', 1);
    }
    await pipeline.exec();
    return true;
  }

  private roomKey(code: string) {
    return `cambrio:room:${code.toUpperCase()}`;
  }
}

export function createPersistence(): Persistence {
  const redisUrl = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (redisUrl && redisToken) return new RedisPersistence(redisUrl, redisToken);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? new SupabasePersistence(url, key) : new MemoryPersistence();
}
