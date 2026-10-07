import type { ConnectorData, ConnectorEnd, WbItem } from "./types";
import { CONNECTABLE } from "./types";
import { center, connectorGeometry, contains, geomBounds, unionRects, type Pt, type Rect } from "./geometry";
import {
  commit,
  deleteItems,
  geomOf,
  maxZ,
  minZ,
  newId,
  patchItems,
  screenToWorld,
  selectionBounds,
  useWb,
  viewCenter,
  withGroups,
  type WbState,
} from "./store";
import { makeConnector, makeFrame } from "./factory";

// Editing commands shared by keyboard shortcuts, menus and toolbars.

const S = useWb.getState;
const set = useWb.setState;

const editable = (ids: string[]) => ids.filter((id) => S().items[id] && !S().items[id]!.locked);

// ----------------------------------------------------------- frames ------
/** Frame whose box holds a point (smallest wins), ignoring `skip`. */
export function frameAt(p: Pt, s: WbState = S(), skip?: Set<string>): string | null {
  let best: { id: string; area: number } | null = null;
  for (const it of Object.values(s.items)) {
    if (it.type !== "frame" || skip?.has(it.id)) continue;
    const g = geomOf(s, it.id)!;
    if (p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h) {
      const area = g.w * g.h;
      if (!best || area < best.area) best = { id: it.id, area };
    }
  }
  return best?.id ?? null;
}

/** Re-home moved items into the frame under their centre. */
export function withFrameMembership(changes: Record<string, WbItem | null>, s: WbState = S()): Record<string, WbItem | null> {
  const movingFrames = new Set(Object.values(changes).filter((c): c is WbItem => !!c && c.type === "frame").map((c) => c.id));
  const out = { ...changes };
  for (const [id, it] of Object.entries(changes)) {
    if (!it || it.type === "frame" || it.type === "connector") continue;
    // Children of a frame that moves with them keep their frame.
    if (it.frame_id && movingFrames.has(it.frame_id)) continue;
    const f = frameAt(center(geomBounds(it)), s);
    if (f !== it.frame_id) out[id] = { ...it, frame_id: f };
  }
  return out;
}

/** Items inside a frame box (for a new frame drawn around them). */
export function itemsInside(r: Rect, s: WbState = S()): string[] {
  return Object.values(s.items)
    .filter((it) => it.type !== "frame" && it.type !== "connector" && contains(r, geomBounds(it)))
    .map((it) => it.id);
}

