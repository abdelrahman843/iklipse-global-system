import { uploadImage, isUploadableImage } from "@/lib/wb/api";
import {
  absPos,
  bottomOrder,
  childrenOf,
  cloneTrees,
  descendants,
  detach,
  isVirtual,
  makeComponent,
  makeInstance,
  makeNode,
  removeTrees,
  shortId,
  topOrder,
  unwrap,
  wrap,
} from "./doc";
import { childIndex, unionRect } from "./layout";
import { resolved, resolvedAll, select, tx, useDesign, zoomTo } from "./store";
import type { DesignDoc, DNode, NodeType, Page } from "./types";

// -----------------------------------------------------------------------------
// Editor commands (toolbar, menus, shortcuts). Each is one undo step.
// -----------------------------------------------------------------------------

const S = useDesign.getState;
const set = useDesign.setState;

/** Real, unlocked, top-most selected layers (children of selected layers dropped). */
export function selectedReal(includeLocked = false): DNode[] {
  const s = S();
  const ids = new Set(s.selection.filter((id) => !isVirtual(id)));
  const out: DNode[] = [];
  for (const id of ids) {
    const n = s.doc.nodes[id];
    if (!n || (!includeLocked && n.locked)) continue;
    let p = n.parent;
    let covered = false;
    while (p) {
      if (ids.has(p)) {
        covered = true;
        break;
      }
      p = s.doc.nodes[p]?.parent ?? null;
    }
    if (!covered) out.push(n);
  }
  return out;
}

/** Adds a layer under `parent` at absolute page position (x, y). */
export function addNode(type: NodeType, at: { x: number; y: number; w?: number; h?: number }, parent: string | null, p: Partial<DNode> = {}) {
  const s = S();
  const pAbs = parent ? absPos(s.doc, parent, resolved().byId) : { x: 0, y: 0 };
  const n = makeNode(type, s.page, parent, {
    ...p,
    x: Math.round(at.x - pAbs.x),
    y: Math.round(at.y - pAbs.y),
    ...(at.w !== undefined ? { w: Math.round(at.w) } : {}),
    ...(at.h !== undefined ? { h: Math.round(at.h) } : {}),
    order: topOrder(s.doc, parent, s.page),
  });
  if (type === "frame" && !parent) {
    const count = Object.values(s.doc.nodes).filter((x) => x.page === s.page && x.type === "frame").length;
    n.name = `Frame ${count + 1}`;
  }
  tx(`Add ${n.name.toLowerCase()}`, (d) => d.put(n), { select: [n.id] });
  return n;
}

export function deleteSelection() {
  const nodes = selectedReal();
  if (!nodes.length) return;
  const all = resolvedAll();
  tx("Delete", (d) => removeTrees(d, nodes.map((n) => n.id), all), { select: [] });
}

export function duplicateSelection(offset = 20) {
  const nodes = selectedReal();
  if (!nodes.length) return;
  const s = S();
  const ids: string[] = [];
  tx(
    "Duplicate",
    (d) => {
      for (const n of nodes) {
        // Top-level frames go next to the original; anything else nudges.
        const dx = !n.parent && n.type === "frame" ? n.w + 80 : n.parent && s.doc.nodes[n.parent]?.layout ? 0 : offset;
        const dy = !n.parent && n.type === "frame" ? 0 : n.parent && s.doc.nodes[n.parent]?.layout ? 0 : offset;
        const copies = cloneTrees(d.doc, [n.id], n.parent, n.page, dx, dy);
        // Place right after the original among siblings.
        copies[0]!.order = n.order + 0.5;
        copies[0]!.name = n.name;
        for (const c of copies) d.put(c);
        ids.push(copies[0]!.id);
      }
    },
    {},
  );
  select(ids);
}

// --------------------------------------------------------------- clipboard --
const CLIP = "iklipse-design-clip";
let internalClip: { nodes: DNode[]; roots: string[] } | null = null;

