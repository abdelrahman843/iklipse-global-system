import { create } from "zustand";
import {
  ITEM_COLS,
  MAX_ZOOM,
  MIN_ZOOM,
  DEFAULT_STICKY,
  type Cap,
  type ConnectorData,
  type ConnectorKind,
  type Geom,
  type ShapeKind,
  type Tool,
  type Viewport,
  type WbItem,
} from "./types";
import { connectorGeometry, geomBounds, unionRects, type Guide, type Pt, type Rect } from "./geometry";

// -----------------------------------------------------------------------------
// Whiteboard client state (one board at a time).
//
//   server    last row seen from the database for each item
//   items     what the canvas shows: server + this tab's unsaved changes
//   dirty     changes waiting for the next flush (sync.ts sends them)
//   inflight  changes sent, not yet acknowledged
//   live      geometry of an in-progress drag / resize (never saved per frame)
//   remoteLive  other people's in-progress drags (broadcast), until their save lands
//
// A row arriving from realtime replaces the server copy; any field this tab
// still has pending is laid back on top, so nobody's newer edit is lost.
// -----------------------------------------------------------------------------

export type DirtyMode = "put" | "patch" | "del";
export interface Dirty {
  mode: DirtyMode;
  cols: string[];
  keys: string[];
}

export interface Live {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  data?: Record<string, unknown>;
}

interface HistoryEntry {
  before: Record<string, WbItem | null>;
  after: Record<string, WbItem | null>;
  key?: string;
  t: number;
}

export interface Peer {
  sid: string;
  uid: string;
  name: string;
  avatar: string | null;
  color: string;
  cursor?: Pt | null;
  sel?: string[];
  editing?: string | null;
  view?: { cx: number; cy: number; zoom: number };
  t: number;
}

export interface ToolOpts {
  stickyColor: string;
  shape: ShapeKind;
  connectorKind: ConnectorKind;
  endCap: Cap;
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  emoji: string;
  frame: { w: number; h: number };
}

export type Panel = null | "comments" | "frames" | "templates" | "voting" | "search";
export type SaveState = "saved" | "saving" | "offline" | "error";

export interface WbState {
  boardId: string | null;
  me: string | null;
  sid: string;
  canEdit: boolean;
  canComment: boolean;
  loaded: boolean;
  server: Record<string, WbItem>;
  items: Record<string, WbItem>;
  dirty: Record<string, Dirty>;
  inflight: Record<string, Dirty>;
  live: Record<string, Live>;
  remoteLive: Record<string, Live & { t: number }>;
  selection: string[];
  editing: { id: string; field: "text" | "title" | "label" } | null;
  hover: string | null;
  tool: Tool;
  toolOpts: ToolOpts;
  viewport: Viewport;
  screen: { w: number; h: number };
  past: HistoryEntry[];
  future: HistoryEntry[];
  guides: Guide[];
  marquee: Rect | null;
  peers: Record<string, Peer>;
  saveState: SaveState;
  following: string | null;
  panel: Panel;
  presenting: boolean;
  showGrid: boolean;
  showMinimap: boolean;
  /** Pending comment placement (comment tool click). */
  draftComment: { x: number; y: number; item_id: string | null } | null;
  openThread: string | null;
}

const TOOL_KEY = "wb-tool-opts";
function readToolOpts(): ToolOpts {
  const d: ToolOpts = {
    stickyColor: DEFAULT_STICKY,
    shape: "rect",
    connectorKind: "curved",
    endCap: "arrow",
    penColor: "ink",
    penWidth: 3,
    highlighterColor: "#f5cd47",
    emoji: "👍",
    frame: { w: 1280, h: 720 },
  };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(TOOL_KEY) ?? "{}") as Partial<ToolOpts>) };
  } catch {
    return d;
  }
}

const initial = (): Omit<WbState, "sid" | "toolOpts" | "showGrid" | "showMinimap"> => ({
  boardId: null,
  me: null,
  canEdit: false,
  canComment: false,
  loaded: false,
  server: {},
  items: {},
  dirty: {},
  inflight: {},
  live: {},
  remoteLive: {},
  selection: [],
  editing: null,
  hover: null,
  tool: "select",
  viewport: { x: 0, y: 0, zoom: 1 },
  screen: { w: 1, h: 1 },
  past: [],
  future: [],
  guides: [],
  marquee: null,
  peers: {},
  saveState: "saved",
  following: null,
  panel: null,
  presenting: false,
  draftComment: null,
  openThread: null,
});