export function frameAround(ids = S().selection) {
  const s = S();
  const b = selectionBounds(s, ids);
  if (!b) return;
  const pad = 40;
  const f = makeFrame(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  const changes: Record<string, WbItem> = { [f.id]: f };
  for (const id of ids) {
    const it = s.items[id];
    if (it && it.type !== "frame" && it.type !== "connector") changes[id] = { ...it, frame_id: f.id };
  }
  commit(changes, { select: [f.id] });
}

// ------------------------------------------------------------- z-order ---
export function bringToFront(ids = S().selection) {
  let z = maxZ();
  const s = S();
  const sorted = editable(ids).sort((a, b) => s.items[a]!.z - s.items[b]!.z);
  patchItems(sorted, (it) => ({ z: it.type === "frame" ? it.z : ++z }));
}

export function sendToBack(ids = S().selection) {
  let z = minZ();
  const s = S();
  const sorted = editable(ids).sort((a, b) => s.items[b]!.z - s.items[a]!.z);
  patchItems(sorted, () => ({ z: --z }));
}

/** One step up or down past the next overlapping item. */
export function shiftZ(dir: 1 | -1, ids = S().selection) {
  const s = S();
  const all = Object.values(s.items).sort((a, b) => a.z - b.z);
  const changes: Record<string, WbItem> = {};
  for (const id of editable(ids)) {
    const it = s.items[id]!;
    const box = geomBounds(it);
    const idx = all.findIndex((x) => x.id === id);
    const overl = (x: WbItem) => !ids.includes(x.id) && x.type !== "frame" && intersectsRect(box, geomBounds(x));
    if (dir > 0) {
      const next = all.slice(idx + 1).find(overl);
      if (!next) continue;
      const after = all[all.indexOf(next) + 1];
      changes[id] = { ...it, z: after ? (next.z + after.z) / 2 : next.z + 1 };
    } else {
      const prevs = all.slice(0, idx).reverse();
      const prev = prevs.find(overl);
      if (!prev) continue;
      const before = all[all.indexOf(prev) - 1];
      changes[id] = { ...it, z: before ? (prev.z + before.z) / 2 : prev.z - 1 };
    }
  }
  commit(changes);
}

const intersectsRect = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ------------------------------------------------------- group / lock -----
export function group(ids = S().selection) {
  if (ids.length < 2) return;
  const gid = newId();
  patchItems(editable(ids), () => ({ group_id: gid }));
}

export function ungroup(ids = S().selection) {
  patchItems(
    ids.filter((id) => S().items[id]?.group_id),
    () => ({ group_id: null }),
  );
}

export function setLocked(locked: boolean, ids = S().selection) {
  patchItems(ids, () => ({ locked }));
}

// --------------------------------------------------- align / distribute ---
export type AlignOp = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom" | "hspace" | "vspace";

export function align(op: AlignOp, ids = S().selection) {
  const s = S();
  const list = editable(ids).filter((id) => s.items[id]!.type !== "connector");
  if (list.length < 2) return;
  const boxes = list.map((id) => ({ id, b: geomBounds(s.items[id]!) }));
  const all = unionRects(boxes.map((x) => x.b))!;
  const changes: Record<string, WbItem> = {};
  const moveBy = (id: string, dx: number, dy: number) => {
    const it = s.items[id]!;
    changes[id] = { ...it, x: it.x + dx, y: it.y + dy };
  };
  if (op === "hspace" || op === "vspace") {
    const h = op === "hspace";
    const sorted = [...boxes].sort((a, b) => (h ? a.b.x - b.b.x : a.b.y - b.b.y));
    const total = sorted.reduce((t, x) => t + (h ? x.b.w : x.b.h), 0);
    const gap = ((h ? all.w : all.h) - total) / (sorted.length - 1);
    let at = h ? all.x : all.y;
    for (const x of sorted) {
      moveBy(x.id, h ? at - x.b.x : 0, h ? 0 : at - x.b.y);
      at += (h ? x.b.w : x.b.h) + gap;
    }
  } else {
    for (const { id, b } of boxes) {
      const dx =
        op === "left" ? all.x - b.x : op === "right" ? all.x + all.w - (b.x + b.w) : op === "hcenter" ? all.x + all.w / 2 - (b.x + b.w / 2) : 0;
      const dy =
        op === "top" ? all.y - b.y : op === "bottom" ? all.y + all.h - (b.y + b.h) : op === "vmiddle" ? all.y + all.h / 2 - (b.y + b.h / 2) : 0;
      if (dx || dy) moveBy(id, dx, dy);
    }
  }
  commit(withFrameMembership(changes));
}

// -------------------------------------------------------- move / nudge ----
export function nudge(dx: number, dy: number, ids = S().selection) {
  const s = S();
  const list = new Set(editable(withGroups(ids, s)));
  for (const id of [...list]) if (s.items[id]?.type === "frame") for (const it of Object.values(s.items)) if (it.frame_id === id && !it.locked) list.add(it.id);
  const changes: Record<string, WbItem> = {};
  for (const id of list) {
    const it = s.items[id]!;
    changes[id] = it.type === "connector" ? moveConnectorFreeEnds(it, dx, dy) : { ...it, x: it.x + dx, y: it.y + dy };
  }
  commit(withFrameMembership(changes), { key: "nudge" });
}

export function moveConnectorFreeEnds(it: WbItem, dx: number, dy: number): WbItem {
  const d = it.data as ConnectorData;
  const mv = (e?: ConnectorEnd): ConnectorEnd | undefined => (e && !e.id ? { ...e, x: (e.x ?? 0) + dx, y: (e.y ?? 0) + dy } : e);
  return { ...it, data: { ...it.data, start: mv(d.start), end: mv(d.end) } };
}

export function selectAll() {
  set({ selection: Object.keys(S().items), editing: null });
}

// ------------------------------------------------- copy / paste / dup -----
const MARK = "iklipse-wb:";
let memoryClipboard: string | null = null;

function snapshot(ids: string[]): WbItem[] {
  const s = S();
  const set2 = new Set(withGroups(ids, s));
  for (const id of [...set2]) if (s.items[id]?.type === "frame") for (const it of Object.values(s.items)) if (it.frame_id === id) set2.add(it.id);
  return [...set2].map((id) => s.items[id]).filter((x): x is WbItem => !!x);
}

export async function copySelection(ids = S().selection) {
  const items = snapshot(ids);
  if (!items.length) return;
  const text = MARK + JSON.stringify({ v: 1, board: S().boardId, items });
  memoryClipboard = text;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked: in-app paste still works */
  }
}

