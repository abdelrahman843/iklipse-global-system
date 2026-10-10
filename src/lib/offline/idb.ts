// -----------------------------------------------------------------------------
// The one IndexedDB database behind offline mode.
//
//   queries  last-seen query data (boards, notifications...), one record per
//            query, stamped with the account it belongs to (offlineCache.ts);
//            put back into memory when the app starts
//   lazy     the same for the many small ones (card details, card history),
//            read only when a screen asks for them
//   outbox   every write, kept until the server has it (outbox.ts)
//   wb       whiteboard items per board, so a board opens with no network
//   docs     whiteboard doc text (Yjs state) per doc
//   meta     small things: the profile snapshot used to open offline
//
// Everything that uses this is best effort except the outbox: if IndexedDB is
// missing (very old browser, some private modes) the app still runs online.
// -----------------------------------------------------------------------------

const DB_NAME = "iklipse-offline";
const VERSION = 2;

export type StoreName = "queries" | "lazy" | "outbox" | "wb" | "docs" | "meta";

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // v1 kept the whole query cache in one record of "cache".
        if (db.objectStoreNames.contains("cache")) db.deleteObjectStore("cache");
        if (!db.objectStoreNames.contains("queries")) db.createObjectStore("queries");
        if (!db.objectStoreNames.contains("lazy")) db.createObjectStore("lazy");
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        if (!db.objectStoreNames.contains("wb")) db.createObjectStore("wb");
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      req.onsuccess = () => {
        const db = req.result;
        // A newer build in another tab wants to upgrade: let it.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // An older tab still holds v1 open; it closes itself on versionchange, so
      // just wait (onsuccess follows).
      req.onblocked = () => undefined;
    });
    // A failed open stays failed for this page load: no retry storm.
    dbPromise.catch(() => undefined);
  }
  return dbPromise;
}

/** One transaction; resolves with `op`'s result once the transaction has committed. */
export async function tx<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  op: (t: IDBTransaction) => T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out: T;
    try {
      out = op(t);
    } catch (e) {
      try {
        t.abort();
      } catch {
        /* already finished */
      }
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Value of a request once its transaction commits (use inside `tx`). */
export function later<T>(r: IDBRequest<T>): { readonly value: T | undefined } {
  const box: { value: T | undefined } = { value: undefined };
  r.onsuccess = () => {
    box.value = r.result;
  };
  return box;
}

export async function getOne<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const box = await tx(store, "readonly", (t) => later<T>(t.objectStore(store).get(key) as IDBRequest<T>));
  return box.value;
}

export async function putOne(store: StoreName, key: IDBValidKey, value: unknown): Promise<void> {
  await tx(store, "readwrite", (t) => {
    t.objectStore(store).put(value, key);
  });
}

export async function deleteOne(store: StoreName, key: IDBValidKey): Promise<void> {
  await tx(store, "readwrite", (t) => {
    t.objectStore(store).delete(key);
  });
}

export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, "readwrite", (t) => {
    t.objectStore(store).clear();
  });
}
