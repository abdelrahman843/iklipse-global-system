import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { readStoredSession, supabase } from "@/lib/supabase";
import { isOnline } from "@/lib/offline/net";
import { isQueued, onOutboxEvent, whenSent } from "@/lib/offline/outbox";
import { loadWbSnapshot, saveWbSnapshot } from "@/lib/offline/wbCache";
import type { WbItem } from "./types";
import {
  ackFlush,
  applyRemote,
  applyRemoteDelete,
  geomOf,
  loadItems,
  peerColor,
  resyncItems,
  setDirtyListener,
  takeFlush,
  useWb,
  type Peer,
} from "./store";

// -----------------------------------------------------------------------------
// Whiteboard sync.
//  - Device copy: the board opens from the copy saved on this device (at once,
//    and with no network); the server's rows then replace it.
//  - Saves: pending changes go out in one wb_save() call at a time, ~10/s.
//    Offline they wait in the outbox (lib/offline/outbox.ts) and go out later.
//  - Rows: postgres_changes on wb_item keep every tab on the same content.
//  - Live: a private broadcast channel ("wb:<board>") carries cursors, drags in
//    progress, selections and viewports, about 8 messages a second per person
//    at most; presence lists who is on the board.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

export async function fetchItems(boardId: string): Promise<WbItem[]> {
  const out: WbItem[] = [];
  // Page through big boards (PostgREST caps a response at 1000 rows).
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("wb_item")
      .select("*")
      .eq("board_id", boardId)
      .order("z")
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as WbItem[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ----------------------------------------------------------------- saving --
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
let failures = 0;

function schedule(ms = 100) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

const RETRYABLE = /fetch|network|timeout|Failed to fetch|Load failed|ECONN|503|502|504/i;

async function flush() {
  if (busy) return;
  const s = S();
  if (!s.boardId) return;
  const payload = takeFlush();
  if (!payload) {
    if (!Object.keys(S().dirty).length && !Object.keys(S().inflight).length) set({ saveState: "saved" });
    return;
  }
  busy = true;
  set({ saveState: "saving" });
  const { error, status } = await supabase.rpc("wb_save", {
    p_board: s.boardId,
    p_put: payload.put,
    p_patch: payload.patch,
    p_delete: payload.del,
    p_sid: s.sid,
  });
  busy = false;
  if (!error) {
    failures = 0;
    ackFlush("ok");
    // Queued on the device (offline): saved here, not on the server yet.
    if (isQueued(status)) set({ saveState: "offline" });
    if (Object.keys(S().dirty).length) schedule(60);
    else if (!isQueued(status)) set({ saveState: "saved" });
    return;
  }
  const offline = !navigator.onLine || RETRYABLE.test(`${error.message} ${(error as { details?: string }).details ?? ""}`);
  if (offline || failures < 3) {
    failures++;
    ackFlush("retry");
    set({ saveState: offline ? "offline" : "saving" });
    schedule(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    return;
  }
  // Refused for good (permissions, invalid data): drop it and reload server truth.
  console.error("Whiteboard save failed", error);
  failures = 0;
  ackFlush("drop");
  set({ saveState: "error" });
  try {
    const rows = await fetchItems(s.boardId);
    // Still the same board on screen (another one may have opened meanwhile).
    if (S().boardId === s.boardId) resyncItems(rows);
  } catch {
    /* next reconnect re-syncs */
  }
}

/** Save now (leaving the page, before a reload). */
export function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void flush();
}

// --------------------------------------------------------------- realtime --
type Msg = {
  /** cursor (world), or null when it left the canvas */
  c?: { x: number; y: number } | null;
  /** live geometry of items being dragged */
  l?: Record<string, { x?: number; y?: number; w?: number; h?: number; rotation?: number }>;
  /** selection / text being edited */
  s?: string[];
  e?: string | null;
  /** viewport centre + zoom */
  v?: { cx: number; cy: number; zoom: number };
};

let channel: RealtimeChannel | null = null;
let outbox: Msg = {};
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = 0;
const SEND_EVERY = 125;

function sendSoon() {
  if (sendTimer) return;
  const wait = Math.max(0, SEND_EVERY - (performance.now() - lastSent));
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSent = performance.now();
    const msg = outbox;
    outbox = {};
    if (!channel || !Object.keys(msg).length) return;
    void channel.send({ type: "broadcast", event: "m", payload: { sid: S().sid, ...msg } });
  }, wait);
}

