import { hydrate, onlineManager, type DehydratedState, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { isAuthRetryableFetchError, type Session } from "@supabase/supabase-js";
import { readStoredSession, supabase } from "./supabase";
import type { Profile, Workspace } from "./database.types";
import { clearStore, getOne, putOne, tx, type StoreName } from "./offline/idb";
import { isOnline, onConnectivity } from "./offline/net";
import { hadWaitingChanges, onOutboxEvent, whenSent } from "./offline/outbox";

export { readStoredSession };

// -----------------------------------------------------------------------------
// Offline copy of what the app has shown.
//
// Query data (boards, cards, notifications...) is copied into IndexedDB, one
// record per query, and put back when the app starts, so every screen opened
// before works with no network. The copy includes changes not on the server
// yet: those are safe in the outbox (offline/outbox.ts) and reach the server
// later, so the screen and the server end up the same.
//
// The copy holds client data, so it belongs to exactly one account: stamped
// with the owner's user id, ignored for anyone else, and wiped on sign-out or
// account switch (the outbox is not: unsent changes are kept for their owner).
// Everything here is best effort: without IndexedDB the app runs online only.
// -----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = 30 * DAY_MS;
/** Restored queries stay in memory this long, so an offline session keeps them. */
const RESTORED_GC_MS = DAY_MS;
const RESTORE_TIMEOUT_MS = 2500;
const PERSIST_DELAY_MS = 800;
/** Bump when the shape of persisted query data changes. */
const SCHEMA = 3;

/** Never kept: search results, signed links that expire, admin-only data. */
const SKIP = new Set(["search", "brief-images", "integrations", "wb-share-links", "users", "profile-contact", "ai-status"]);
/** Many small ones: read from the device only when a screen asks. */
const LAZY = new Set(["card", "activity"]);
/** How many to keep of each (newest first). */
const LIMITS: Record<string, number> = { card: 4000, activity: 600, board: 80, "wb-comments": 60 };

interface AuthSnapshot {
  owner: string;
  profile: Profile;
  workspace: Workspace | null;
}

interface QueryRecord {
  owner: string;
  schema: number;
  key: QueryKey;
  hash: string;
  data: unknown;
  updatedAt: number;
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
const dirty = new Map<string, Query>();
/** Data just read back from the device (no need to write it again). */
const restored = new WeakSet<object>();

// ---- helpers ---------------------------------------------------------------

/** True for "no connection" failures (not for server or permission errors). */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (isAuthRetryableFetchError(e)) return true;
  const msg =
    e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e ?? "");
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|internet connection|^offline/i.test(msg);
}

const prefix = (key: QueryKey) => (typeof key[0] === "string" ? key[0] : "");
const isPersistable = (key: QueryKey) => {
  const p = prefix(key);
  return !!p && !SKIP.has(p);
};
const storeFor = (key: QueryKey): StoreName => (LAZY.has(prefix(key)) ? "lazy" : "queries");

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function asDehydrated(r: QueryRecord): DehydratedState["queries"][number] {
  return {
    queryKey: r.key,
    queryHash: r.hash,
    state: {
      data: r.data,
      dataUpdateCount: 1,
      dataUpdatedAt: r.updatedAt,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: "success",
      fetchStatus: "idle",
    },
  } as DehydratedState["queries"][number];
}

const usable = (r: QueryRecord | undefined, uid: string, oldest: number): r is QueryRecord =>
  !!r && r.owner === uid && r.schema === SCHEMA && r.updatedAt >= oldest;

// ---- session ---------------------------------------------------------------

/**
 * getSession() that survives having no network. An expired token can't be
 * refreshed offline (supabase-js retries for ~25 s, then reports no session
 * but keeps it in storage), which must not look like a sign-out: reuse the
 * saved session and let supabase-js refresh it once the network is back.
 */
export async function getSessionOfflineSafe(): Promise<Session | null> {
  const stored = readStoredSession();
  if (stored && !isOnline()) return stored;
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
    if (!isOnline()) return;
    await sleep(3000);
  }
}

