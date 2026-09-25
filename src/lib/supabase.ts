import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

export const supabase: SupabaseClient = createClient(safeUrl, safeKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: "iklipse.auth",
  },
  realtime: { params: { eventsPerSecond: 10 } },
});

/**
 * The signed-in user from the local session. Use this instead of
 * `supabase.auth.getUser()`, which makes a round trip to the auth server on
 * every call. The server still checks the JWT on each request (RLS uses
 * auth.uid()), so this is only a client-side convenience, not a trust decision.
 */
export async function sessionUser() {
  const { data } = await supabase.auth.getSession();
  return { data: { user: data.session?.user ?? null } };
}
