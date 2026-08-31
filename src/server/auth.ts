import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';
import type { Persistence, StoredProfile } from './persistence.js';

export interface ServerIdentity {
  userId: string;
  anonymous: boolean;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

export class AuthService {
  private supabase?: SupabaseClient;
  readonly productionAuth: boolean;

  constructor(private persistence: Persistence) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.productionAuth = Boolean(url && key);
    if (url && key) this.supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async authenticate(token?: string, visitorId?: string): Promise<ServerIdentity> {
    if (this.supabase && token) {
      const { data, error } = await this.supabase.auth.getUser(token);
      if (error || !data.user) throw new Error('INVALID_SESSION');
      return this.identityFromUser(data.user);
    }
    const safeVisitor = visitorId?.match(/^[a-zA-Z0-9_-]{10,64}$/)?.[0] ?? nanoid();
    // A configured account provider may be unavailable while guest gameplay
    // remains healthy. The hosted visitor namespace keeps that fallback
    // consistent with the HTTP transport; supplied invalid tokens never fall
    // through this branch.
    const userId = `${this.supabase ? 'web' : 'dev'}_${safeVisitor}`;
    const profile = await this.persistence.getProfileByUser(userId);
    return profile ?? { userId, anonymous: true };
  }

  async saveProfile(identity: ServerIdentity, input: { handle: string; displayName: string }): Promise<StoredProfile> {
    if (identity.anonymous) throw new Error('PERMANENT_ACCOUNT_REQUIRED');
    return this.persistence.saveProfile({ ...identity, ...input, anonymous: false });
  }

  private async identityFromUser(user: User): Promise<ServerIdentity> {
    const profile = await this.persistence.getProfileByUser(user.id);
    const anonymous = Boolean(user.is_anonymous);
    const identity = {
      userId: user.id,
      anonymous,
      handle: profile?.handle,
      displayName: profile?.displayName ?? user.user_metadata.full_name ?? user.user_metadata.name,
      avatarUrl: profile?.avatarUrl ?? user.user_metadata.avatar_url,
    };
    if (!profile) await this.persistence.saveProfile(identity);
    else if (profile.anonymous !== anonymous) await this.persistence.saveProfile({ ...profile, anonymous });
    return identity;
  }
}
