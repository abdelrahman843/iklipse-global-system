import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { PermissionKey, Profile } from "./database.types";

interface AuthContextValue {
  loading: boolean;
  /**
   * True once session and (when signed in) profile+permissions are all loaded.
   * Consumers should gate redirects/guards on `ready` rather than on `loading`
   * alone — otherwise a fresh sign-in can flash the login page or the
   * "deactivated" state before the profile hydrates.
   */
  ready: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  permissions: Set<PermissionKey>;
  isAdmin: boolean;
  can: (perm: PermissionKey) => boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadProfileAndPermissions(userId: string) {
  const [profileRes, permRes] = await Promise.all([
    supabase.from("profile").select("*").eq("id", userId).maybeSingle(),
    supabase.from("user_permission").select("permission").eq("user_id", userId),
  ]);
  if (profileRes.error) throw profileRes.error;
  if (permRes.error) throw permRes.error;
  const profile = (profileRes.data ?? null) as Profile | null;
  const rows = (permRes.data ?? []) as { permission: PermissionKey }[];
  const perms = new Set<PermissionKey>(rows.map((r) => r.permission));
  return { profile, perms };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [hydrating, setHydrating] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [permissions, setPermissions] = useState<Set<PermissionKey>>(new Set());
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
      setPermissions(new Set());
      setHydrating(false);
      return;
    }
    try {
      const { profile: p, perms } = await loadProfileAndPermissions(s.user.id);
      setProfile(p);
      setPermissions(perms);
    } catch (e) {
      // Fail closed — no profile means no access.
      console.error("Failed to load profile/permissions", e);
      setProfile(null);
      setPermissions(new Set());
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
      // `ready` false and refetches profile/permissions on every focus, which
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
      permissions,
      isAdmin,
      can: (perm) => isAdmin || permissions.has(perm),
      signIn: async (usernameOrEmail, password) => {
        // Login accepts a username (mapped to `<username>@iklipse.local`) OR a raw email.
        const email = usernameOrEmail.includes("@")
          ? usernameOrEmail
          : `${usernameOrEmail.toLowerCase().trim()}@iklipse.local`;
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, ready, session, profile, permissions, isAdmin],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
