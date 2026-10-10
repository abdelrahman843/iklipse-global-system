import { createClient, SupabaseClient, type Session } from "@supabase/supabase-js";
import { configureOutbox, outboxFetch } from "./offline/outbox";
import { configureProbe, isOnline } from "./offline/net";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(
  url && anonKey && !/YOUR_PROJECT_REF|YOUR_PUBLISHABLE/i.test(`${url} ${anonKey}`),
);

// A dummy URL/key keeps `createClient` from throwing when the app is served
// before it has been wired up. The AppRoot renders a setup page instead of
// letting queries run, so this client never actually makes a request.
const safeUrl = url || "https://unset.supabase.co";
const safeKey = anonKey || "unset";

/** localStorage key supabase-js keeps the session under (read by offlineCache.ts). */
export const AUTH_STORAGE_KEY = "iklipse.auth";

/** The session supabase-js saved in localStorage, without any network call. */
export function readStoredSession(): Session | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session | null;
    return s && typeof s.access_token === "string" && typeof s.refresh_token === "string" && s.user?.id ? s : null;
  } catch {
    return null;
  }
}

// With no connection an expired token can't be refreshed, and supabase-js
// would retry for ~25 s before every single request. Offline, writes go to the
// outbox (which sends them later with a fresh token), so hand over the saved
// token at once instead of waiting. Must run before createClient (the client
// binds this method when it's built).
const proto = SupabaseClient.prototype as unknown as { _getAccessToken: () => Promise<string | null> };
const getAccessToken = proto._getAccessToken;
proto._getAccessToken = async function (this: SupabaseClient) {
  if (!isOnline()) {
    const s = readStoredSession();
    if (s) return s.access_token;
  }
  return getAccessToken.call(this);
};

export const supabase: SupabaseClient = createClient(safeUrl, safeKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: AUTH_STORAGE_KEY,
  },
  realtime: { params: { eventsPerSecond: 10 } },
  // Every write is kept on the device until the server has it (offline/outbox.ts).
  global: { fetch: outboxFetch },
});

if (isSupabaseConfigured) {
  configureProbe(safeUrl, safeKey);
  configureOutbox({
    anonKey: safeKey,
    owner: () => readStoredSession()?.user.id ?? null,
    session: async () => {
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      return s ? { uid: s.user.id, token: s.access_token } : null;
    },
    refresh: async () => {
      await supabase.auth.refreshSession();
    },
  });
}

/**
 * The signed-in user from the local session. Use this instead of
 * `supabase.auth.getUser()`, which makes a round trip to the auth server on
 * every call. The server still checks the JWT on each request (RLS uses
 * auth.uid()), so this is only a client-side convenience, not a trust decision.
 * Reads the saved session first, so it answers at once even offline.
 */
export async function sessionUser() {
  const stored = readStoredSession();
  if (stored) return { data: { user: stored.user } };
  const { data } = await supabase.auth.getSession();
  return { data: { user: data.session?.user ?? null } };
}
