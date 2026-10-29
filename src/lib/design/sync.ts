import { useEffect } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { DesignDoc, DNode, DocData } from "./types";
import {
  ackFlush,
  applyRemote,
  applyRemoteData,
  applyRemoteDelete,
  loadDesign,
  peerColor,
  resyncDesign,
  setDirtyListener,
  takeFlush,
  useDesign,
  type Peer,
} from "./store";

// -----------------------------------------------------------------------------
// Design mode sync (same shape as the whiteboard's, lib/wb/sync.ts).
//  - Saves: changed layers go out in one design_save() call at a time. A save
//    that can't reach the server is retried with backoff (changes stay on
//    screen); one the server refuses is dropped and server truth reloaded.
//  - Rows: postgres_changes on design_node / design_doc keep tabs in step.
//  - Live: the board's private channel "wb:<board>" (whiteboard mode isn't
//    mounted meanwhile) carries cursors and selections; presence lists people.
// -----------------------------------------------------------------------------

const S = useDesign.getState;
const set = useDesign.setState;

export interface NodeRow {
  id: string;
  board_id?: string;
  page: string;
  parent_id: string | null;
  ord: number;
  data: Record<string, unknown>;
  sid?: string | null;
}

export function toRow(n: DNode): NodeRow {
  const { id, page, parent, order, ...rest } = n;
  return { id, page, parent_id: parent, ord: order, data: JSON.parse(JSON.stringify(rest)) as Record<string, unknown> };
}

export function fromRow(r: NodeRow): DNode {
  const d = r.data as Partial<DNode>;
  return {
    type: "rect",
    name: "Layer",
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    rotation: 0,
    visible: true,
    locked: false,
    opacity: 1,
    fills: [],
    strokes: [],
    ...d,
    id: r.id,
    page: r.page,
    parent: r.parent_id,
    order: r.ord,
  } as DNode;
}

export async function fetchDesign(boardId: string): Promise<{ data: DocData | null; nodes: DNode[] }> {
  const docQ = await supabase.from("design_doc").select("data").eq("board_id", boardId).maybeSingle();
  if (docQ.error) throw docQ.error;
  const nodes: DNode[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("design_node")
      .select("id, page, parent_id, ord, data")
      .eq("board_id", boardId)
      .order("ord")
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    for (const r of (data ?? []) as NodeRow[]) nodes.push(fromRow(r));
    if (!data || data.length < 1000) break;
  }
  return { data: (docQ.data?.data as DocData | undefined) ?? null, nodes };
}

/** Whole document as of now (exports, versions). */
export function currentDoc(): DesignDoc {
  return S().doc;
}

// ----------------------------------------------------------------- saving --
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
let failures = 0;

function schedule(ms = 250) {
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
  if (!s.boardId || !s.loaded) return;
  const f = takeFlush();
  if (!f) {
    if (!Object.keys(S().dirty).length && !Object.keys(S().inflight).length) set({ saveState: "saved" });
    return;
  }
  busy = true;
  set({ saveState: "saving" });
  const { error } = await supabase.rpc("design_save", {
    p_board: s.boardId,
    p_put: f.put.map(toRow),
    p_delete: f.del,
    p_doc: f.data,
    p_sid: s.sid,
  });
  busy = false;
  if (!error) {
    failures = 0;
    ackFlush(f, "ok");
    if (Object.keys(S().dirty).length || S().dirtyData) schedule(60);
    else set({ saveState: "saved" });
    return;
  }
  const unreachable = !navigator.onLine || RETRYABLE.test(`${error.message} ${(error as { details?: string }).details ?? ""}`);
  if (unreachable || failures < 3) {
    failures++;
    ackFlush(f, "retry");
    set({ saveState: unreachable ? "retrying" : "saving" });
    schedule(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
    return;
  }
  console.error("Design save failed", error);
  failures = 0;
  ackFlush(f, "drop");
  set({ saveState: "error" });
  try {
    const fresh = await fetchDesign(s.boardId);
    if (S().boardId === s.boardId) resyncDesign(fresh.data, fresh.nodes);
  } catch {
    /* the next reconnect re-syncs */
  }
}

export function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  void flush();
}