/**
 * TanStack's online state follows the server's reachability (offline/net.ts),
 * not just the network cable: while it's "offline" queries pause and show the
 * saved copy instead of failing. Coming back is reported once the login token
 * works again AND the changes made offline have been sent, so the refetch that
 * follows already includes them (no flash of the old data).
 */
export function setupOnlineManager() {
  onlineManager.setEventListener((setOnline) => {
    let run = 0;
    const update = (online: boolean) => {
      const id = ++run;
      if (!online) {
        setOnline(false);
        return;
      }
      void (async () => {
        await sessionReady();
        await whenSent();
        if (id === run && isOnline()) setOnline(true);
      })();
    };
    // Changes left from last time go out before the first fetch.
    const waiting = hadWaitingChanges();
    setOnline(isOnline() && !waiting);
    if (isOnline() && waiting) update(true);
    return onConnectivity(update);
  });
  // Changes reached the server: refresh what's on screen from it.
  onOutboxEvent((e) => {
    if (e.type === "synced" && client) void client.invalidateQueries();
  });
}

// ---- restore / wipe ------------------------------------------------------------

/**
 * Put the saved copy back into `qc`. Call before the first render. Only
 * restores records of the user signed in on this device, at most 30 days old.
 * Never throws; gives up waiting after ~2.5 s (and still restores when done).
 */
export async function restorePersistedCache(qc: QueryClient): Promise<void> {
  client = qc;
  const uid = readStoredSession()?.user.id ?? null;
  if (!uid) {
    void clearPersistedCache();
    return;
  }
  owner = uid;
  memoryOwner = uid;
  const work = (async () => {
    const oldest = Date.now() - MAX_AGE_MS;
    const [recs, auth] = await Promise.all([
      tx("queries", "readonly", (t) => {
        const box: { all: QueryRecord[] } = { all: [] };
        const req = t.objectStore("queries").getAll();
        req.onsuccess = () => {
          box.all = req.result as QueryRecord[];
        };
        return box;
      }),
      getOne<AuthSnapshot>("meta", "auth"),
    ]);
    if (owner !== uid) return;
    // Someone else's copy: drop it.
    if (recs.all.some((r) => r.owner !== uid) || (auth && auth.owner !== uid)) {
      await clearPersistedCache();
      owner = uid;
      return;
    }
    if (auth?.profile) authSnapshot = auth;
    const mine = recs.all.filter((r) => usable(r, uid, oldest) && isPersistable(r.key));
    for (const r of mine) if (r.data && typeof r.data === "object") restored.add(r.data);
    hydrate(qc, { mutations: [], queries: mine.map(asDehydrated) }, { defaultOptions: { queries: { gcTime: RESTORED_GC_MS } } });
  })().catch(() => undefined);
  await Promise.race([work, sleep(RESTORE_TIMEOUT_MS)]);
}