/** Queue a live update; the newest values win within one send window. */
export function broadcast(msg: Msg) {
  if (msg.l) outbox.l = { ...(outbox.l ?? {}), ...msg.l };
  if ("c" in msg) outbox.c = msg.c;
  if (msg.s) outbox.s = msg.s;
  if ("e" in msg) outbox.e = msg.e;
  if (msg.v) outbox.v = msg.v;
  sendSoon();
}

/** Ask everyone to jump to my view. */
export function summonEveryone() {
  const s = S();
  const cx = (s.screen.w / 2 - s.viewport.x) / s.viewport.zoom;
  const cy = (s.screen.h / 2 - s.viewport.y) / s.viewport.zoom;
  void channel?.send({ type: "broadcast", event: "summon", payload: { sid: s.sid, v: { cx, cy, zoom: s.viewport.zoom } } });
}

export const summonListeners = new Set<(from: Peer, v: { cx: number; cy: number; zoom: number }) => void>();

function onMessage(p: Msg & { sid?: string }) {
  if (!p.sid || p.sid === S().sid) return;
  const s = S();
  const peer = s.peers[p.sid];
  if (!peer) return;
  const next: Peer = { ...peer, t: Date.now() };
  if ("c" in p) next.cursor = p.c ?? null;
  if (p.s) next.sel = p.s;
  if ("e" in p) next.editing = p.e ?? null;
  if (p.v) next.view = p.v;
  const patch: Partial<typeof s> = { peers: { ...s.peers, [p.sid]: next } };
  if (p.l) {
    const rl = { ...s.remoteLive };
    const t = Date.now();
    for (const [id, g] of Object.entries(p.l)) {
      if (s.live[id]) continue; // I'm dragging it myself
      rl[id] = { ...g, t };
    }
    patch.remoteLive = rl;
  }
  set(patch);
}

interface PresenceMeta {
  uid: string;
  name: string;
  avatar: string | null;
}

/**
 * Wires one open whiteboard: initial load, row changes, live channel, saving.
 * Returns load state through the store (loaded flag).
 */
