import { useSyncExternalStore } from "react";
import type { Session } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// The accounts signed in on this device, to switch between them without
// typing a password: each one's login (kept up to date as it refreshes) next
// to its name and picture. Logging out of one forgets it. The same browser
// storage already holds the current login (supabase.ts), so nothing new is
// exposed by keeping the others.
// -----------------------------------------------------------------------------

const KEY = "iklipse.accounts";
const EVENT = "iklipse-accounts";

export interface SavedAccount {
  id: string;
  name: string;
  username: string;
  avatar_url: string | null;
  access_token: string;
  refresh_token: string;
  /** Last used: the list shows the most recent first. */
  at: number;
}

const valid = (a: unknown): a is SavedAccount =>
  !!a && typeof (a as SavedAccount).id === "string" && typeof (a as SavedAccount).refresh_token === "string";

let cacheRaw: string | null = null;
let cache: SavedAccount[] = [];

export function savedAccounts(): SavedAccount[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return cache;
  }
  if (raw === cacheRaw) return cache;
  cacheRaw = raw;
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    cache = Array.isArray(v) ? v.filter(valid).sort((a, b) => b.at - a.at) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: SavedAccount[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: nothing is remembered */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Keep this login (new or refreshed), with who it is when known. */
export function rememberSession(s: Session, who?: { name: string; username: string; avatar_url: string | null } | null) {
  const list = savedAccounts();
  const old = list.find((a) => a.id === s.user.id);
  const next: SavedAccount = {
    id: s.user.id,
    name: who?.name ?? old?.name ?? s.user.email?.split("@")[0] ?? "Account",
    username: who?.username ?? old?.username ?? s.user.email?.split("@")[0] ?? "",
    avatar_url: who ? who.avatar_url : (old?.avatar_url ?? null),
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    at: who || !old ? Date.now() : old.at,
  };
  if (
    old &&
    old.access_token === next.access_token &&
    old.refresh_token === next.refresh_token &&
    old.name === next.name &&
    old.avatar_url === next.avatar_url &&
    old.at === next.at
  ) {
    return;
  }
  write([next, ...list.filter((a) => a.id !== s.user.id)]);
}

export function forgetSaved(id: string) {
  const list = savedAccounts();
  if (list.some((a) => a.id === id)) write(list.filter((a) => a.id !== id));
}

function subscribe(fn: () => void) {
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}

/** The saved accounts, live (another tab signing in shows up here too). */
export function useSavedAccounts(): SavedAccount[] {
  return useSyncExternalStore(subscribe, savedAccounts, () => cache);
}
