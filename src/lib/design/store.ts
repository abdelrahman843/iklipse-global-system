import { create } from "zustand";
import { emptyData, isVirtual, type Draft } from "./doc";
import { childIndex, indexResolved, resolvePage, type RNode } from "./layout";
import type { DesignDoc, DNode, DocData, Override, OverrideKey } from "./types";
import { OVERRIDABLE } from "./types";

// -----------------------------------------------------------------------------
// Design mode editor state. Every change is a transaction (tx): it records
// the layers before and after, so undo / redo replay exactly, and marks them
// dirty for sync.ts to save. Drags and resizes are gestures: they change the
// document live without history, and land as one transaction at the end.
// -----------------------------------------------------------------------------

export type Tool =
  | "select"
  | "hand"
  | "frame"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "pen"
  | "text"
  | "image"
  | "comment";

export interface Peer {
  sid: string;
  uid: string;
  name: string;
  avatar: string | null;
  color: string;
  cursor?: { x: number; y: number; page: string } | null;
  sel?: string[];
  page?: string;
  t: number;
}

interface Tx {
  label: string;
  before: Record<string, DNode | null>;
  after: Record<string, DNode | null>;
  dataBefore?: DocData;
  dataAfter?: DocData;
  selBefore: string[];
  selAfter: string[];
  page: string;
  /** When it happened: quick repeats of the same edit merge into one step. */
  t?: number;
}

const MERGE_MS = 800;

export interface DesignState {
  boardId: string | null;
  sid: string;
  loaded: boolean;
  canEdit: boolean;
  canComment: boolean;
  canCopy: boolean;

  doc: DesignDoc;
  page: string;
  selection: string[];
  hover: string | null;
  tool: Tool;
  /** Tool stays on after one use (double-click a tool / hold shift). */
  toolLock: boolean;
  editingText: string | null;
  editingPath: string | null;
  viewport: { x: number; y: number; zoom: number };
  screen: { w: number; h: number };

  past: Tx[];
  future: Tx[];

  /** Layer ids changed since the last save; null value = deleted. */
  dirty: Record<string, true>;
  dirtyData: boolean;
  inflight: Record<string, true>;
  inflightData: boolean;
  saveState: "saved" | "saving" | "retrying" | "error";

  peers: Record<string, Peer>;

  leftTab: "layers" | "assets";
  rightTab: "design" | "prototype" | "inspect";
  showRulers: boolean;
  showGrid: boolean;
  snap: boolean;
  /** Snap guides drawn while dragging (world coords). */
  guides: { x?: number; y?: number; x0?: number; x1?: number; y0?: number; y1?: number }[];
  panel: null | "versions" | "comments" | "export" | "shortcuts";
  playing: boolean;
}

const fresh = (): Omit<DesignState, "sid"> => {
  const data = emptyData();
  return {
    boardId: null,
    loaded: false,
    canEdit: false,
    canComment: false,
    canCopy: true,
    doc: { data, nodes: {} },
    page: data.pages[0]!.id,
    selection: [],
    hover: null,
    tool: "select",
    toolLock: false,
    editingText: null,
    editingPath: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    screen: { w: 0, h: 0 },
    past: [],
    future: [],
    dirty: {},
    dirtyData: false,
    inflight: {},
    inflightData: false,
    saveState: "saved",
    peers: {},
    leftTab: "layers",
    rightTab: "design",
    showRulers: true,
    showGrid: false,
    snap: true,
    guides: [],
    panel: null,
    playing: false,
  };
};

export const useDesign = create<DesignState>(() => ({ ...fresh(), sid: Math.random().toString(36).slice(2, 12) }));
const S = useDesign.getState;
const set = useDesign.setState;

export function resetDesign(boardId: string, canEdit: boolean, canComment: boolean, canCopy: boolean) {
  set({ ...fresh(), boardId, canEdit, canComment, canCopy, sid: Math.random().toString(36).slice(2, 12) });
}