export async function copySelection(cut = false) {
  const s = S();
  if (!s.canCopy) return;
  const nodes = selectedReal(true);
  if (!nodes.length) return;
  const idx = childIndex(s.doc);
  const all: DNode[] = [];
  const pos = resolved().byId;
  for (const n of nodes) {
    // Roots carry their page position so pasting elsewhere keeps the look.
    const a = absPos(s.doc, n.id, pos);
    all.push({ ...n, x: a.x, y: a.y, parent: null });
    all.push(...descendants(s.doc, n.id, idx));
  }
  // Components the copies use travel along (pasted only if missing).
  const comps = new Set(all.filter((n) => n.type === "instance" && n.componentId).map((n) => n.componentId!));
  const extra: DNode[] = [];
  for (const c of comps) if (!all.some((n) => n.id === c) && s.doc.nodes[c]) extra.push(s.doc.nodes[c]!, ...descendants(s.doc, c, idx));
  internalClip = { nodes: [...all, ...extra], roots: nodes.map((n) => n.id) };
  const text = JSON.stringify({ format: CLIP, nodes: internalClip.nodes, roots: internalClip.roots });
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard blocked: internal copy still works */
  }
  if (cut) deleteSelection();
}

/** Paste layers (internal or from another tab), at `at` (page point) or offset from where they were. */
export function pasteClip(text: string | null, at?: { x: number; y: number }) {
  let clip = internalClip;
  if (text) {
    try {
      const j = JSON.parse(text) as { format?: string; nodes?: DNode[]; roots?: string[] };
      if (j.format === CLIP && Array.isArray(j.nodes) && Array.isArray(j.roots)) clip = { nodes: j.nodes, roots: j.roots };
      else if (text.trim()) return false;
    } catch {
      return false;
    }
  }
  if (!clip) return false;
  const s = S();
  const temp: DesignDoc = { data: s.doc.data, nodes: {} };
  for (const n of clip.nodes) temp.nodes[n.id] = { ...n, page: s.page };
  // Paste into the selected frame when one is selected, else the page.
  const target = selectedReal().find((n) => n.type === "frame" || n.type === "component");
  const parent = target?.id ?? null;
  const pAbs = parent ? absPos(s.doc, parent, resolved().byId) : { x: 0, y: 0 };
  const roots = clip.roots.filter((id) => temp.nodes[id]);
  const box = unionRect(roots.map((id) => ({ x: temp.nodes[id]!.x, y: temp.nodes[id]!.y, w: temp.nodes[id]!.w, h: temp.nodes[id]!.h })));
  const dx = at && box ? at.x - box.x : 20;
  const dy = at && box ? at.y - box.y : 20;
  const newIds: string[] = [];
  tx("Paste", (d) => {
    // Missing components first, keeping their ids so instances still point at them.
    for (const n of clip!.nodes) {
      if (n.type === "component" && !d.get(n.id) && !roots.includes(n.id)) {
        const subtree = [n, ...descendants(temp, n.id)];
        for (const c of subtree) d.put({ ...c, page: s.page, parent: c.id === n.id ? null : c.parent, x: c.id === n.id ? c.x + 400 : c.x });
      }
    }
    const copies = cloneTrees(temp, roots, parent, s.page, dx - pAbs.x, dy - pAbs.y);
    for (const c of copies) d.put(c);
    for (const c of copies) if (c.parent === parent) newIds.push(c.id);
  });
  select(newIds);
  return true;
}

// ------------------------------------------------------------- structure --
export function groupSelection() {
  const nodes = selectedReal();
  if (!nodes.length) return;
  const id = tx("Group", (d) => wrap(d, nodes.map((n) => n.id), "group", resolved().byId));
  if (id) select([id]);
}

export function frameSelection() {
  const nodes = selectedReal();
  if (!nodes.length) return;
  const id = tx("Frame selection", (d) => wrap(d, nodes.map((n) => n.id), "frame", resolved().byId));
  if (id) select([id]);
}

export function ungroupSelection() {
  const nodes = selectedReal().filter((n) => n.type === "group" || n.type === "frame");
  if (!nodes.length) return;
  const kids: string[] = [];
  tx("Ungroup", (d) => {
    for (const n of nodes) kids.push(...unwrap(d, n.id, resolved().byId));
  });
  select(kids);
}

