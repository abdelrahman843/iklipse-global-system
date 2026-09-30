import { dehydrate, hydrate, onlineManager, type DehydratedState, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { AUTH_STORAGE_KEY, supabase } from "./supabase";
import type { Profile, Workspace } from "./database.types";

// -----------------------------------------------------------------------------
// Offline viewing (read-only).
//
// The last-seen boards, cards and notifications are copied from the TanStack
// Query cache into IndexedDB and put back before the first render, so the app
// can paint them without a network. The copy holds client data, so it belongs
// to exactly one account: it is stamped with the owner's user id, ignored for
// anyone else, and wiped on sign-out or account switch. Everything here is best
// effort: if IndexedDB is missing or fails, the app simply runs without it.
// -----------------------------------------------------------------------------

const DB_NAME = "iklipse-offline";
const STORE = "cache";
const RECORD = "queries";
const HOUR_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * HOUR_MS;
/** Restored queries stay in memory this long, so an offline session keeps them. */
const RESTORED_GC_MS = 24 * HOUR_MS;
const RESTORE_TIMEOUT_MS = 1500;
const PERSIST_DELAY_MS = 10_000;

/** First query-key segments worth keeping offline. */
const PERSISTED = new Set(["boards", "board", "card", "my-work", "notifications", "notif-unread"]);
/** Big per-item bundles: keep only the most recently loaded few. */
const LIMITS = new Map<string, number>([
  ["board", 10],
  ["card", 40],
]);
/** Rough ceiling on the saved data (JSON characters). */
const MAX_CHARS = 4_000_000;

// Changes with every deploy (the entry script's file name carries a content
// hash), so a new build never reads data shaped by an older one.
const BUSTER = import.meta.env.PROD
  ? (document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src") ?? "prod")
  : "dev";

interface AuthSnapshot {
  owner: string;
  profile: Profile;
  workspace: Workspace | null;
}

interface PersistedRecord {
  owner: string;
  buster: string;
  savedAt: number;
  state: DehydratedState;
  auth: { profile: Profile; workspace: Workspace | null } | null;
}

let client: QueryClient | null = null;
/** User the saved copy is written for (null = nobody, never persist). */
let owner: string | null = null;
/** User whose rows may be in the in-memory query cache. */
let memoryOwner: string | null = null;
/** Bumped on every wipe so an in-flight save for the old owner is dropped. */
let epoch = 0;
let authSnapshot: AuthSnapshot | null = null;
let timer: number | undefined;

// ---- helpers ---------------------------------------------------------------

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

/** True for "no connection" failures (not for server or permission errors). */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (isAuthRetryableFetchError(e)) return true;
  const msg =
    e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(msg);
}

const isPersistable = (key: QueryKey) => typeof key[0] === "string" && PERSISTED.has(key[0]);

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

// ---- session ---------------------------------------------------------------

/**
 * getSession() that survives having no network. An expired token can't be
 * refreshed offline (supabase-js retries for ~25 s, then reports no session
 * but keeps it in storage), which must not look like a sign-out: reuse the
 * saved session and let supabase-js refresh it once the network is back.
 */
export async function getSessionOfflineSafe(): Promise<Session | null> {
  const stored = readStoredSession();
  if (stored && !navigator.onLine) return stored;
  const { data, error } = await supabase.auth.getSession();
  if (data.session) return data.session;
  return error && isNetworkError(error) ? readStoredSession() : null;
}

/**
 * Resolves once requests would carry a usable token again (or there is no
 * session to wait for). Right after reconnecting, supabase-js may still be
 * cooling down from its failed offline refreshes; requests sent then go out
 * as anonymous and come back empty.
 */
async function sessionReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (!readStoredSession()) return;
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session) return;
    } catch {
      /* keep waiting */
    }
    if (!navigator.onLine) return;
    await sleep(3000);
  }
}

/**
 * TanStack's online state. v5 assumes "online" at startup and only listens for
 * events, so seed it from navigator.onLine (queries and mutations then pause
 * instead of failing when the app opens offline). Coming back online is
 * reported only once the auth token is usable, so paused work resumes signed in.
 */
export function setupOnlineManager() {
  onlineManager.setEventListener((setOnline) => {
    let run = 0;
    const update = () => {
      const id = ++run;
      if (!navigator.onLine) {
        setOnline(false);
        return;
      }
      void sessionReady().then(() => {
        if (id === run && navigator.onLine) setOnline(true);
      });
    };
    setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  });
}

// ---- IndexedDB ---------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    // A failed open stays failed for this page load: no retry storm.
    dbPromise.catch(() => undefined);
  }
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = op(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error ?? req.error);
    t.onabort = () => reject(t.error ?? req.error);
  });
}

// ---- restore / wipe ------------------------------------------------------------

/**
 * Put the saved cache back into `qc`. Call before the first render. Only
 * restores a copy that belongs to the user signed in on this device, from this
 * build, and at most 7 days old; anything else is wiped. Never throws and
 * never blocks longer than ~1.5 s.
 */