export const useWb = create<WbState>()(() => ({
  ...initial(),
  sid: crypto.randomUUID().slice(0, 18),
  toolOpts: readToolOpts(),
  showGrid: true,
  showMinimap: false,
}));

const S = useWb.getState;
const set = useWb.setState;

let onDirty: (() => void) | null = null;
/** sync.ts registers its flush scheduler here. */
export function setDirtyListener(fn: (() => void) | null) {
  onDirty = fn;
}

export function resetBoard(boardId: string, me: string, canEdit: boolean, canComment: boolean) {
  set({ ...initial(), boardId, me, canEdit, canComment });
}

export function setToolOpts(patch: Partial<ToolOpts>) {
  const toolOpts = { ...S().toolOpts, ...patch };
  set({ toolOpts });
  try {
    localStorage.setItem(TOOL_KEY, JSON.stringify(toolOpts));
  } catch {
    /* storage blocked */
  }
}

export function setTool(tool: Tool) {
  set({ tool, editing: tool === "select" ? S().editing : null, draftComment: null });
}

// --------------------------------------------------------------- loading --
export function loadItems(rows: WbItem[]) {
  const server: Record<string, WbItem> = {};
  for (const r of rows) server[r.id] = normalize(r);
  set({ server, items: { ...server }, loaded: true, dirty: {}, inflight: {}, past: [], future: [] });
}

/** Re-sync after a reconnect: server truth, with this tab's pending edits on top. */
export function resyncItems(rows: WbItem[]) {
  const seen = new Set<string>();
  for (const r of rows) {
    seen.add(r.id);
    applyRemote(r);
  }
  for (const id of Object.keys(S().server)) if (!seen.has(id)) applyRemoteDelete(id);
}

function normalize(r: WbItem): WbItem {
  return {
    ...r,
    x: Number(r.x),
    y: Number(r.y),
    w: Number(r.w),
    h: Number(r.h),
    rotation: Number(r.rotation) || 0,
    z: Number(r.z) || 0,
    data: r.data && typeof r.data === "object" ? r.data : {},
  };
}

const jsonEq = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function omit<T>(o: Record<string, T>, id: string): Record<string, T> {
  if (!(id in o)) return o;
  const n = { ...o };
  delete n[id];
  return n;
}

// ---------------------------------------------------------------- remote --
export function applyRemote(raw: WbItem) {
  const s = S();
  if (!s.boardId || raw.board_id !== s.boardId) return;
  const row = normalize(raw);
  const server = { ...s.server, [row.id]: row };
  const dirty = s.dirty[row.id];
  const inflight = s.inflight[row.id];
  const newest = dirty ?? inflight;
  const local = s.items[row.id];
  let next: WbItem | null = row;
  if (newest?.mode === "del") next = null;
  else if (dirty?.mode === "put" || inflight?.mode === "put") next = local ?? row;
  else if (local && (dirty || inflight)) {
    next = { ...row, data: { ...row.data } };
    for (const d of [inflight, dirty]) {
      if (!d) continue;
      for (const c of d.cols) (next as unknown as Record<string, unknown>)[c] = (local as unknown as Record<string, unknown>)[c];
      for (const k of d.keys) {
        if (k in local.data) next.data[k] = local.data[k];
        else delete next.data[k];
      }
    }
  }
  const items = { ...s.items };
  if (next) items[row.id] = next;
  else delete items[row.id];
  set({ server, items, remoteLive: omit(s.remoteLive, row.id) });
}

export function applyRemoteDelete(id: string) {
  const s = S();
  if (!s.server[id] && !s.items[id]) return;
  const server = omit(s.server, id);
  const newest = s.dirty[id] ?? s.inflight[id];
  if (newest?.mode === "put") {
    set({ server });
    return;
  }
  set({
    server,
    items: omit(s.items, id),
    dirty: omit(s.dirty, id),
    remoteLive: omit(s.remoteLive, id),
    selection: s.selection.filter((x) => x !== id),
    editing: s.editing?.id === id ? null : s.editing,
  });
}

// ---------------------------------------------------------------- commit --
export interface CommitOpts {
  /** false = not undoable (undo/redo themselves, remote-driven fixes). */
  history?: boolean;
  /** Consecutive commits with the same key merge into one undo step. */
  key?: string;
  /** Select these ids afterwards. */
  select?: string[];
}