export async function cutSelection() {
  await copySelection();
  deleteItems(S().selection);
}

/** Paste items from clipboard text. Returns false when the text isn't ours. */
export function pasteText(text: string | null, at?: Pt): boolean {
  const raw = text?.startsWith(MARK) ? text : memoryClipboard && !text ? memoryClipboard : null;
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw.slice(MARK.length)) as { board?: string; items?: WbItem[] };
    if (!parsed.items?.length) return false;
    placeCopies(parsed.items, at ?? viewCenter(), parsed.board === S().boardId);
    return true;
  } catch {
    return false;
  }
}

export function duplicate(ids = S().selection) {
  const items = snapshot(ids);
  if (!items.length) return;
  const b = unionRects(items.map((i) => geomBounds(i)))!;
  placeCopies(items, { x: b.x + b.w / 2 + 24, y: b.y + b.h / 2 + 24 }, true);
}

/** Insert copies of items with their centre at `at`, re-linking frames, groups and connectors. */
export function placeCopies(items: WbItem[], at: Pt, sameBoard: boolean, key?: string): string[] {
  const s = S();
  const ids = new Map(items.map((i) => [i.id, newId()]));
  const groups = new Map<string, string>();
  const nonConn = items.filter((i) => i.type !== "connector");
  const b = unionRects((nonConn.length ? nonConn : items).map((i) => geomBounds(i))) ?? { x: 0, y: 0, w: 0, h: 0 };
  const dx = at.x - (b.x + b.w / 2);
  const dy = at.y - (b.y + b.h / 2);
  let z = maxZ(s);
  const changes: Record<string, WbItem> = {};
  const sorted = [...items].sort((a, c) => a.z - c.z);
  for (const it of sorted) {
    const id = ids.get(it.id)!;
    const gid = it.group_id ? (groups.get(it.group_id) ?? (groups.set(it.group_id, newId()), groups.get(it.group_id)!)) : null;
    let data = it.data;
    if (it.type === "connector") {
      const d = it.data as ConnectorData;
      const geo = connectorGeometry(d, (x) => geomOf(s, x));
      const re = (e: ConnectorEnd | undefined, p: Pt): ConnectorEnd => {
        if (e?.id && ids.has(e.id)) return { ...e, id: ids.get(e.id)! };
        if (e?.id && sameBoard && s.items[e.id]) return { x: p.x + dx, y: p.y + dy };
        return { x: (e?.x ?? p.x) + dx, y: (e?.y ?? p.y) + dy };
      };
      data = { ...d, start: re(d.start, geo.start), end: re(d.end, geo.end) };
    } else if (it.type === "doc") {
      // The text lives in the original's log: the copy reads it the first time it opens.
      const prev = Array.isArray(it.data.copyOf) ? (it.data.copyOf as unknown[]).filter((x): x is string => typeof x === "string") : [];
      data = { ...it.data, copyOf: [it.id, ...prev].slice(0, 4) };
    }
    changes[id] = {
      ...it,
      id,
      board_id: s.boardId!,
      x: it.x + dx,
      y: it.y + dy,
      z: it.type === "frame" ? it.z : ++z,
      group_id: gid,
      frame_id: it.frame_id && ids.has(it.frame_id) ? ids.get(it.frame_id)! : null,
      locked: false,
      data,
      created_by: undefined,
      updated_by: undefined,
      created_at: undefined,
      updated_at: undefined,
      sid: undefined,
    };
  }
  const withFrames = withFrameMembership(changes);
  commit(withFrames, { select: [...ids.values()], key });
  return [...ids.values()];
}

