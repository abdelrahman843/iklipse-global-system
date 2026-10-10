import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { readStoredSession, supabase } from "@/lib/supabase";
import { isOnline } from "@/lib/offline/net";
import { isQueued } from "@/lib/offline/outbox";
import { loadDocSnapshot, saveDocSnapshot } from "@/lib/offline/wbCache";

// -----------------------------------------------------------------------------
// One open doc (Miro Docs). The text is a Yjs document, so any number of
// people can type at once and every copy converges.
//
//   log     public.wb_doc_update: every change, base64. Opening a doc replays
//           it; editors fold a long log into one row (wb_doc_compact).
//   live    private broadcast "wbe:<board>": changes as they're typed, plus
//           carets (Yjs awareness). Only editors may send on it (0040).
//   backup  postgres_changes on the log, for anything the broadcast missed.
//   device  the whole doc saved on this device (offline/wbCache.ts): it opens
//           with no network, and whatever the device has that the server's
//           log doesn't (typed offline, app closed before saving) is sent up
//           when the log comes in.
// Applying the same change twice is harmless in Yjs, so the paths can overlap.
// -----------------------------------------------------------------------------

export const DOC_FIELD = "doc";
const REMOTE = Symbol("remote");
const COMPACT_AFTER = 40;
const SEND_EVERY = 40;
const SAVE_EVERY = 400;
/** Offline, saves only queue up on the device: fewer, bigger ones. */
const SAVE_EVERY_OFFLINE = 4000;
const SNAPSHOT_EVERY = 1000;

// realtime-js hands back a channel that is still closing for the same topic, so
// a doc opened right after another waits for the previous one to let go.
let lastClose: Promise<unknown> = Promise.resolve();

// One live session per doc in this tab: a newer one replaces any leftover
// (otherwise the old one would show up as a second "you" in the doc).
const live = new Map<string, DocSession>();

export type DocStatus = "loading" | "ready" | "error";
export type DocSaveState = "saved" | "saving" | "offline";

function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

async function fetchLog(docId: string, after = 0): Promise<{ id: number; u: string }[]> {
  const out: { id: number; u: string }[] = [];
  let from = after;
  for (;;) {
    const { data, error } = await supabase
      .from("wb_doc_update")
      .select("id, u")
      .eq("doc_id", docId)
      .gt("id", from)
      .order("id")
      .limit(500);
    if (error) throw error;
    const rows = (data ?? []) as { id: number; u: string }[];
    out.push(...rows);
    if (rows.length < 500) break;
    from = rows[rows.length - 1]!.id;
  }
  return out;
}

export interface DocSessionOpts {
  boardId: string;
  docId: string;
  canEdit: boolean;
  copyOf?: string[];
  user: { name: string; color: string };
  onStatus: (s: DocStatus, error?: string) => void;
  onSave: (s: DocSaveState) => void;
}

export class DocSession {
  readonly ydoc = new Y.Doc();
  readonly awareness = new Awareness(this.ydoc);
  private channel: RealtimeChannel | null = null;
  private lastId = 0;
  private outbox: Uint8Array[] = [];
  private unsaved: Uint8Array[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private failures = 0;
  private closed = false;
  private loaded = false;
  /** Opened from the device copy; the server's log hasn't been compared yet. */
  private fromDevice = false;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  /** The account that opened the doc: the device copy is kept for it only. */
  private readonly owner = readStoredSession()?.user.id ?? "";

  constructor(private o: DocSessionOpts) {
    const prev = live.get(o.docId);
    if (prev) void prev.close();
    live.set(o.docId, this);
    this.awareness.setLocalStateField("user", o.user);
    this.ydoc.on("update", this.onLocal);
    this.awareness.on("update", this.onAwareness);
    // A phone can freeze or kill the app once it's in the background: save now.
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onHide);
    void this.start();
  }