/** First load from the server. */
export function loadDesign(data: DocData | null, nodes: DNode[]) {
  const d = data && data.pages?.length ? normalizeData(data) : emptyData();
  const map: Record<string, DNode> = {};
  for (const n of nodes) map[n.id] = n;
  const page = d.pages.find((p) => p.id === S().page)?.id ?? d.pages[0]!.id;
  // A doc that never existed on the server gets saved with its first page.
  set({ doc: { data: d, nodes: map }, page, loaded: true, dirtyData: !data || !data.pages?.length ? S().canEdit : false });
  if (!data && S().canEdit) dirtyListener?.();
}

export function normalizeData(d: Partial<DocData>): DocData {
  const e = emptyData();
  return {
    pages: d.pages?.length ? d.pages : e.pages,
    colors: d.colors ?? [],
    textStyles: d.textStyles ?? [],
    tokens: d.tokens ?? [],
    library: d.library ?? [],
  };
}

/** Web fonts finished loading: lay text out again (nothing is saved). */
export function refreshText() {
  const s = S();
  set({ doc: { ...s.doc } });
}

// --------------------------------------------------------------- resolving --
let cache: { doc: DesignDoc; page: string; roots: RNode[]; byId: Map<string, RNode>; parentOf: Map<string, RNode | null> } | null = null;

/** The current page, laid out (memoised per document version). */
export function resolved(doc = S().doc, page = S().page) {
  if (cache && cache.doc === doc && cache.page === page) return cache;
  const roots = resolvePage(doc, page, childIndex(doc));
  const { byId, parentOf } = indexResolved(roots);
  cache = { doc, page, roots, byId, parentOf };
  return cache;
}

/** Every page resolved (component lookups across pages). */
export function resolvedAll(doc = S().doc): Map<string, RNode> {
  const out = new Map<string, RNode>();
  const idx = childIndex(doc);
  for (const p of doc.data.pages) {
    const { byId } = indexResolved(resolvePage(doc, p.id, idx));
    for (const [k, v] of byId) out.set(k, v);
  }
  return out;
}

// ------------------------------------------------------------ transactions --
let dirtyListener: (() => void) | null = null;
export function setDirtyListener(fn: (() => void) | null) {
  dirtyListener = fn;
}

class Recorder implements Draft {
  nodes: Record<string, DNode>;
  before: Record<string, DNode | null> = {};
  data: DocData;
  dataBefore?: DocData;
  constructor(public doc: DesignDoc) {
    this.nodes = { ...doc.nodes };
    this.data = doc.data;
    // The draft's doc view follows the edits so helpers see their own changes.
    this.doc = { data: this.data, nodes: this.nodes };
  }
  private touch(id: string) {
    if (!(id in this.before)) this.before[id] = this.nodes[id] ?? null;
  }
  get(id: string) {
    return this.nodes[id];
  }
  put(n: DNode) {
    this.touch(n.id);
    this.nodes[n.id] = n;
  }
  patch(id: string, p: Partial<DNode>) {
    const cur = this.nodes[id];
    if (!cur) return;
    this.touch(id);
    const next = { ...cur, ...p };
    for (const k of Object.keys(p) as (keyof DNode)[]) if (p[k] === undefined) delete next[k];
    this.nodes[id] = next;
  }
  remove(id: string) {
    if (!this.nodes[id]) return;
    this.touch(id);
    delete this.nodes[id];
  }
  setData(fn: (d: DocData) => DocData) {
    if (!this.dataBefore) this.dataBefore = this.data;
    this.data = fn(this.data);
    this.doc = { data: this.data, nodes: this.nodes };
  }
}