export function useWhiteboardSync(boardId: string | undefined, me: { id: string; name: string; avatar: string | null } | null) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!boardId || !me) return;
    let alive = true;
    setDirtyListener(() => schedule());

    // The account this board was opened by: the device copy is kept for it only.
    const owner = readStoredSession()?.user.id ?? me.id;
    // Device copy first: shows at once, and is all there is offline. (Changes
    // themselves are safe in the outbox; this is only what the board looked like.)
    void loadWbSnapshot<WbItem>(boardId, owner).then((snap) => {
      if (!alive || S().boardId !== boardId || S().loaded) return;
      if (snap) loadItems(snap.items);
      else if (!isOnline()) set({ unavailable: true });
    });
    // ...and kept current.
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    const saveSnap = () => {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = null;
      const s = S();
      if (s.boardId !== boardId || !s.loaded) return;
      void saveWbSnapshot(boardId, Object.values(s.items), owner);
    };
    const unsubSnap = useWb.subscribe((s, p) => {
      if (s.items !== p.items && !snapTimer) snapTimer = setTimeout(saveSnap, 1500);
    });
    const onHide = () => document.visibilityState === "hidden" && snapTimer && saveSnap();
    document.addEventListener("visibilitychange", onHide);
    // Changes made offline reached the server.
    const unsubSent = onOutboxEvent((e) => {
      if (e.type === "synced" && S().saveState === "offline" && !Object.keys(S().dirty).length) set({ saveState: "saved" });
    });

    // Rows.
    const rows = supabase.channel(`wb-rows:${boardId}:${Math.random().toString(36).slice(2, 8)}`);
    rows
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "wb_item", filter: `board_id=eq.${boardId}` }, (p) =>
        applyRemote(p.new as WbItem),
      )
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "wb_item", filter: `board_id=eq.${boardId}` }, (p) =>
        applyRemote(p.new as WbItem),
      )
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "wb_item" }, (p) => {
        const id = (p.old as { id?: string })?.id;
        if (id) applyRemoteDelete(id);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "wb_comment", filter: `board_id=eq.${boardId}` }, () =>
        qc.invalidateQueries({ queryKey: ["wb-comments", boardId] }),
      )
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "wb_comment" }, () =>
        qc.invalidateQueries({ queryKey: ["wb-comments", boardId] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "wb_state", filter: `board_id=eq.${boardId}` }, () =>
        qc.invalidateQueries({ queryKey: ["wb-state", boardId] }),
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "wb_vote_session", filter: `board_id=eq.${boardId}` }, () => {
        qc.invalidateQueries({ queryKey: ["wb-votes", boardId] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "board", filter: `id=eq.${boardId}` }, () => {
        qc.invalidateQueries({ queryKey: ["wb-board", boardId] });
        qc.invalidateQueries({ queryKey: ["board-access", boardId] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "board_member", filter: `board_id=eq.${boardId}` }, () => {
        qc.invalidateQueries({ queryKey: ["board-access", boardId] });
        qc.invalidateQueries({ queryKey: ["board-members", boardId] });
      });

    rows.subscribe(async (status) => {
      if (status !== "SUBSCRIBED" || !alive) return;
      // First load, or a re-join after a drop / the device copy: re-sync
      // (missed events aren't replayed). Changes made offline go up first.
      try {
        await whenSent();
        const data = await fetchItems(boardId);
        if (!alive) return;
        if (!S().loaded) loadItems(data);
        else resyncItems(data);
      } catch (e) {
        if (isOnline()) console.error("Whiteboard load failed", e);
      }
      qc.invalidateQueries({ queryKey: ["wb-comments", boardId] });
    });

    // Live.
    const live = supabase.channel(`wb:${boardId}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: S().sid } },
    });
    channel = live;
    live
      .on("broadcast", { event: "m" }, ({ payload }) => onMessage(payload as Msg & { sid?: string }))
      .on("broadcast", { event: "summon" }, ({ payload }) => {
        const p = payload as { sid?: string; v?: { cx: number; cy: number; zoom: number } };
        const from = p.sid ? S().peers[p.sid] : undefined;
        if (from && p.v) for (const fn of summonListeners) fn(from, p.v);
      })
      .on("presence", { event: "sync" }, () => {
        const state = live.presenceState<PresenceMeta>();
        const s = S();
        const peers: Record<string, Peer> = {};
        for (const [sid, metas] of Object.entries(state)) {
          if (sid === s.sid) continue;
          const m = metas[0];
          if (!m) continue;
          peers[sid] = s.peers[sid] ?? { sid, uid: m.uid, name: m.name, avatar: m.avatar, color: peerColor(m.uid), t: Date.now() };
        }
        set({ peers, following: s.following && peers[s.following] ? s.following : null });
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") await live.track({ uid: me.id, name: me.name, avatar: me.avatar } satisfies PresenceMeta);
      });

    // Drop stale remote drags (a peer that vanished mid-drag).
    const sweep = setInterval(() => {
      const s = S();
      const now = Date.now();
      const stale = Object.entries(s.remoteLive).filter(([, l]) => now - l.t > 3000);
      if (stale.length) {
        const rl = { ...s.remoteLive };
        for (const [id] of stale) delete rl[id];
        set({ remoteLive: rl });
      }
    }, 1000);

    const onLeave = (e: BeforeUnloadEvent) => {
      const st = S();
      if (Object.keys(st.dirty).length || Object.keys(st.inflight).length) {
        flushNow();
        e.preventDefault();
      }
    };
    const onOnline = () => schedule(0);
    window.addEventListener("beforeunload", onLeave);
    window.addEventListener("online", onOnline);

    return () => {
      alive = false;
      flushNow();
      saveSnap();
      unsubSnap();
      unsubSent();
      document.removeEventListener("visibilitychange", onHide);
      clearInterval(sweep);
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("online", onOnline);
      setDirtyListener(null);
      supabase.removeChannel(rows);
      void live.untrack().catch(() => undefined);
      supabase.removeChannel(live);
      if (channel === live) channel = null;
    };
  }, [boardId, me?.id, me?.name, me?.avatar, qc]);
}

/** Broadcast my selection / editing whenever they change. */
export function useBroadcastSelection() {
  useEffect(
    () =>
      useWb.subscribe((s, prev) => {
        if (s.selection !== prev.selection) broadcast({ s: s.selection.slice(0, 200) });
        if (s.editing?.id !== prev.editing?.id) broadcast({ e: s.editing?.id ?? null });
        if (s.viewport !== prev.viewport) {
          const cx = (s.screen.w / 2 - s.viewport.x) / s.viewport.zoom;
          const cy = (s.screen.h / 2 - s.viewport.y) / s.viewport.zoom;
          broadcast({ v: { cx: Math.round(cx), cy: Math.round(cy), zoom: Math.round(s.viewport.zoom * 1000) / 1000 } });
        }
        if (s.live !== prev.live) {
          const l: Msg["l"] = {};
          for (const id of Object.keys(s.live)) {
            const g = geomOf(s, id);
            if (g) l[id] = { x: Math.round(g.x * 10) / 10, y: Math.round(g.y * 10) / 10, w: Math.round(g.w * 10) / 10, h: Math.round(g.h * 10) / 10, rotation: g.rotation };
          }
          if (Object.keys(l).length) broadcast({ l });
        }
      }),
    [],
  );
}
