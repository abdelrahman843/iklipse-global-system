import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { AUTH_STORAGE_KEY, supabase } from "./supabase";
import type { PermissionKey, Profile, Workspace } from "./database.types";
import { workspaceCan } from "./permissions";
import {
  bindCacheToUser,
  clearPersistedCache,
  getAuthSnapshot,
  getSessionOfflineSafe,
  isNetworkError,
  rememberAuthSnapshot,
} from "./offlineCache";

interface AuthContextValue {
  loading: boolean;
  /**
   * True once session and (when signed in) profile+workspace are all loaded.
   * Consumers should gate redirects/guards on `ready` rather than on `loading`
   * alone — otherwise a fresh sign-in can flash the login page or the
   * "deactivated" state before the profile hydrates.
   */
  ready: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  workspace: Workspace | null;
  isAdmin: boolean;
  isGuest: boolean;
  /**
   * Workspace-level capability (create board, search…). Anything that happens
   * on a board is decided by the board role — use useBoardCan() there.
   */
  can: (perm: PermissionKey) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
  /** Re-read workspace settings without re-hydrating the whole session. */
  refreshWorkspace: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

async function loadProfileAndWorkspace(userId: string) {
  const [profileRes, wsRes] = await Promise.all([
    supabase.from("profile").select("*").eq("id", userId).maybeSingle(),
    supabase.from("workspace").select("*").eq("id", WORKSPACE_ID).maybeSingle(),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (wsRes.error) throw wsRes.error;
  return {
    profile: (profileRes.data ?? null) as Profile | null,
    workspace: (wsRes.data ?? null) as Workspace | null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [hydrating, setHydrating] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const qc = useQueryClient();
  // Tracks the currently-hydrated user so focus/token-refresh events (which
  // re-fire onAuthStateChange with the SAME user) don't re-hydrate and flash
  // the whole app.
  const currentUserId = useRef<string | null>(null);
  // Profile/workspace came from the offline copy (or failed for lack of
  // network): re-read them once the connection is back.
  const profileStale = useRef(false);

  // An admin used "Sign everyone out" (or signed this person out): the
  // database already refuses this login; end it on this device too.
  const lastRevokeCheck = useRef(0);
  const endIfRevoked = async () => {
    lastRevokeCheck.current = Date.now();
    const { data, error } = await supabase.rpc("session_is_current");
    if (error || data !== false) return; // offline or unknown: keep going
    await supabase.auth.signOut({ scope: "local" });
    qc.clear();
    await clearPersistedCache();
  };

  const hydrate = async (s: Session | null) => {
    setHydrating(true);
    setSession(s);
    currentUserId.current = s?.user?.id ?? null;
    // The offline cache belongs to one account: sign-out or an account switch wipes it.
    bindCacheToUser(currentUserId.current);
    profileStale.current = false;
    if (!s?.user) {
      setProfile(null);
      setWorkspace(null);
      setHydrating(false);
      return;
    }
    // Offline: open read-only with the profile saved alongside the offline cache.
    if (!navigator.onLine) {
      const snap = getAuthSnapshot(s.user.id);
      profileStale.current = true;
      setProfile(snap?.profile ?? null);
      setWorkspace(snap?.workspace ?? null);
      setHydrating(false);
      return;
    }
    try {
      const { profile: p, workspace: w } = await loadProfileAndWorkspace(s.user.id);
      setProfile(p);
      setWorkspace(w);
      rememberAuthSnapshot(s.user.id, p, w);
      if (p?.sessions_revoked_at) void endIfRevoked();
    } catch (e) {
      const snap = isNetworkError(e) ? getAuthSnapshot(s.user.id) : null;
      profileStale.current = isNetworkError(e);
      // Fail closed — no profile means no access (unless it's just the network).
      if (!snap) console.error("Failed to load profile/workspace", e);
      setProfile(snap?.profile ?? null);
      setWorkspace(snap?.workspace ?? null);
    } finally {
      setHydrating(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      // A token refresh that fails for lack of network is not a sign-out.
      const s = await getSessionOfflineSafe();
      if (!mounted) return;
      await hydrate(s);
      setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (evt, s) => {
      // Initial session is already handled by getSession() above.
      if (evt === "INITIAL_SESSION") return;
      if (evt === "SIGNED_OUT") void clearPersistedCache();
      const newId = s?.user?.id ?? null;
      // A refresh that was already retrying when the user signed out offline
      // can land afterwards and store the session again: finish the sign-out.
      if (evt === "TOKEN_REFRESHED" && newId && currentUserId.current === null) {
        void supabase.auth.signOut({ scope: "local" });
        return;
      }
      // Same user (tab refocus, periodic token refresh, cross-tab sync): just
      // keep the fresh session object. Do NOT re-hydrate — re-hydrating flips
      // `ready` false and refetches profile/workspace on every focus, which
      // is the self-reload the user was seeing.
      if (evt === "TOKEN_REFRESHED" || evt === "USER_UPDATED" || newId === currentUserId.current) {
        currentUserId.current = newId;
        setSession(s);
        return;
      }
      // Real sign-in / sign-out / user switch.
      await hydrate(s);
    });
    // Back online (reported once the token is usable): swap the offline
    // profile/workspace for fresh rows, without re-hydrating the whole app.
    const unsubOnline = onlineManager.subscribe((online) => {
      const id = currentUserId.current;
      if (!online || !id || !profileStale.current) return;
      loadProfileAndWorkspace(id)
        .then(({ profile: p, workspace: w }) => {
          if (currentUserId.current !== id || !p) return;
          profileStale.current = false;
          setProfile(p);
          setWorkspace(w);
          rememberAuthSnapshot(id, p, w);
        })
        .catch(() => undefined);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
      unsubOnline();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live: an admin changing my role, deactivating me, or editing workspace
  // settings takes effect without a reload. Rows arrive whole (RLS-checked).
  const liveUserId = session?.user?.id;
  useEffect(() => {
    if (!liveUserId) return;
    const ch = supabase
      .channel(`account:${liveUserId}:${Math.random().toString(36).slice(2, 10)}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "profile", filter: `id=eq.${liveUserId}` }, (p) => {
        setProfile(p.new as Profile);
        // Deactivated: end the session now, not when the token expires.
        if ((p.new as Profile).is_active === false) void supabase.auth.signOut();
        // Signed out by an admin: this device's login no longer counts.
        else if ((p.new as Profile).sessions_revoked_at) void endIfRevoked();
        // Role changes move what every board allows.
        qc.invalidateQueries({ queryKey: ["board-access"] });
        qc.invalidateQueries({ queryKey: ["boards"] });
      })
      // Account deleted by an admin: sign out (deletes carry only the id).
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "profile" }, (p) => {
        if ((p.old as { id?: string })?.id === liveUserId) void supabase.auth.signOut();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspace", filter: `id=eq.${WORKSPACE_ID}` }, (p) => {
        setWorkspace(p.new as Workspace);
        qc.invalidateQueries({ queryKey: ["ai-status"] });
        qc.invalidateQueries({ queryKey: ["board-access"] });
      })
      .subscribe();
    // Coming back to the tab (realtime may have been asleep): re-check at most once a minute.
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRevokeCheck.current > 60_000) void endIfRevoked();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(ch);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUserId, qc]);

  const isAdmin = profile?.role === "admin";
  const isGuest = profile?.role === "guest";
  // Ready = not doing initial load, not currently hydrating a session change,
  // and if a session exists then the profile has been resolved.
  const ready = !loading && !hydrating && (!session || profile !== null);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      ready,
      session,
      user: session?.user ?? null,
      profile,
      workspace,
      isAdmin,
      isGuest,
      can: (perm) => workspaceCan(profile?.is_active ? profile.role : null, workspace, perm),
      signIn: async (username, password) => {
        // Username + password only. The auth service needs an email-shaped id,
        // so every account's is `<username>@iklipse.local`; nobody ever sees it.
        const name = username.trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(name)) throw new Error("Enter your username (as shown in the system), not an email.");
        const { error } = await supabase.auth.signInWithPassword({ email: `${name}@iklipse.local`, password });
        if (error) {
          if (/invalid login credentials/i.test(error.message)) throw new Error("Wrong username or password.");
          throw error;
        }
      },
      signOut: async () => {
        const res = navigator.onLine ? await supabase.auth.signOut() : null;
        // Offline the server call can't go through and supabase-js keeps the
        // session: still end it on this device.
        if (!res || (res.error && isNetworkError(res.error))) {
          try {
            localStorage.removeItem(AUTH_STORAGE_KEY);
          } catch {
            /* storage blocked */
          }
          await hydrate(null);
        }
        // Purge user-scoped caches so the next signed-in user never sees stale data.
        qc.clear();
        await clearPersistedCache();
      },
      reload: async () => {
        const { data } = await supabase.auth.getSession();
        await hydrate(data.session);
      },
      refreshWorkspace: async () => {
        const { data } = await supabase.from("workspace").select("*").eq("id", WORKSPACE_ID).maybeSingle();
        if (data) setWorkspace(data as Workspace);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, ready, session, profile, workspace, isAdmin, isGuest],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