/** Run a change as one undoable step. Returns what `fn` returns. */
export function tx<T>(label: string, fn: (d: Draft) => T, opts: { select?: string[] } = {}): T | undefined {
  const s = S();
  if (!s.canEdit) return undefined;
  const r = new Recorder(s.doc);
  const out = fn(r);
  const after: Record<string, DNode | null> = {};
  for (const id of Object.keys(r.before)) after[id] = r.nodes[id] ?? null;
  const changedNodes = Object.keys(r.before).filter((id) => r.before[id] !== after[id]);
  if (!changedNodes.length && !r.dataBefore) return out;
  const selAfter = opts.select ?? s.selection.filter((id) => isVirtual(id) || r.nodes[id]);
  let t: Tx = {
    label,
    before: pick(r.before, changedNodes),
    after: pick(after, changedNodes),
    dataBefore: r.dataBefore,
    dataAfter: r.dataBefore ? r.data : undefined,
    selBefore: s.selection,
    selAfter,
    page: s.page,
    t: Date.now(),
  };
  // Scrubbing a field or holding an arrow key: one undo step.
  const last = s.past[s.past.length - 1];
  const merge = !!last && last.label === label && t.t! - (last.t ?? 0) < MERGE_MS && !s.future.length;
  if (merge) {
    t = {
      ...t,
      before: { ...t.before, ...last.before },
      after: { ...last.after, ...t.after },
      dataBefore: last.dataBefore ?? t.dataBefore,
      dataAfter: t.dataAfter ?? last.dataAfter,
      selBefore: last.selBefore,
    };
  }
  const dirty = { ...s.dirty };
  for (const id of changedNodes) dirty[id] = true;
  set({
    doc: { data: r.data, nodes: r.nodes },
    past: [...(merge ? s.past.slice(-200, -1) : s.past.slice(-199)), t],
    future: [],
    dirty,
    dirtyData: s.dirtyData || !!r.dataBefore,
    selection: selAfter,
  });
  dirtyListener?.();
  return out;
}

function pick<T>(o: Record<string, T>, keys: string[]) {
  const out: Record<string, T> = {};
  for (const k of keys) out[k] = o[k]!;
  return out;
}

function replay(t: Tx, dir: "undo" | "redo") {
  const s = S();
  const nodes = { ...s.doc.nodes };
  const src = dir === "undo" ? t.before : t.after;
  const dirty = { ...s.dirty };
  for (const [id, n] of Object.entries(src)) {
    if (n) nodes[id] = n;
    else delete nodes[id];
    dirty[id] = true;
  }
  const data = dir === "undo" ? (t.dataBefore ?? s.doc.data) : (t.dataAfter ?? s.doc.data);
  const page = data.pages.some((p) => p.id === t.page) ? t.page : s.page;
  set({
    doc: { data, nodes },
    dirty,
    dirtyData: s.dirtyData || !!t.dataBefore,
    selection: (dir === "undo" ? t.selBefore : t.selAfter).filter((id) => isVirtual(id) || nodes[id]),
    page,
    editingText: null,
  });
  dirtyListener?.();
}

export function undo() {
  const s = S();
  const t = s.past[s.past.length - 1];
  if (!t || !s.canEdit) return;
  set({ past: s.past.slice(0, -1), future: [...s.future, t] });
  replay(t, "undo");
}

export function redo() {
  const s = S();
  const t = s.future[s.future.length - 1];
  if (!t || !s.canEdit) return;
  set({ future: s.future.slice(0, -1), past: [...s.past, t] });
  replay(t, "redo");
}

// ---------------------------------------------------------------- gestures --
let gestureStart: DesignDoc | null = null;

/** Start a drag / resize: changes until endGesture() become one undo step. */
export function beginGesture() {
  gestureStart = S().doc;
}

/** Apply a live change during a gesture (no history, not saved yet). */
export function gesture(fn: (d: Draft) => void) {
  const s = S();
  if (!s.canEdit || !gestureStart) return;
  const r = new Recorder(s.doc);
  fn(r);
  if (!Object.keys(r.before).length) return;
  set({ doc: { data: r.data, nodes: r.nodes } });
}