  // -------------------------------------------------------------- loading --
  private async start() {
    const { boardId, docId } = this.o;
    await lastClose;
    // The device copy first: the doc shows at once, and opens offline.
    const snap = await loadDocSnapshot(docId, this.owner);
    if (this.closed) return;
    if (snap) {
      try {
        Y.applyUpdate(this.ydoc, snap, REMOTE);
        this.fromDevice = true;
        this.loaded = true;
        this.o.onStatus("ready");
      } catch {
        /* a damaged copy: the server's log is the truth */
      }
    }
    try {
      const rows = await fetchLog(docId);
      if (this.closed) return;
      this.reconcile(rows);
      if (!rows.length && !snap && this.o.copyOf?.length) await this.copyFrom(this.o.copyOf);
      else if (rows.length > COMPACT_AFTER && this.o.canEdit) void this.compact();
      this.loaded = true;
      this.o.onStatus("ready");
      this.snapshotSoon();
    } catch (e) {
      if (this.closed) return;
      if (!this.fromDevice) {
        this.o.onStatus(
          "error",
          isOnline() ? (e as Error).message : "This doc isn't on this device yet. Open it once with a connection to use it offline.",
        );
        return;
      }
      // Offline with the device copy: keep editing; the channel below catches up later.
    }

    const ch = supabase.channel(`wbe:${boardId}`, { config: { private: true, broadcast: { self: false } } });
    this.channel = ch;
    ch.on("broadcast", { event: "u" }, ({ payload }) => {
      const p = payload as { d?: string; u?: string };
      if (p.d === docId && p.u) this.applyRemote(fromB64(p.u));
    })
      .on("broadcast", { event: "a" }, ({ payload }) => {
        const p = payload as { d?: string; u?: string };
        if (p.d !== docId || !p.u) return;
        const before = this.awareness.getStates().size;
        applyAwarenessUpdate(this.awareness, fromB64(p.u), REMOTE);
        // Someone new: tell them where I am.
        if (this.awareness.getStates().size > before) this.sendAwareness();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "wb_doc_update", filter: `doc_id=eq.${docId}` }, (p) => {
        const row = p.new as { id?: number; u?: string };
        if (!row.u) return;
        this.applyRemote(fromB64(row.u));
        if (row.id && row.id > this.lastId) this.lastId = row.id;
      })
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED" || this.closed) return;
        this.sendAwareness();
        // Catch up on anything saved while the channel was down.
        try {
          const full = this.fromDevice && this.lastId === 0;
          const rows = await fetchLog(docId, this.lastId);
          if (full) this.reconcile(rows);
          else this.applyRows(rows);
        } catch {
          /* the next reconnect tries again */
        }
      });
  }

  /**
   * The server's whole log has arrived. Anything the device copy holds that
   * the log doesn't (typed offline, or the app closed before it was saved)
   * goes up now, then the log is applied.
   */
  private reconcile(rows: { id: number; u: string }[]) {
    if (this.fromDevice && this.o.canEdit) {
      const server = new Y.Doc();
      for (const r of rows) {
        try {
          Y.applyUpdate(server, fromB64(r.u));
        } catch {
          /* skip a damaged row */
        }
      }
      const missing = Y.encodeStateAsUpdate(this.ydoc, Y.encodeStateVector(server));
      // Only if it changes something (the update always carries every deletion).
      const before = Y.snapshot(server);
      Y.applyUpdate(server, missing);
      const changes = !Y.equalSnapshots(before, Y.snapshot(server));
      server.destroy();
      if (changes) {
        this.unsaved.push(missing);
        this.scheduleSave(0);
      }
    }
    this.fromDevice = false;
    this.applyRows(rows);
  }

  private snapshotSoon() {
    if (this.snapTimer || !this.loaded) return;
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      this.snapshot();
    }, SNAPSHOT_EVERY);
  }

  private snapshot() {
    if (!this.loaded || !this.owner) return;
    void saveDocSnapshot(this.o.docId, Y.encodeStateAsUpdate(this.ydoc), this.owner);
  }

  private onHide = () => {
    if (document.visibilityState !== "hidden" || this.closed) return;
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = null;
    this.snapshot();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.save();
  };

  private applyRows(rows: { id: number; u: string }[]) {
    if (!rows.length) return;
    this.ydoc.transact(() => {
      for (const r of rows) {
        try {
          Y.applyUpdate(this.ydoc, fromB64(r.u), REMOTE);
        } catch {
          /* a damaged row shouldn't keep the rest out */
        }
        if (r.id > this.lastId) this.lastId = r.id;
      }
    }, REMOTE);
  }

  private applyRemote(u: Uint8Array) {
    try {
      Y.applyUpdate(this.ydoc, u, REMOTE);
    } catch {
      /* ignore malformed */
    }
  }

  /** A pasted / duplicated doc starts from its original's content. */
  private async copyFrom(sources: string[]) {
    for (const src of sources.slice(0, 4)) {
      const rows = await fetchLog(src);
      if (!rows.length) continue;
      this.ydoc.transact(() => {
        for (const r of rows) {
          try {
            Y.applyUpdate(this.ydoc, fromB64(r.u));
          } catch {
            /* skip */
          }
        }
      }, this.o.canEdit ? undefined : REMOTE);
      return;
    }
  }

  private async compact() {
    const upto = this.lastId;
    const { error } = await supabase.rpc("wb_doc_compact", {
      p_board: this.o.boardId,
      p_doc: this.o.docId,
      p_upto: upto,
      p_u: toB64(Y.encodeStateAsUpdate(this.ydoc)),
    });
    if (error) console.warn("Doc compaction skipped", error.message);
  }

  // --------------------------------------------------------------- saving --
  private onLocal = (u: Uint8Array, origin: unknown) => {
    if (!this.closed) this.snapshotSoon();
    if (origin === REMOTE || !this.o.canEdit || this.closed) return;
    this.outbox.push(u);
    this.unsaved.push(u);
    if (!this.sendTimer) this.sendTimer = setTimeout(this.send, SEND_EVERY);
    this.scheduleSave(isOnline() ? SAVE_EVERY : SAVE_EVERY_OFFLINE);
    // Typing before the log arrived is still saved, just after it.
    if (!this.loaded) this.o.onSave("saving");
  };

  private send = () => {
    this.sendTimer = null;
    if (!this.outbox.length) return;
    const u = this.outbox.length === 1 ? this.outbox[0]! : Y.mergeUpdates(this.outbox);
    this.outbox = [];
    void this.channel?.send({ type: "broadcast", event: "u", payload: { d: this.o.docId, u: toB64(u) } });
  };

  private scheduleSave(ms: number) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, ms);
  }

  private async save() {
    if (this.saving || !this.unsaved.length) return;
    this.saving = true;
    this.o.onSave("saving");
    const batch = this.unsaved;
    this.unsaved = [];
    const u = batch.length === 1 ? batch[0]! : Y.mergeUpdates(batch);
    const { data, error, status } = await supabase
      .from("wb_doc_update")
      .insert({ board_id: this.o.boardId, doc_id: this.o.docId, u: toB64(u) })
      .select("id")
      .single();
    this.saving = false;
    if (error) {
      // Keep it for the next try; merging later changes onto it is fine.
      this.unsaved = [...batch, ...this.unsaved];
      this.failures++;
      this.o.onSave("offline");
      if (!this.closed) this.scheduleSave(Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)));
      return;
    }
    this.failures = 0;
    const id = (data as { id?: number } | null)?.id;
    if (id && id > this.lastId) this.lastId = id;
    if (this.unsaved.length) this.scheduleSave(SAVE_EVERY);
    // Queued on the device (offline): saved here, not on the server yet.
    else this.o.onSave(isQueued(status) ? "offline" : "saved");
  }

  get pending() {
    return this.unsaved.length > 0 || this.saving;
  }

  // ------------------------------------------------------------ awareness --
  private onAwareness = (_: unknown, origin: unknown) => {
    if (origin === REMOTE) return;
    this.sendAwareness();
  };

  private sendAwareness() {
    if (!this.channel || !this.o.canEdit) return;
    const u = encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]);
    void this.channel.send({ type: "broadcast", event: "a", payload: { d: this.o.docId, u: toB64(u) } });
  }

  /** Save what's left, say goodbye, and let go of everything. */
  close(): Promise<unknown> {
    if (this.closed) return lastClose;
    lastClose = this.finish();
    return lastClose;
  }

  private async finish() {
    if (live.get(this.o.docId) === this) live.delete(this.o.docId);
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], "local");
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
      this.send();
    }
    this.closed = true;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.unsaved.length) await this.save();
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapshot();
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onHide);
    this.ydoc.off("update", this.onLocal);
    this.awareness.off("update", this.onAwareness);
    if (this.channel) await supabase.removeChannel(this.channel).catch(() => undefined);
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