export function componentFromSelection() {
  const nodes = selectedReal();
  if (!nodes.length) return;
  const id = tx("Create component", (d) => makeComponent(d, nodes.map((n) => n.id), resolved().byId));
  if (id) select([id]);
}

export function insertInstance(componentId: string, at?: { x: number; y: number }) {
  const s = S();
  const c = s.doc.nodes[componentId];
  if (!c) return;
  const center = at ?? viewCenter();
  const n = makeInstance(s.doc, componentId, s.page, null, Math.round(center.x - c.w / 2), Math.round(center.y - c.h / 2));
  if (!n) return;
  tx("Insert instance", (d) => d.put(n), { select: [n.id] });
}

export function detachSelection() {
  const all = resolvedAll();
  const nodes = selectedReal().filter((n) => n.type === "instance");
  tx("Detach instance", (d) => {
    for (const n of nodes) {
      const r = all.get(n.id);
      if (r) detach(d, n.id, r);
    }
  });
}

export function viewCenter() {
  const s = S();
  return { x: (s.screen.w / 2 - s.viewport.x) / s.viewport.zoom, y: (s.screen.h / 2 - s.viewport.y) / s.viewport.zoom };
}

// ---------------------------------------------------------------- z-order --
export function reorder(where: "front" | "back" | "forward" | "backward") {
  const nodes = selectedReal();
  if (!nodes.length) return;
  tx("Reorder", (d) => {
    for (const n of nodes) {
      const sib = childrenOf(d.doc, n.parent, n.page);
      const i = sib.findIndex((x) => x.id === n.id);
      if (where === "front") d.patch(n.id, { order: topOrder(d.doc, n.parent, n.page) });
      else if (where === "back") d.patch(n.id, { order: bottomOrder(d.doc, n.parent, n.page) });
      else if (where === "forward" && i < sib.length - 1) {
        const a = sib[i + 1]!;
        const b = sib[i + 2];
        d.patch(n.id, { order: b ? (a.order + b.order) / 2 : a.order + 1 });
      } else if (where === "backward" && i > 0) {
        const a = sib[i - 1]!;
        const b = sib[i - 2];
        d.patch(n.id, { order: b ? (a.order + b.order) / 2 : a.order - 1 });
      }
    }
  });
}

/** Drop a layer in the layers panel: before / after another, or inside it. */
export function moveLayer(id: string, target: string, where: "before" | "after" | "inside") {
  const s = S();
  const n = s.doc.nodes[id];
  const t = s.doc.nodes[target];
  if (!n || !t || id === target) return;
  const parent = where === "inside" ? t.id : t.parent;
  if (parent && (parent === id || descendants(s.doc, id).some((x) => x.id === parent))) return;
  const sib = childrenOf(s.doc, parent, t.page).filter((x) => x.id !== id);
  let order: number;
  if (where === "inside") order = topOrder(s.doc, parent, t.page);
  else {
    // The layers panel lists front-most first: "before" in the list = in front.
    const i = sib.findIndex((x) => x.id === t.id);
    const front = where === "before";
    const neighbour = front ? sib[i + 1] : sib[i - 1];
    order = neighbour ? (t.order + neighbour.order) / 2 : t.order + (front ? 1 : -1);
  }
  const byId = resolved().byId;
  tx("Move layer", (d) => {
    if (n.parent !== parent) {
      const pAbs = parent ? absPos(d.doc, parent, byId) : { x: 0, y: 0 };
      const a = absPos(d.doc, id, byId);
      d.patch(id, { parent, x: a.x - pAbs.x, y: a.y - pAbs.y, order });
    } else d.patch(id, { order });
  });
}

