import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { PermissionKey, Profile, Workspace } from "./database.types";
import { workspaceCan } from "./permissions";

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

  const hydrate = async (s: Session | null) => {
    setHydrating(true);
    setSession(s);
    currentUserId.current = s?.user?.id ?? null;
    if (!s?.user) {
      setProfile(null);
      setWorkspace(null);
      setHydrating(false);
      return;
    }
    try {
      const { profile: p, workspace: w } = await loadProfileAndWorkspace(s.user.id);
      setProfile(p);
      setWorkspace(w);
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
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      signIn: async (usernameOrEmail, password) => {
        // Login accepts a username (mapped to `<username>@iklipse.local`) OR a raw email.
        // "name@iklipseworld.com" is the company-facing form of the same username.
        const raw = usernameOrEmail.toLowerCase().trim().replace(/@iklipseworld\.com$/, "");
        const email = raw.includes("@") ? raw : `${raw}@iklipse.local`;
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      signOut: async () => {
        await supabase.auth.signOut();
        // Purge user-scoped caches so the next signed-in user never sees stale data.
        qc.clear();
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