/** Last pointer position over the canvas (world), for pasting where the mouse is. */
export const pointer = { screen: null as Pt | null };
export function pointerWorld(): Pt | undefined {
  return pointer.screen ? screenToWorld(pointer.screen) : undefined;
}

// --------------------------------------------------- quick create / mind --
type Dir = "top" | "right" | "bottom" | "left";
const OPP: Record<Dir, Dir> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/** Copy of an item next to it, joined by a connector (the "+" handles). */
export function cloneConnected(id: string, dir: Dir, at?: Pt): string | null {
  const s = S();
  const src = s.items[id];
  if (!src || !CONNECTABLE.includes(src.type) || src.type === "frame") return null;
  const gap = 100;
  const nx = at ? at.x - src.w / 2 : dir === "right" ? src.x + src.w + gap : dir === "left" ? src.x - src.w - gap : src.x;
  const ny = at ? at.y - src.h / 2 : dir === "bottom" ? src.y + src.h + gap : dir === "top" ? src.y - src.h - gap : src.y;
  const data = { ...src.data };
  for (const k of ["text", "title", "description"]) if (k in data) data[k] = "";
  const copy: WbItem = {
    ...src,
    id: newId(),
    x: nx,
    y: ny,
    rotation: 0,
    z: maxZ(s) + 2,
    group_id: null,
    locked: false,
    data,
    created_by: undefined,
    updated_by: undefined,
    created_at: undefined,
    updated_at: undefined,
    sid: undefined,
  };
  const conn = makeConnector(
    { id: src.id, side: at ? "auto" : dir },
    { id: copy.id, side: at ? "auto" : OPP[dir] },
    s.toolOpts.connectorKind,
    s.toolOpts.endCap,
    {},
    maxZ(s) + 1,
  );
  commit(withFrameMembership({ [copy.id]: copy, [conn.id]: conn }), { select: [copy.id] });
  if (["sticky", "shape", "text", "card"].includes(copy.type)) set({ editing: { id: copy.id, field: "text" } });
  return copy.id;
}

/** Mind-map style: Tab adds a child to the right, Enter a sibling below. */
export function addChild(id: string) {
  const s = S();
  const src = s.items[id];
  if (!src || !["sticky", "shape", "text", "card"].includes(src.type)) return;
  const kids = Object.values(s.items)
    .filter((c) => c.type === "connector" && (c.data as ConnectorData).start?.id === id && c.data.mind)
    .map((c) => s.items[(c.data as ConnectorData).end?.id ?? ""])
    .filter((x): x is WbItem => !!x);
  const x = src.x + src.w + 80;
  const y = kids.length ? Math.max(...kids.map((k) => k.y + k.h)) + 24 : src.y;
  const data = { ...src.data, text: "" };
  const child: WbItem = { ...src, id: newId(), x, y, z: maxZ(s) + 2, group_id: null, locked: false, data, created_by: undefined, updated_by: undefined, created_at: undefined, updated_at: undefined, sid: undefined };
  const conn = makeConnector({ id, side: "right" }, { id: child.id, side: "left" }, "curved", "none", { mind: true }, maxZ(s) + 1);
  commit(withFrameMembership({ [child.id]: child, [conn.id]: conn }), { select: [child.id] });
  set({ editing: { id: child.id, field: "text" } });
}

export function addSibling(id: string) {
  const s = S();
  const parentConn = Object.values(s.items).find((c) => c.type === "connector" && (c.data as ConnectorData).end?.id === id && c.data.mind);
  const parent = parentConn ? (parentConn.data as ConnectorData).start?.id : null;
  if (parent && s.items[parent]) addChild(parent);
  else cloneConnected(id, "bottom");
}

export function selectedConnectable(): string | null {
  const s = S();
  if (s.selection.length !== 1) return null;
  const it = s.items[s.selection[0]!];
  return it && CONNECTABLE.includes(it.type) ? it.id : null;
}