// ---------------------------------------------------------------- arrange --
export function align(how: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") {
  const nodes = selectedReal();
  const byId = resolved().byId;
  const rs = nodes.map((n) => byId.get(n.id)).filter(Boolean) as NonNullable<ReturnType<typeof byId.get>>[];
  if (!rs.length) return;
  // One layer aligns to its parent; several align to their joint bounds.
  let box = unionRect(rs.map((r) => ({ x: r.ax, y: r.ay, w: r.w, h: r.h })))!;
  if (rs.length === 1 && rs[0]!.parent) {
    const p = byId.get(rs[0]!.parent);
    if (p) box = { x: p.ax, y: p.ay, w: p.w, h: p.h };
  }
  tx("Align", (d) => {
    for (const r of rs) {
      let { ax, ay } = r;
      if (how === "left") ax = box.x;
      if (how === "right") ax = box.x + box.w - r.w;
      if (how === "hcenter") ax = box.x + (box.w - r.w) / 2;
      if (how === "top") ay = box.y;
      if (how === "bottom") ay = box.y + box.h - r.h;
      if (how === "vcenter") ay = box.y + (box.h - r.h) / 2;
      d.patch(r.rid, { x: Math.round(r.x + ax - r.ax), y: Math.round(r.y + ay - r.ay) });
    }
  });
}

export function distribute(axis: "h" | "v") {
  const byId = resolved().byId;
  const rs = selectedReal()
    .map((n) => byId.get(n.id))
    .filter(Boolean) as NonNullable<ReturnType<typeof byId.get>>[];
  if (rs.length < 3) return;
  const sorted = [...rs].sort((a, b) => (axis === "h" ? a.ax - b.ax : a.ay - b.ay));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = axis === "h" ? last.ax + last.w - first.ax : last.ay + last.h - first.ay;
  const sizes = sorted.reduce((s, r) => s + (axis === "h" ? r.w : r.h), 0);
  const gap = (span - sizes) / (sorted.length - 1);
  tx("Distribute", (d) => {
    let pos = axis === "h" ? first.ax : first.ay;
    for (const r of sorted) {
      if (axis === "h") d.patch(r.rid, { x: Math.round(r.x + pos - r.ax) });
      else d.patch(r.rid, { y: Math.round(r.y + pos - r.ay) });
      pos += (axis === "h" ? r.w : r.h) + gap;
    }
  });
}

export function nudge(dx: number, dy: number) {
  const nodes = selectedReal();
  if (!nodes.length) return;
  tx("Nudge", (d) => {
    for (const n of nodes) d.patch(n.id, { x: n.x + dx, y: n.y + dy });
  });
}

export function flip(axis: "h" | "v") {
  const nodes = selectedReal().filter((n) => n.points?.length);
  tx("Flip", (d) => {
    for (const n of nodes) d.patch(n.id, { points: n.points!.map((p) => (axis === "h" ? { ...p, x: n.w - p.x } : { ...p, y: n.h - p.y })) });
  });
}

export function toggle(key: "visible" | "locked", ids?: string[]) {
  const s = S();
  const nodes = (ids ?? selectedReal(true).map((n) => n.id)).map((id) => s.doc.nodes[id]).filter(Boolean) as DNode[];
  if (!nodes.length) return;
  const val = key === "visible" ? !nodes.every((n) => n.visible) : !nodes.every((n) => n.locked);
  tx(key === "visible" ? (val ? "Show" : "Hide") : val ? "Lock" : "Unlock", (d) => {
    for (const n of nodes) d.patch(n.id, { [key]: val });
  });
}

export function selectAll() {
  const s = S();
  const sel = selectedReal(true);
  // Inside a frame: its children; else top-level layers.
  const parent = sel[0]?.parent ?? null;
  select(childrenOf(s.doc, parent, s.page).filter((n) => n.visible && !n.locked).map((n) => n.id));
}

export function zoomToSelection() {
  const byId = resolved().byId;
  const rs = S()
    .selection.map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({ x: r!.ax, y: r!.ay, w: r!.w, h: r!.h }));
  zoomTo(unionRect(rs), 80, 8);
}

export function zoomToFit() {
  const { roots } = resolved();
  zoomTo(unionRect(roots.filter((r) => r.visible !== false).map((r) => ({ x: r.ax, y: r.ay, w: r.w, h: r.h }))), 80, 1);
}