export function endGesture(label: string) {
  const start = gestureStart;
  gestureStart = null;
  if (!start) return;
  const s = S();
  const before: Record<string, DNode | null> = {};
  const after: Record<string, DNode | null> = {};
  for (const id of new Set([...Object.keys(start.nodes), ...Object.keys(s.doc.nodes)])) {
    const a = start.nodes[id] ?? null;
    const b = s.doc.nodes[id] ?? null;
    if (a !== b) {
      before[id] = a;
      after[id] = b;
    }
  }
  const ids = Object.keys(before);
  if (!ids.length) return;
  const dirty = { ...s.dirty };
  for (const id of ids) dirty[id] = true;
  set({
    past: [...s.past.slice(-199), { label, before, after, selBefore: s.selection, selAfter: s.selection, page: s.page }],
    future: [],
    dirty,
  });
  dirtyListener?.();
}

export function cancelGesture() {
  if (!gestureStart) return;
  set({ doc: gestureStart });
  gestureStart = null;
}

export function inGesture() {
  return !!gestureStart;
}

// ----------------------------------------------------------------- remote --
/** A layer row changed on the server (someone else). Local unsaved edits win. */
export function applyRemote(n: DNode) {
  const s = S();
  if (s.dirty[n.id] || s.inflight[n.id] || gestureStart) return;
  if (s.doc.nodes[n.id] && JSON.stringify(s.doc.nodes[n.id]) === JSON.stringify(n)) return;
  set({ doc: { ...s.doc, nodes: { ...s.doc.nodes, [n.id]: n } } });
}

export function applyRemoteDelete(id: string) {
  const s = S();
  if (!s.doc.nodes[id] || s.dirty[id] || s.inflight[id]) return;
  const nodes = { ...s.doc.nodes };
  delete nodes[id];
  set({ doc: { ...s.doc, nodes }, selection: s.selection.filter((x) => x !== id && !x.startsWith(`${id}/`)) });
}

export function applyRemoteData(data: DocData) {
  const s = S();
  if (s.dirtyData || s.inflightData) return;
  const d = normalizeData(data);
  set({ doc: { ...s.doc, data: d }, page: d.pages.some((p) => p.id === s.page) ? s.page : d.pages[0]!.id });
}

/** Server truth after a refused save or a reconnect. */
export function resyncDesign(data: DocData | null, rows: DNode[]) {
  const s = S();
  const nodes: Record<string, DNode> = {};
  for (const n of rows) nodes[n.id] = n;
  // Keep what's still waiting to be saved.
  for (const id of Object.keys(s.dirty)) {
    if (s.doc.nodes[id]) nodes[id] = s.doc.nodes[id]!;
    else delete nodes[id];
  }
  set({ doc: { data: s.dirtyData || !data ? s.doc.data : normalizeData(data), nodes } });
}

// ------------------------------------------------------------------ saving --
export interface Flush {
  put: DNode[];
  del: string[];
  data: DocData | null;
}

export function takeFlush(): Flush | null {
  const s = S();
  const ids = Object.keys(s.dirty);
  if (!ids.length && !s.dirtyData) return null;
  const put: DNode[] = [];
  const del: string[] = [];
  for (const id of ids) {
    const n = s.doc.nodes[id];
    if (n) put.push(n);
    else del.push(id);
  }
  const inflight = { ...s.inflight };
  for (const id of ids) inflight[id] = true;
  set({ dirty: {}, inflight, dirtyData: false, inflightData: s.dirtyData });
  return { put, del, data: s.dirtyData ? s.doc.data : null };
}

export function ackFlush(f: Flush, how: "ok" | "retry" | "drop") {
  const s = S();
  const inflight = { ...s.inflight };
  const dirty = { ...s.dirty };
  for (const id of [...f.put.map((n) => n.id), ...f.del]) {
    delete inflight[id];
    if (how === "retry") dirty[id] = true;
  }
  set({
    inflight,
    dirty,
    inflightData: false,
    dirtyData: s.dirtyData || (how === "retry" && !!f.data),
  });
}

// --------------------------------------------------------------- selection --
export function select(ids: string[]) {
  set({ selection: ids, editingText: null });
}