/** Apply local changes (null = delete). The only way the canvas is edited. */
export function commit(changes: Record<string, WbItem | null>, opts: CommitOpts = {}) {
  const s = S();
  if (!s.canEdit) return;
  const items = { ...s.items };
  const dirty = { ...s.dirty };
  const before: Record<string, WbItem | null> = {};
  const after: Record<string, WbItem | null> = {};
  let any = false;
  for (const [id, next] of Object.entries(changes)) {
    const prev = items[id] ?? null;
    if (prev === next || (!prev && !next)) continue;
    any = true;
    before[id] = prev;
    after[id] = next;
    if (!next) {
      delete items[id];
      const d = dirty[id];
      if (d?.mode === "put" && !s.server[id] && !s.inflight[id]) delete dirty[id];
      else dirty[id] = { mode: "del", cols: [], keys: [] };
    } else if (!prev) {
      items[id] = next;
      dirty[id] = { mode: "put", cols: [], keys: [] };
    } else {
      items[id] = next;
      const old = dirty[id];
      const d: Dirty = old ? { mode: old.mode, cols: [...old.cols], keys: [...old.keys] } : { mode: "patch", cols: [], keys: [] };
      if (d.mode === "del") d.mode = "put";
      if (d.mode === "patch") {
        if (prev.type !== next.type) d.mode = "put";
        for (const c of ITEM_COLS) if (prev[c] !== next[c] && !d.cols.includes(c)) d.cols.push(c);
        if (prev.data !== next.data) {
          for (const k of new Set([...Object.keys(prev.data), ...Object.keys(next.data)])) {
            if (!jsonEq(prev.data[k], next.data[k]) && !d.keys.includes(k)) d.keys.push(k);
          }
        }
      }
      dirty[id] = d;
    }
  }
  if (!any) {
    if (opts.select) set({ selection: opts.select });
    return;
  }
  let past = s.past;
  let future = s.future;
  if (opts.history !== false) {
    const last = past[past.length - 1];
    const now = Date.now();
    if (opts.key && last && last.key === opts.key && now - last.t < 1500) {
      past = [...past.slice(0, -1), { before: { ...before, ...last.before }, after: { ...last.after, ...after }, key: opts.key, t: now }];
    } else {
      past = [...past.slice(-199), { before, after, key: opts.key, t: now }];
    }
    future = [];
  }
  const selection = (opts.select ?? s.selection).filter((id) => items[id]);
  set({
    items,
    dirty,
    past,
    future,
    selection,
    editing: s.editing && items[s.editing.id] ? s.editing : null,
  });
  onDirty?.();
}

/** Patch one item's columns / data keys (undefined data values remove the key). */
export function patchItem(id: string, patch: Partial<WbItem> & { data?: Record<string, unknown> }, opts?: CommitOpts) {
  const it = S().items[id];
  if (!it) return;
  commit({ [id]: mergeItem(it, patch) }, opts);
}

export function patchItems(ids: string[], fn: (it: WbItem) => Partial<WbItem> & { data?: Record<string, unknown> }, opts?: CommitOpts) {
  const s = S();
  const changes: Record<string, WbItem> = {};
  for (const id of ids) {
    const it = s.items[id];
    if (it) changes[id] = mergeItem(it, fn(it));
  }
  commit(changes, opts);
}

export function mergeItem(it: WbItem, patch: Partial<WbItem> & { data?: Record<string, unknown> }): WbItem {
  const { data, ...cols } = patch;
  const next: WbItem = { ...it, ...cols };
  if (data) {
    const d = { ...it.data };
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) delete d[k];
      else d[k] = v;
    }
    next.data = d;
  }
  return next;
}

export function deleteItems(ids: string[]) {
  const s = S();
  const all = new Set(ids);
  // Frames take their content with them; connectors stuck to removed items go too.
  for (const id of ids) {
    if (s.items[id]?.type === "frame") for (const it of Object.values(s.items)) if (it.frame_id === id) all.add(it.id);
  }
  for (const it of Object.values(s.items)) {
    if (it.type !== "connector") continue;
    const st = (it.data.start as { id?: string } | undefined)?.id;
    const en = (it.data.end as { id?: string } | undefined)?.id;
    if ((st && all.has(st)) || (en && all.has(en))) all.add(it.id);
  }
  const changes: Record<string, null> = {};
  for (const id of all) if (s.items[id] && !s.items[id]!.locked) changes[id] = null;
  commit(changes, { select: [] });
}

