import { readStoredSession } from "@/lib/supabase";
import { getOne, putOne, tx } from "./idb";

// -----------------------------------------------------------------------------
// Whiteboards and their docs on the device, so they open with no network and
// show at once even online (the server copy then replaces them).
//
//   wb    one record per board: its items as last shown
//   docs  one record per doc: the whole Yjs state
//
// Changes themselves travel through the outbox, never from these copies.
// Both belong to the account that opened the board / doc (passed in by the
// caller, so a sign-in in another tab can't relabel them) and are wiped on
// sign-out with the rest of the offline copy (offlineCache.ts).
// -----------------------------------------------------------------------------

const MAX_BOARDS = 30;
const MAX_DOCS = 200;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface WbRecord<I> {
  owner: string;
  at: number;
  items: I[];
}

interface DocRecord {
  owner: string;
  at: number;
  state: Uint8Array;
}

const me = () => readStoredSession()?.user.id ?? null;

export async function loadWbSnapshot<I>(boardId: string, owner: string): Promise<{ items: I[]; at: number } | null> {
  if (owner !== me()) return null;
  try {
    const r = await getOne<WbRecord<I>>("wb", boardId);
    if (!r || r.owner !== owner || Date.now() - r.at > MAX_AGE_MS) return null;
    return { items: r.items, at: r.at };
  } catch {
    return null;
  }
}

/** Saved only while `owner` is still the account signed in on this device. */
export async function saveWbSnapshot<I>(boardId: string, items: I[], owner: string): Promise<void> {
  if (owner !== me()) return;
  try {
    await putOne("wb", boardId, { owner, at: Date.now(), items } satisfies WbRecord<I>);
    void prune("wb", MAX_BOARDS);
  } catch {
    /* quota or no IndexedDB: the board just won't open offline */
  }
}

export async function wbSnapshotAge(boardId: string): Promise<number | null> {
  const owner = me();
  try {
    const box = await tx("wb", "readonly", (t) => {
      const res: { at: number | null } = { at: null };
      const req = t.objectStore("wb").get(boardId);
      req.onsuccess = () => {
        const r = req.result as WbRecord<unknown> | undefined;
        if (r && r.owner === owner) res.at = r.at;
      };
      return res;
    });
    return box.at === null ? null : Date.now() - box.at;
  } catch {
    return null;
  }
}

export async function loadDocSnapshot(docId: string, owner: string): Promise<Uint8Array | null> {
  if (owner !== me()) return null;
  try {
    const r = await getOne<DocRecord>("docs", docId);
    if (!r || r.owner !== owner || Date.now() - r.at > MAX_AGE_MS) return null;
    return r.state;
  } catch {
    return null;
  }
}

export async function saveDocSnapshot(docId: string, state: Uint8Array, owner: string): Promise<void> {
  if (owner !== me()) return;
  try {
    await putOne("docs", docId, { owner, at: Date.now(), state } satisfies DocRecord);
    void prune("docs", MAX_DOCS);
  } catch {
    /* best effort */
  }
}

let pruning = false;
/** Keep only the most recently saved few. */
async function prune(store: "wb" | "docs", max: number) {
  if (pruning) return;
  pruning = true;
  try {
    await tx(store, "readwrite", (t) => {
      const s = t.objectStore(store);
      const all: { key: IDBValidKey; at: number }[] = [];
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          all.push({ key: c.key, at: (c.value as { at?: number }).at ?? 0 });
          c.continue();
          return;
        }
        if (all.length <= max) return;
        all.sort((a, b) => b.at - a.at);
        for (const x of all.slice(max)) s.delete(x.key);
      };
    });
  } catch {
    /* next time */
  } finally {
    pruning = false;
  }
}