// ------------------------------------------------------------------ pages --
export function addPage() {
  const s = S();
  const p: Page = { id: shortId(), name: `Page ${s.doc.data.pages.length + 1}`, bg: "#f5f5f5", start: null };
  tx("Add page", (d) => d.setData((x) => ({ ...x, pages: [...x.pages, p] })), { select: [] });
  set({ page: p.id });
}

export function renamePage(id: string, name: string) {
  tx("Rename page", (d) => d.setData((x) => ({ ...x, pages: x.pages.map((p) => (p.id === id ? { ...p, name: name.slice(0, 120) || p.name } : p)) })));
}

export function setPageBg(id: string, bg: string) {
  tx("Page colour", (d) => d.setData((x) => ({ ...x, pages: x.pages.map((p) => (p.id === id ? { ...p, bg } : p)) })));
}

export function deletePage(id: string) {
  const s = S();
  if (s.doc.data.pages.length < 2) return;
  const roots = Object.values(s.doc.nodes).filter((n) => n.page === id && !n.parent);
  const all = resolvedAll();
  tx(
    "Delete page",
    (d) => {
      removeTrees(d, roots.map((n) => n.id), all);
      d.setData((x) => ({ ...x, pages: x.pages.filter((p) => p.id !== id) }));
    },
    { select: [] },
  );
  if (S().page === id) set({ page: S().doc.data.pages[0]!.id });
}

export function duplicatePage(id: string) {
  const s = S();
  const src = s.doc.data.pages.find((p) => p.id === id);
  if (!src) return;
  const p: Page = { ...src, id: shortId(), name: `${src.name} copy`, start: null };
  const roots = Object.values(s.doc.nodes)
    .filter((n) => n.page === id && !n.parent)
    .map((n) => n.id);
  tx(
    "Duplicate page",
    (d) => {
      d.setData((x) => ({ ...x, pages: [...x.pages, p] }));
      for (const c of cloneTrees(d.doc, roots, null, p.id)) d.put(c);
    },
    { select: [] },
  );
  set({ page: p.id });
}

export function movePage(id: string, dir: -1 | 1) {
  tx("Move page", (d) =>
    d.setData((x) => {
      const pages = [...x.pages];
      const i = pages.findIndex((p) => p.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= pages.length) return x;
      [pages[i], pages[j]] = [pages[j]!, pages[i]!];
      return { ...x, pages };
    }),
  );
}

// ------------------------------------------------------------------ images --
export async function addImages(files: File[], at?: { x: number; y: number }, parent: string | null = null) {
  const s = S();
  if (!s.boardId || !s.canEdit) return;
  const imgs = files.filter(isUploadableImage);
  if (!imgs.length) throw new Error("Use PNG, JPEG, GIF or WebP images.");
  let p = at ?? viewCenter();
  const ids: string[] = [];
  for (const f of imgs) {
    const up = await uploadImage(s.boardId, f);
    const scale = Math.min(1, 800 / Math.max(up.nw, up.nh));
    const w = Math.round(up.nw * scale);
    const h = Math.round(up.nh * scale);
    const n = addNode("image", { x: p.x - w / 2, y: p.y - h / 2, w, h }, parent, {
      name: f.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Image",
      image: { src: up.path, nw: up.nw, nh: up.nh, fit: "fill", name: f.name },
    });
    ids.push(n.id);
    p = { x: p.x + 24, y: p.y + 24 };
  }
  select(ids);
}

/** Every image used in the document (assets panel). */
export function imagesInDoc(): { src: string; nw: number; nh: number; name: string }[] {
  const seen = new Map<string, { src: string; nw: number; nh: number; name: string }>();
  for (const n of Object.values(S().doc.nodes)) {
    if (n.image?.src && !seen.has(n.image.src)) seen.set(n.image.src, { src: n.image.src, nw: n.image.nw, nh: n.image.nh, name: n.image.name ?? n.name });
  }
  return [...seen.values()];
}