// --------------------------------------------------------------- realtime --
interface Msg {
  c?: { x: number; y: number; page: string } | null;
  s?: string[];
  p?: string;
}

let channel: RealtimeChannel | null = null;
let outbox: Msg = {};
let sendTimer: ReturnType<typeof setTimeout> | null = null;
let lastSent = 0;

export function broadcast(msg: Msg) {
  if ("c" in msg) outbox.c = msg.c;
  if (msg.s) outbox.s = msg.s;
  if (msg.p) outbox.p = msg.p;
  if (sendTimer) return;
  const wait = Math.max(0, 100 - (performance.now() - lastSent));
  sendTimer = setTimeout(() => {
    sendTimer = null;
    lastSent = performance.now();
    const m = outbox;
    outbox = {};
    if (channel && Object.keys(m).length) void channel.send({ type: "broadcast", event: "dz", payload: { sid: S().sid, ...m } });
  }, wait);
}

function onMessage(p: Msg & { sid?: string }) {
  if (!p.sid || p.sid === S().sid) return;
  const peer = S().peers[p.sid];
  if (!peer) return;
  const next: Peer = { ...peer, t: Date.now() };
  if ("c" in p) next.cursor = p.c ?? null;
  if (p.s) next.sel = p.s;
  if (p.p) next.page = p.p;
  set({ peers: { ...S().peers, [p.sid]: next } });
}

interface PresenceMeta {
  uid: string;
  name: string;
  avatar: string | null;
  mode?: string;
}

