import type { Session, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: { sitekey: string; size: 'invisible'; callback: (token: string) => void; 'error-callback': () => void }) => string;
      remove: (widgetId: string) => void;
    };
  }
}

let supabase: SupabaseClient | undefined;
let supabasePromise: Promise<SupabaseClient> | undefined;
let ephemeralVisitorId: string | undefined;

export async function getSupabase(): Promise<SupabaseClient | undefined> {
  if (!supabaseUrl || !supabaseKey) return undefined;
  if (supabase) return supabase;
  try {
    supabasePromise ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(supabaseUrl, supabaseKey));
    supabase = await supabasePromise;
    return supabase;
  } catch {
    supabasePromise = undefined;
    return undefined;
  }
}

export interface ClientSession {
  token?: string;
  visitorId: string;
  session?: Session;
  anonymous: boolean;
}

export async function ensureClientSession(): Promise<ClientSession> {
  const visitorId = getVisitorId();
  try {
    const supabase = await getSupabase();
    if (!supabase) return { visitorId, anonymous: true };
    const current = await supabase.auth.getSession();
    if (current.error) return { visitorId, anonymous: true };
    let { data } = current;
    if (!data.session) {
      const captchaToken = turnstileSiteKey ? await requestTurnstileToken(turnstileSiteKey) : undefined;
      const result = await supabase.auth.signInAnonymously({ options: { captchaToken } });
      if (result.error) return { visitorId, anonymous: true };
      data = { session: result.data.session };
    }
    return {
      visitorId,
      token: data.session?.access_token,
      session: data.session ?? undefined,
      anonymous: Boolean(data.session?.user.is_anonymous),
    };
  } catch {
    // Accounts enhance persistence; they are not a prerequisite for a room.
    return { visitorId, anonymous: true };
  }
}

async function requestTurnstileToken(siteKey: string): Promise<string> {
  if (!window.turnstile) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-cambrio-turnstile]');
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('CAPTCHA could not load.')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.cambrioTurnstile = 'true';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('CAPTCHA could not load.'));
      document.head.appendChild(script);
    });
  }
  if (!window.turnstile) throw new Error('CAPTCHA is unavailable.');
  return new Promise<string>((resolve, reject) => {
    const mount = document.createElement('div');
    mount.style.position = 'fixed';
    mount.style.inset = '0';
    mount.style.pointerEvents = 'none';
    document.body.appendChild(mount);
    let widgetId = '';
    const cleanup = () => {
      if (widgetId) window.turnstile?.remove(widgetId);
      mount.remove();
    };
    widgetId = window.turnstile!.render(mount, {
      sitekey: siteKey,
      size: 'invisible',
      callback: (token) => { cleanup(); resolve(token); },
      'error-callback': () => { cleanup(); reject(new Error('CAPTCHA verification failed.')); },
    });
  });
}

export function getVisitorId(): string {
  try {
    const existing = localStorage.getItem('cambrio:visitor');
    if (existing && /^[a-zA-Z0-9_-]{10,64}$/.test(existing)) {
      ephemeralVisitorId = existing;
      return existing;
    }
  } catch {
    // Some privacy modes expose Storage but reject every operation. A stable
    // in-memory ID still preserves this tab's reconnect identity.
  }
  if (ephemeralVisitorId) return ephemeralVisitorId;
  ephemeralVisitorId = crypto.randomUUID().replaceAll('-', '');
  try {
    localStorage.setItem('cambrio:visitor', ephemeralVisitorId);
  } catch {
    // Guest play remains available when persistence is blocked.
  }
  return ephemeralVisitorId;
}