export function undo() {
  const s = S();
  const e = s.past[s.past.length - 1];
  if (!e || !s.canEdit) return;
  set({ past: s.past.slice(0, -1), future: [...s.future, e] });
  commit(e.before, { history: false, select: Object.keys(e.before).filter((id) => e.before[id]) });
}

export function redo() {
  const s = S();
  const e = s.future[s.future.length - 1];
  if (!e || !s.canEdit) return;
  set({ future: s.future.slice(0, -1), past: [...s.past, e] });
  commit(e.after, { history: false, select: Object.keys(e.after).filter((id) => e.after[id]) });
}

// ----------------------------------------------------------------- flush --
export interface FlushPayload {
  put: Record<string, unknown>[];
  patch: Record<string, unknown>[];
  del: string[];
}

function rowOut(it: WbItem) {
  return {
    id: it.id,
    type: it.type,
    x: it.x,
    y: it.y,
    w: it.w,
    h: it.h,
    rotation: it.rotation,
    z: it.z,
    frame_id: it.frame_id,
    group_id: it.group_id,
    locked: it.locked,
    data: it.data,
  };
}

/** Move pending changes to in-flight and build the wb_save payload (one flush at a time). */
export function takeFlush(): FlushPayload | null {
  const s = S();
  if (Object.keys(s.inflight).length) return null;
  const ids = Object.keys(s.dirty);
  if (!ids.length) return null;
  const out: FlushPayload = { put: [], patch: [], del: [] };
  for (const id of ids) {
    const d = s.dirty[id]!;
    const it = s.items[id];
    if (d.mode === "del") {
      out.del.push(id);
      continue;
    }
    if (!it) continue;
    if (d.mode === "put") {
      out.put.push(rowOut(it));
      continue;
    }
    const p: Record<string, unknown> = { id };
    for (const c of d.cols) p[c] = (it as unknown as Record<string, unknown>)[c];
    if (d.keys.length) {
      const data: Record<string, unknown> = {};
      for (const k of d.keys) data[k] = k in it.data ? it.data[k] : null;
      p.data = data;
    }
    out.patch.push(p);
  }
  set({ inflight: s.dirty, dirty: {} });
  return out;
}

function mergeDirty(older: Dirty, newer: Dirty): Dirty {
  if (newer.mode === "del") return newer;
  if (newer.mode === "put" || older.mode === "put") return { mode: "put", cols: [], keys: [] };
  return {
    mode: "patch",
    cols: [...new Set([...older.cols, ...newer.cols])],
    keys: [...new Set([...older.keys, ...newer.keys])],
  };
}

/** ok: saved. retry: put the changes back for the next attempt. Otherwise they're dropped. */
export function ackFlush(result: "ok" | "retry" | "drop") {
  const s = S();
  if (result === "ok" || result === "drop") {
    set({ inflight: {} });
    return;
  }
  const dirty = { ...s.dirty };
  for (const [id, d] of Object.entries(s.inflight)) dirty[id] = dirty[id] ? mergeDirty(d, dirty[id]!) : d;
  set({ inflight: {}, dirty });
}

export const hasPending = () => Object.keys(S().dirty).length + Object.keys(S().inflight).length > 0;

// -------------------------------------------------------------- geometry --
/** Current geometry of an item including any in-progress drag. */
export function geomOf(s: WbState, id: string): Geom | null {
  const it = s.items[id];
  if (!it) return null;
  const l = s.live[id] ?? s.remoteLive[id];
  if (!l) return it;
  return { x: l.x ?? it.x, y: l.y ?? it.y, w: l.w ?? it.w, h: l.h ?? it.h, rotation: l.rotation ?? it.rotation };
}

/** Screen-independent box of an item (connectors: their drawn path). */
export function boundsOf(s: WbState, id: string): Rect | null {
  const it = s.items[id];
  if (!it) return null;
  if (it.type === "connector") {
    const l = s.live[id];
    const data = (l?.data ? { ...it.data, ...l.data } : it.data) as ConnectorData;
    return connectorGeometry(data, (x) => geomOf(s, x)).bounds;
  }
  const g = geomOf(s, id);
  return g ? geomBounds(g) : null;
}