/** Wires the open design document: load, row changes, live channel, saving. */
export function useDesignSync(
  boardId: string | undefined,
  me: { id: string; name: string; avatar: string | null } | null,
  onError: (e: Error) => void,
  onComments: () => void,
) {
  useEffect(() => {
    if (!boardId || !me) return;
    let alive = true;
    setDirtyListener(() => schedule());

    const rows = supabase.channel(`design-rows:${boardId}:${Math.random().toString(36).slice(2, 8)}`);
    rows
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "design_node", filter: `board_id=eq.${boardId}` }, (p) => {
        const r = p.new as NodeRow;
        if (r.sid !== S().sid) applyRemote(fromRow(r));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "design_node", filter: `board_id=eq.${boardId}` }, (p) => {
        const r = p.new as NodeRow;
        if (r.sid !== S().sid) applyRemote(fromRow(r));
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "design_node" }, (p) => {
        const id = (p.old as { id?: string })?.id;
        if (id) applyRemoteDelete(id);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "design_doc", filter: `board_id=eq.${boardId}` }, (p) => {
        const r = p.new as { data?: DocData; sid?: string | null };
        if (r?.data && r.sid !== S().sid) applyRemoteData(r.data);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "design_comment", filter: `board_id=eq.${boardId}` }, () => onComments())
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "design_comment" }, () => onComments());

    rows.subscribe(async (status) => {
      if (status !== "SUBSCRIBED" || !alive) return;
      try {
        const d = await fetchDesign(boardId);
        if (!alive) return;
        if (!S().loaded) loadDesign(d.data, d.nodes);
        else resyncDesign(d.data, d.nodes);
      } catch (e) {
        console.error("Design load failed", e);
        onError(e as Error);
      }
    });

    const live = supabase.channel(`wb:${boardId}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: S().sid } },
    });
    channel = live;
    live
      .on("broadcast", { event: "dz" }, ({ payload }) => onMessage(payload as Msg & { sid?: string }))
      .on("presence", { event: "sync" }, () => {
        const state = live.presenceState<PresenceMeta>();
        const s = S();
        const peers: Record<string, Peer> = {};
        for (const [sid, metas] of Object.entries(state)) {
          if (sid === s.sid) continue;
          const m = metas[0];
          if (!m || m.mode !== "design") continue;
          peers[sid] = s.peers[sid] ?? { sid, uid: m.uid, name: m.name, avatar: m.avatar, color: peerColor(m.uid), t: Date.now() };
        }
        set({ peers });
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") await live.track({ uid: me.id, name: me.name, avatar: me.avatar, mode: "design" } satisfies PresenceMeta);
      });

    const unsub = useDesign.subscribe((s, p) => {
      if (s.selection !== p.selection) broadcast({ s: s.selection.slice(0, 200) });
      if (s.page !== p.page) broadcast({ p: s.page });
    });

    const onLeave = (e: BeforeUnloadEvent) => {
      const st = S();
      if (Object.keys(st.dirty).length || Object.keys(st.inflight).length || st.dirtyData) {
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
      unsub();
      window.removeEventListener("beforeunload", onLeave);
      window.removeEventListener("online", onOnline);
      setDirtyListener(null);
      supabase.removeChannel(rows);
      void live.untrack().catch(() => undefined);
      supabase.removeChannel(live);
      if (channel === live) channel = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId, me?.id, me?.name, me?.avatar]);
}

// --------------------------------------------------------------- versions --
export interface DesignVersion {
  id: string;
  label: string | null;
  auto: boolean;
  node_count: number;
  created_by: string | null;
  created_at: string;
  profile?: { display_name: string } | null;
}

export async function fetchVersions(boardId: string): Promise<DesignVersion[]> {
  const { data, error } = await supabase
    .from("design_version")
    .select("id, label, auto, node_count, created_by, created_at, profile:created_by(display_name)")
    .eq("board_id", boardId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as DesignVersion[];
}

export async function saveVersion(boardId: string, label: string | null) {
  // Pending edits first, so the version has them.
  flushNow();
  await waitSaved();
  const { data, error } = await supabase.rpc("design_snapshot", { p_board: boardId, p_label: label, p_auto: false });
  if (error) throw error;
  return data as string;
}

export async function restoreVersion(boardId: string, id: string) {
  flushNow();
  await waitSaved();
  const { error } = await supabase.rpc("design_restore", { p_version: id });
  if (error) throw error;
  const fresh = await fetchDesign(boardId);
  set({ dirty: {}, dirtyData: false, past: [], future: [], selection: [] });
  resyncDesign(fresh.data, fresh.nodes);
}

async function waitSaved(maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const s = S();
    if (!Object.keys(s.dirty).length && !Object.keys(s.inflight).length && !s.dirtyData && !s.inflightData) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("Changes are still saving. Try again in a moment.");
}

// --------------------------------------------------------------- comments --
export interface DesignComment {
  id: string;
  board_id: string;
  thread_id: string | null;
  page: string | null;
  node_id: string | null;
  x: number | null;
  y: number | null;
  author_id: string;
  body: string;
  resolved: boolean;
  created_at: string;
  updated_at: string;
  author?: { display_name: string; avatar_url: string | null; username: string | null } | null;
}

export async function fetchDesignComments(boardId: string): Promise<DesignComment[]> {
  const { data, error } = await supabase
    .from("design_comment")
    .select("*, author:author_id(display_name, avatar_url, username)")
    .eq("board_id", boardId)
    .order("created_at");
  if (error) throw error;
  return (data ?? []) as unknown as DesignComment[];
}

export async function addDesignComment(input: { board_id: string; body: string; thread_id?: string | null; page?: string; node_id?: string | null; x?: number; y?: number; author_id: string }) {
  const { error } = await supabase.from("design_comment").insert(input);
  if (error) throw error;
}

export async function updateDesignComment(id: string, patch: Partial<Pick<DesignComment, "body" | "resolved">>) {
  const { error } = await supabase.from("design_comment").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteDesignComment(id: string) {
  const { error } = await supabase.from("design_comment").delete().eq("id", id);
  if (error) throw error;
}