/** Delete the saved copy (sign-out, account switch). Safe to call any time. Keeps the outbox. */
export async function clearPersistedCache(): Promise<void> {
  epoch++;
  owner = null;
  authSnapshot = null;
  dirty.clear();
  window.clearTimeout(timer);
  timer = undefined;
  await Promise.all((["queries", "lazy", "wb", "docs", "meta"] as const).map((s) => clearStore(s).catch(() => undefined)));
  // Pictures the service worker kept for offline viewing (cleared from here
  // too: a page opened with a hard reload has no service worker to ask).
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-media" });
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("iklipse") && n.includes("media-")).map((n) => caches.delete(n)));
  } catch {
    /* no Cache Storage here */
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

/** Remember profile + workspace so the app can open offline. */
export function rememberAuthSnapshot(userId: string, profile: Profile | null, workspace: Workspace | null) {
  if (!profile || userId !== owner) return;
  authSnapshot = { owner: userId, profile, workspace };
  void putOne("meta", "auth", authSnapshot).catch(() => undefined);
}

export function getAuthSnapshot(userId: string): AuthSnapshot | null {
  return authSnapshot?.owner === userId ? authSnapshot : null;
}

// ---- persist -------------------------------------------------------------------

async function persist() {
  timer = undefined;
  const uid = owner;
  if (!uid || !dirty.size) return;
  const batch = [...dirty.values()];
  dirty.clear();
  const myEpoch = epoch;
  const records: { store: StoreName; rec: QueryRecord }[] = [];
  for (const q of batch) {
    if (q.state.status !== "success" || q.state.data === undefined) continue;
    records.push({
      store: storeFor(q.queryKey),
      rec: { owner: uid, schema: SCHEMA, key: q.queryKey, hash: q.queryHash, data: q.state.data, updatedAt: q.state.dataUpdatedAt },
    });
  }
  if (!records.length) return;
  try {
    // Signed out or switched account while we were getting here: drop it.
    if (myEpoch !== epoch || owner !== uid) return;
    await tx(["queries", "lazy"], "readwrite", (t) => {
      for (const { store, rec } of records) t.objectStore(store).put(rec, rec.hash);
    });
    writes += records.length;
    if (writes > 400) {
      writes = 0;
      void prune();
    }
  } catch {
    /* quota, private mode, uncloneable data: skip this round */
  }
}
let writes = 0;

function schedule() {
  if (timer === undefined) timer = window.setTimeout(() => void persist(), PERSIST_DELAY_MS);
}

function flush() {
  if (timer === undefined) return;
  window.clearTimeout(timer);
  void persist();
}

/** Drop what's too old, and the oldest beyond each kind's limit. */
async function prune() {
  const oldest = Date.now() - MAX_AGE_MS;
  for (const store of ["queries", "lazy"] as const) {
    await tx(store, "readwrite", (t) => {
      const s = t.objectStore(store);
      const byKind = new Map<string, { hash: IDBValidKey; at: number }[]>();
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          const r = c.value as QueryRecord;
          if (r.updatedAt < oldest || r.schema !== SCHEMA) c.delete();
          else {
            const k = prefix(r.key);
            const list = byKind.get(k) ?? [];
            list.push({ hash: c.key, at: r.updatedAt });
            byKind.set(k, list);
          }
          c.continue();
          return;
        }
        for (const [k, list] of byKind) {
          const max = LIMITS[k];
          if (!max || list.length <= max) continue;
          list.sort((a, b) => b.at - a.at);
          for (const x of list.slice(max)) s.delete(x.hash);
        }
      };
    }).catch(() => undefined);
  }
}

/** Card details / history: read from the device when a screen asks and memory has none. */
async function restoreLazy(q: Query) {
  const uid = owner;
  if (!uid || !client) return;
  // Filled in the same tick (setQueryData builds the query, then sets it).
  await Promise.resolve();
  if (q.state.data !== undefined) return;
  try {
    const r = await getOne<QueryRecord>("lazy", q.queryHash);
    if (!usable(r, uid, Date.now() - MAX_AGE_MS) || owner !== uid) return;
    const now = client.getQueryCache().get(q.queryHash);
    if (!now || (now.state.data !== undefined && now.state.dataUpdatedAt >= r.updatedAt)) return;
    if (r.data && typeof r.data === "object") restored.add(r.data);
    client.setQueryData(r.key, r.data, { updatedAt: r.updatedAt });
  } catch {
    /* nothing saved */
  }
}

/** Keep the saved copy current: shortly after data changes, and when the app goes to the background. */
export function startCachePersistence(qc: QueryClient) {
  client = qc;
  // Keep queries in memory longer than the 5 min default, so an offline
  // session can go back to screens it saw earlier.
  qc.setQueryDefaults(["boards"], { gcTime: DAY_MS });
  qc.setQueryDefaults(["board"], { gcTime: 6 * 60 * 60 * 1000 });
  qc.getQueryCache().subscribe((e) => {
    const q = e.query;
    if (!isPersistable(q.queryKey)) return;
    if (e.type === "added" && LAZY.has(prefix(q.queryKey)) && q.state.data === undefined) {
      void restoreLazy(q);
      return;
    }
    if (e.type === "updated" && e.action.type === "success") {
      const d = q.state.data;
      if (d && typeof d === "object" && restored.has(d)) return;
      dirty.set(q.queryHash, q);
      schedule();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", () => flush());
  setTimeout(() => void prune(), 20_000);
}