export function selectionBounds(s: WbState, ids = s.selection): Rect | null {
  return unionRects(ids.map((id) => boundsOf(s, id)).filter((r): r is Rect => !!r));
}

export function maxZ(s: WbState = S()) {
  let z = 0;
  for (const it of Object.values(s.items)) if (it.z > z) z = it.z;
  return z;
}

export function minZ(s: WbState = S()) {
  let z = 0;
  for (const it of Object.values(s.items)) if (it.z < z) z = it.z;
  return z;
}

/** Selection grown to whole groups. */
export function withGroups(ids: string[], s: WbState = S()): string[] {
  const groups = new Set(ids.map((id) => s.items[id]?.group_id).filter(Boolean) as string[]);
  if (!groups.size) return ids;
  const out = new Set(ids);
  for (const it of Object.values(s.items)) if (it.group_id && groups.has(it.group_id)) out.add(it.id);
  return [...out];
}

export function select(ids: string[]) {
  set({ selection: withGroups(ids), editing: null });
}

// -------------------------------------------------------------- viewport --
export const screenToWorld = (p: Pt, vp: Viewport = S().viewport): Pt => ({ x: (p.x - vp.x) / vp.zoom, y: (p.y - vp.y) / vp.zoom });
export const worldToScreen = (p: Pt, vp: Viewport = S().viewport): Pt => ({ x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y });

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function setViewport(vp: Viewport) {
  set({ viewport: { x: vp.x, y: vp.y, zoom: clampZoom(vp.zoom) } });
}

export function zoomAt(screenPt: Pt, zoom: number) {
  const vp = S().viewport;
  const z = clampZoom(zoom);
  const w = screenToWorld(screenPt, vp);
  setViewport({ zoom: z, x: screenPt.x - w.x * z, y: screenPt.y - w.y * z });
}

export function viewportFor(r: Rect, pad = 80, maxZoom = 1): Viewport {
  const { w, h } = S().screen;
  const zoom = clampZoom(Math.min((w - pad * 2) / Math.max(r.w, 1), (h - pad * 2) / Math.max(r.h, 1), maxZoom));
  return { zoom, x: w / 2 - (r.x + r.w / 2) * zoom, y: h / 2 - (r.y + r.h / 2) * zoom };
}

let anim = 0;
export function animateViewport(to: Viewport, ms = 320) {
  const from = S().viewport;
  const start = performance.now();
  const id = ++anim;
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    if (id !== anim) return;
    const t = Math.min(1, (now - start) / ms);
    const k = ease(t);
    // Interpolate zoom in log space so zooming feels even.
    const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * k);
    const cx0 = (S().screen.w / 2 - from.x) / from.zoom;
    const cy0 = (S().screen.h / 2 - from.y) / from.zoom;
    const cx1 = (S().screen.w / 2 - to.x) / to.zoom;
    const cy1 = (S().screen.h / 2 - to.y) / to.zoom;
    const cx = cx0 + (cx1 - cx0) * k;
    const cy = cy0 + (cy1 - cy0) * k;
    setViewport({ zoom, x: S().screen.w / 2 - cx * zoom, y: S().screen.h / 2 - cy * zoom });
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
export const stopViewportAnimation = () => {
  anim++;
};

export function zoomToFit(ids?: string[]) {
  const s = S();
  const r = ids?.length ? selectionBounds(s, ids) : contentBounds(s);
  if (!r) {
    animateViewport({ zoom: 1, x: s.screen.w / 2, y: s.screen.h / 2 });
    return;
  }
  animateViewport(viewportFor(r, 80, ids?.length ? 2 : 1));
}

export function contentBounds(s: WbState = S()): Rect | null {
  return unionRects(Object.keys(s.items).map((id) => boundsOf(s, id)).filter((r): r is Rect => !!r));
}

/** World point at the middle of the screen. */
export function viewCenter(s: WbState = S()): Pt {
  return screenToWorld({ x: s.screen.w / 2, y: s.screen.h / 2 }, s.viewport);
}

// ----------------------------------------------------------------- peers --
const PEER_COLORS = ["#579dff", "#4bce97", "#f87168", "#9f8fef", "#fea362", "#6cc3e0", "#e774bb", "#94c748", "#f5cd47", "#0055cc"];
export function peerColor(key: string) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length]!;
}

export const newId = () => crypto.randomUUID();
