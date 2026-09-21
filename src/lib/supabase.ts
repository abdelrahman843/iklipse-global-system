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