export async function restorePersistedCache(qc: QueryClient): Promise<void> {
  client = qc;
  try {
    const read = openDb().then((db) => tx<PersistedRecord | undefined>(db, "readonly", (s) => s.get(RECORD)));
    const rec = await Promise.race([read, sleep(RESTORE_TIMEOUT_MS).then(() => undefined)]);
    if (!rec) return;
    const uid = readStoredSession()?.user.id ?? null;
    if (!uid || rec.owner !== uid || rec.buster !== BUSTER || Date.now() - rec.savedAt > MAX_AGE_MS) {
      await clearPersistedCache();
      return;
    }
    const oldest = Date.now() - MAX_AGE_MS;
    hydrate(
      qc,
      {
        mutations: [],
        queries: rec.state.queries.filter((q) => isPersistable(q.queryKey) && q.state.dataUpdatedAt >= oldest),
      },
      { defaultOptions: { queries: { gcTime: RESTORED_GC_MS } } },
    );
    owner = uid;
    memoryOwner = uid;
    authSnapshot = rec.auth ? { owner: uid, ...rec.auth } : null;
  } catch {
    /* offline cache is best effort */
  }
}

/** Delete the saved copy (sign-out, account switch). Safe to call any time. */
export async function clearPersistedCache(): Promise<void> {
  epoch++;
  owner = null;
  authSnapshot = null;
  window.clearTimeout(timer);
  timer = undefined;
  try {
    const db = await openDb();
    await tx(db, "readwrite", (s) => s.delete(RECORD));
  } catch {
    /* nothing saved, or IndexedDB unavailable */
  }
}

/**
 * Tie the cache to the signed-in account. Signing out, or a different account
 * signing in (here or in another tab), drops both the saved copy and anything
 * the previous account left in memory.
 */
export function bindCacheToUser(userId: string | null) {
  if (memoryOwner && memoryOwner !== userId) client?.clear();
  if (!userId || (owner && owner !== userId)) void clearPersistedCache();
  memoryOwner = userId;
  owner = userId;
}

// ---- profile snapshot ----------------------------------------------------------

/** Remember profile + workspace so the app can open offline (saved with the cache). */
export function rememberAuthSnapshot(userId: string, profile: Profile | null, workspace: Workspace | null) {
  if (!profile || userId !== owner) return;
  authSnapshot = { owner: userId, profile, workspace };
  schedule();
}

export function getAuthSnapshot(userId: string): AuthSnapshot | null {
  return authSnapshot?.owner === userId ? authSnapshot : null;
}

// ---- persist -------------------------------------------------------------------

function size(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

/** Newest boards/cards first, capped by count and by total size. */
function trim(queries: DehydratedState["queries"]): DehydratedState["queries"] {
  const kept: DehydratedState["queries"] = [];
  const ranked: DehydratedState["queries"] = [];
  let budget = MAX_CHARS;
  for (const q of queries) {
    if (LIMITS.has(String(q.queryKey[0]))) ranked.push(q);
    else {
      kept.push(q);
      budget -= size(q.state.data);
    }
  }
  ranked.sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  const counts: Record<string, number> = {};
  for (const q of ranked) {
    const k = String(q.queryKey[0]);
    if ((counts[k] ?? 0) >= (LIMITS.get(k) ?? 0)) continue;
    const n = size(q.state.data);
    if (n > budget) continue;
    budget -= n;
    counts[k] = (counts[k] ?? 0) + 1;
    kept.push(q);
  }
  return kept;
}

async function persist(allowOffline = false) {
  timer = undefined;
  const qc = client;
  const uid = owner;
  if (!qc || !uid) return;
  // Offline, some board edits (plain promises, not mutations) fail after
  // their optimistic patch; saving then would keep changes the server never
  // took. Only the save right as the connection drops is allowed; anything
  // later waits for the next change once back online.
  if (!allowOffline && !navigator.onLine) return;
  // Optimistic edits waiting on the network are not saved data: skip until
  // they settle, so the offline copy only ever shows what the server has.
  if (qc.isMutating() > 0) {
    if (navigator.onLine) schedule();
    return;
  }
  const myEpoch = epoch;
  let record: PersistedRecord;
  try {
    const now = Date.now();
    const state = dehydrate(qc, {
      shouldDehydrateQuery: (q) =>
        q.state.status === "success" && isPersistable(q.queryKey) && now - q.state.dataUpdatedAt < MAX_AGE_MS,
      shouldDehydrateMutation: () => false,
    });
    const auth = authSnapshot?.owner === uid ? { profile: authSnapshot.profile, workspace: authSnapshot.workspace } : null;
    record = { owner: uid, buster: BUSTER, savedAt: now, state: { mutations: [], queries: trim(state.queries) }, auth };
  } catch {
    return;
  }
  try {
    const db = await openDb();
    // Signed out or switched account while we were getting here: drop it.
    if (myEpoch !== epoch || owner !== uid) return;
    await tx(db, "readwrite", (s) => s.put(record, RECORD));
  } catch {
    /* quota, private mode, uncloneable data: skip this round */
  }
}

function schedule() {
  if (timer === undefined) timer = window.setTimeout(() => void persist(), PERSIST_DELAY_MS);
}

function flush(allowOffline = false) {
  if (timer === undefined) return; // nothing changed since the last save
  window.clearTimeout(timer);
  void persist(allowOffline);
}

/** Keep the saved copy current: shortly after data changes, and when the tab hides or the network drops. */
export function startCachePersistence(qc: QueryClient) {
  client = qc;
  // The saved copy mirrors what is in memory, so keep these around longer than
  // the 5 min default: the boards list survives a long stay on one board, and
  // recently opened boards/cards stay available for an hour.
  for (const k of PERSISTED) qc.setQueryDefaults([k], { gcTime: LIMITS.has(k) ? HOUR_MS : 24 * HOUR_MS });
  qc.getQueryCache().subscribe((e) => {
    const changed = (e.type === "updated" && e.action.type === "success") || e.type === "removed";
    if (changed && isPersistable(e.query.queryKey)) schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", () => flush());
  window.addEventListener("offline", () => flush(true));
}