export function toggleSelect(id: string) {
  const s = S().selection;
  set({ selection: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] });
}

/** The real rows behind selected layers (virtual ones map to their instance). */
export function selectedRows(): DNode[] {
  const s = S();
  const out = new Map<string, DNode>();
  for (const id of s.selection) {
    const real = isVirtual(id) ? id.split("/")[0]! : id;
    const n = s.doc.nodes[real];
    if (n) out.set(real, n);
  }
  return [...out.values()];
}

// --------------------------------------------------------------- editing --
/**
 * Change properties of selected layers. Real layers take the patch as is;
 * layers inside an instance only take overridable properties, which land in
 * the instance's overrides.
 */
export function patchSelection(label: string, p: Partial<DNode> | ((n: RNode) => Partial<DNode>), ids = S().selection) {
  const { byId } = resolved();
  tx(label, (d) => {
    for (const rid of ids) {
      const rn = byId.get(rid);
      const patch = typeof p === "function" ? (rn ? p(rn) : null) : p;
      if (!patch) continue;
      if (!isVirtual(rid)) {
        if (d.get(rid)) d.patch(rid, patch);
        continue;
      }
      const inst = d.get(rn?.inst ?? rid.split("/")[0]!);
      if (!inst || !rn?.okey) continue;
      const o: Override = { ...(inst.overrides?.[rn.okey] ?? {}) };
      let any = false;
      for (const k of Object.keys(patch) as (keyof DNode)[]) {
        if (k === "text" && patch.text) {
          o.content = patch.text.content;
          any = true;
        } else if ((OVERRIDABLE as readonly string[]).includes(k)) {
          (o as Record<string, unknown>)[k as OverrideKey] = patch[k];
          any = true;
        }
      }
      if (any) d.patch(inst.id, { overrides: { ...(inst.overrides ?? {}), [rn.okey]: o } });
    }
  });
}

/** Drops an instance's overrides (all, or one layer's). */
export function resetOverrides(instanceId: string, key?: string) {
  tx("Reset overrides", (d) => {
    const n = d.get(instanceId);
    if (!n) return;
    if (key === undefined) d.patch(instanceId, { overrides: {}, propValues: {} });
    else {
      const o = { ...(n.overrides ?? {}) };
      delete o[key];
      d.patch(instanceId, { overrides: o });
    }
  });
}

// --------------------------------------------------------------- viewport --
export function setViewport(v: DesignState["viewport"]) {
  set({ viewport: { x: v.x, y: v.y, zoom: Math.min(256, Math.max(0.02, v.zoom)) } });
}

export function toScreen(p: { x: number; y: number }) {
  const v = S().viewport;
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

export function toWorld(p: { x: number; y: number }) {
  const v = S().viewport;
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

export function zoomTo(rect: { x: number; y: number; w: number; h: number } | null, pad = 80, max = 2) {
  const s = S();
  if (!rect || s.screen.w < 2) return;
  const zoom = Math.min(max, Math.max(0.02, Math.min((s.screen.w - pad * 2) / Math.max(1, rect.w), (s.screen.h - pad * 2) / Math.max(1, rect.h))));
  setViewport({ zoom, x: s.screen.w / 2 - (rect.x + rect.w / 2) * zoom, y: s.screen.h / 2 - (rect.y + rect.h / 2) * zoom });
}

export function zoomAt(factor: number, at?: { x: number; y: number }) {
  const s = S();
  const c = at ?? { x: s.screen.w / 2, y: s.screen.h / 2 };
  const z = Math.min(256, Math.max(0.02, s.viewport.zoom * factor));
  const w = toWorld(c);
  setViewport({ zoom: z, x: c.x - w.x * z, y: c.y - w.y * z });
}

const PEER_COLORS = ["#E5484D", "#0090FF", "#30A46C", "#F76B15", "#8E4EC6", "#D6409F", "#12A594", "#FFB224"];
export function peerColor(uid: string) {
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length]!;
}
