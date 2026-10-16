import { appSignedOut } from "@/lib/nativeApp";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { AUTH_STORAGE_KEY, supabase } from "./supabase";
import { forgetSaved, rememberSession, savedAccounts } from "./accounts";
import type { PermissionKey, Profile, Role, Workspace } from "./database.types";
import { briefRole, canDeliver, productRole, workspaceCan, type BriefAccess, type Product } from "./permissions";

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
  /** Role in Trello / Miro (null = no access to it). */
  trelloRole: Role | null;
  miroRole: Role | null;
  /** Briefs: "create" (make links + read answers), "view" (read answers), null = no access. */
  briefRole: BriefAccess | null;
  /** Deliveries: prepare them and send links (admins + people allowed to). */
  canDeliver: boolean;
  /**
   * Workspace-level capability (create board, search…). Anything that happens
   * on a board is decided by the board role — use useBoardCan() there.
   */
  /** A capability in Trello (default) or Miro, by the role in that product. */
  can: (perm: PermissionKey, kind?: Product) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  /** Log out of this account. True when another saved account took its place. */
  signOut: () => Promise<boolean>;
  /** Switch to another account saved on this device (no password). */
  switchAccount: (id: string) => Promise<void>;
  /** Forget a saved account on this device (and end its login). */
  forgetAccount: (id: string) => Promise<void>;
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

  // An admin used "Sign everyone out" (or signed this person out): the
  // database already refuses this login; end it on this device too.
  const lastRevokeCheck = useRef(0);
  const endIfRevoked = async () => {
    lastRevokeCheck.current = Date.now();
    const { data, error } = await supabase.rpc("session_is_current");
    if (error || data !== false) return; // unreachable or unknown: keep going
    const { data: cur } = await supabase.auth.getSession();
    if (cur.session) forgetSaved(cur.session.user.id);
    await supabase.auth.signOut({ scope: "local" });
    qc.clear();
  };

  const hydrate = async (s: Session | null) => {
    setHydrating(true);
    setSession(s);
    const id = s?.user?.id ?? null;
    // Signed out, or another account signed in (here or in another tab): what
    // the previous one loaded must not show.
    if (currentUserId.current && currentUserId.current !== id) qc.clear();
    currentUserId.current = id;
    if (!s?.user) {
      setProfile(null);
      setWorkspace(null);
      setHydrating(false);
      return;
    }
    try {
      const { profile: p, workspace: w } = await loadProfileAndWorkspace(s.user.id);
      // Saved on this device, to switch back to it later.
      if (p?.is_active) rememberSession(s, { name: p.display_name, username: p.username, avatar_url: p.avatar_url });
      setProfile(p);
      setWorkspace(w);
      if (p?.sessions_revoked_at) void endIfRevoked();
    } catch (e) {
      // Fail closed — no profile means no access.
      console.error("Failed to load profile/workspace", e);
      setProfile(null);
      setWorkspace(null);
    } finally {
      setHydrating(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      await hydrate(data.session);
      setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (evt, s) => {
      // Initial session is already handled by getSession() above.
      if (evt === "INITIAL_SESSION") return;
      const newId = s?.user?.id ?? null;
      // A refreshed login replaces the saved one (the old one stops working).
      if (s && savedAccounts().some((a) => a.id === s.user.id)) rememberSession(s);
      // Same user (tab refocus, periodic token refresh, cross-tab sync): just
      // keep the fresh session object. Do NOT re-hydrate — re-hydrating flips
      // `ready` false and refetches profile/workspace on every focus, which
      // is the self-reload the user was seeing. Decided by the user, not the
      // event: switching to a saved account whose login had expired arrives
      // as TOKEN_REFRESHED, for another user.
      if (newId === currentUserId.current) {
        setSession(s);
        return;
      }
      // Real sign-in / sign-out / user switch.
      await hydrate(s);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
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
        if ((p.new as Profile).is_active === false) {
          forgetSaved(liveUserId);
          void supabase.auth.signOut();
        }
        // Signed out by an admin: this device's login no longer counts.
        else if ((p.new as Profile).sessions_revoked_at) void endIfRevoked();
        // Role changes move what every board allows.
        qc.invalidateQueries({ queryKey: ["board-access"] });
        qc.invalidateQueries({ queryKey: ["boards"] });
      })
      // Account deleted by an admin: sign out (deletes carry only the id).
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "profile" }, (p) => {
        if ((p.old as { id?: string })?.id === liveUserId) {
          forgetSaved(liveUserId);
          void supabase.auth.signOut();
        }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspace", filter: `id=eq.${WORKSPACE_ID}` }, (p) => {
        setWorkspace(p.new as Workspace);
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

  /** Sign in as a saved account with its saved login; a login that ended is forgotten. */
  const switchTo = async (id: string) => {
    const a = savedAccounts().find((x) => x.id === id);
    if (!a) throw new Error("That account isn't saved on this device.");
    const { data, error } = await supabase.auth.setSession({ access_token: a.access_token, refresh_token: a.refresh_token });
    if (error || !data.session) {
      forgetSaved(id);
      throw new Error(`${a.name}'s login ended. Sign in to it again.`);
    }
    // Loaded as that person now, whatever event the switch came as.
    if (currentUserId.current !== data.session.user.id) await hydrate(data.session);
  };

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
      trelloRole: profile?.is_active ? productRole(profile, "kanban") : null,
      miroRole: profile?.is_active ? productRole(profile, "whiteboard") : null,
      briefRole: briefRole(profile),
      canDeliver: canDeliver(profile),
      // Board capabilities follow the role in that product (Trello by default).
      can: (perm, kind = "kanban") => workspaceCan(profile?.is_active ? productRole(profile, kind) : null, workspace, perm),
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
        // In the iklipse app: its phone stops getting this person's calls first.
        await appSignedOut().catch(() => undefined);
        const me = session?.user?.id;
        if (me) forgetSaved(me);
        const { error } = await supabase.auth.signOut();
        // The server call failed and supabase-js kept the session: still end
        // it on this device.
        if (error) {
          try {
            localStorage.removeItem(AUTH_STORAGE_KEY);
          } catch {
            /* storage blocked */
          }
          await hydrate(null);
        }
        // Purge user-scoped caches so the next signed-in user never sees stale data.
        qc.clear();
        // Another account saved here takes over.
        for (const a of savedAccounts()) {
          try {
            await switchTo(a.id);
            return true;
          } catch {
            /* that login ended too: try the next */
          }
        }
        return false;
      },
      switchAccount: async (id) => {
        if (id === session?.user?.id) return;
        await switchTo(id);
      },
      forgetAccount: async (id) => {
        const a = savedAccounts().find((x) => x.id === id);
        forgetSaved(id);
        if (!a || id === session?.user?.id) return;
        // Ends that login on the server too (when it's still valid).
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/logout?scope=local`, {
          method: "POST",
          headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string, Authorization: `Bearer ${a.access_token}` },
        }).catch(() => undefined);
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
