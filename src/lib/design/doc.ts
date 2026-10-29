import { applyConstraints, childIndex, type RNode } from "./layout";
import type { DesignDoc, DNode, DocData, NodeType, Paint } from "./types";
import { CONTAINER_TYPES } from "./types";

// -----------------------------------------------------------------------------
// Pure document operations. Everything that changes the document goes through
// a Draft (store.ts records it for undo / redo and saving), so these helpers
// never touch the store or the network.
// -----------------------------------------------------------------------------

export interface Draft {
  readonly doc: DesignDoc;
  get(id: string): DNode | undefined;
  put(n: DNode): void;
  patch(id: string, p: Partial<DNode>): void;
  remove(id: string): void;
  setData(fn: (d: DocData) => DocData): void;
}

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });

export const shortId = () => Math.random().toString(36).slice(2, 10);

export function emptyData(): DocData {
  return {
    pages: [{ id: shortId(), name: "Page 1", bg: "#f5f5f5", start: null }],
    colors: [],
    textStyles: [],
    tokens: [],
    library: [],
  };
}

const solid = (color: string): Paint => ({ type: "solid", color });

const TYPE_NAMES: Record<NodeType, string> = {
  frame: "Frame",
  group: "Group",
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
  arrow: "Arrow",
  polygon: "Polygon",
  star: "Star",
  path: "Vector",
  text: "Text",
  image: "Image",
  component: "Component",
  instance: "Instance",
};

/** A new layer with sensible defaults for its type. */
export function makeNode(type: NodeType, page: string, parent: string | null, p: Partial<DNode> = {}): DNode {
  const base: DNode = {
    id: uid(),
    type,
    name: TYPE_NAMES[type],
    page,
    parent,
    order: 0,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    visible: true,
    locked: false,
    opacity: 1,
    fills: [],
    strokes: [],
  };
  switch (type) {
    case "frame":
    case "component":
      Object.assign(base, { fills: [solid("#FFFFFF")], clip: true, w: 400, h: 300 });
      break;
    case "rect":
    case "polygon":
    case "star":
      Object.assign(base, { fills: [solid("#D9D9D9")] });
      if (type === "polygon") base.sides = 3;
      if (type === "star") Object.assign(base, { sides: 5, innerRatio: 0.38 });
      break;
    case "ellipse":
      Object.assign(base, { fills: [solid("#D9D9D9")] });
      break;
    case "line":
    case "arrow":
      Object.assign(base, {
        h: 0,
        strokes: [{ color: "#1E1E1E", width: 2 }],
        caps: { start: "none", end: type === "arrow" ? "arrow" : "none" },
      });
      break;
    case "path":
      Object.assign(base, { strokes: [{ color: "#1E1E1E", width: 2 }], points: [], closed: false });
      break;
    case "text":
      Object.assign(base, {
        fills: [solid("#1E1E1E")],
        w: 120,
        h: 24,
        text: { content: "Text", fontFamily: "Inter", fontWeight: 400, fontSize: 16, lineHeight: null, letterSpacing: 0, align: "left", valign: "top", resize: "auto-width" },
      });
      break;
    case "image":
      Object.assign(base, { fills: [] });
      break;
    case "group":
      break;
    case "instance":
      break;
  }
  return { ...base, ...p };
}

// ------------------------------------------------------------------- order --
export function childrenOf(doc: DesignDoc, parent: string | null, page: string): DNode[] {
  return (childIndex(doc).get(parent ?? `page:${page}`) ?? []).slice();
}

export function topOrder(doc: DesignDoc, parent: string | null, page: string) {
  let m = 0;
  for (const n of Object.values(doc.nodes)) if (n.parent === parent && n.page === page) m = Math.max(m, n.order);
  return m + 1;
}

export function bottomOrder(doc: DesignDoc, parent: string | null, page: string) {
  let m = Infinity;
  for (const n of Object.values(doc.nodes)) if (n.parent === parent && n.page === page) m = Math.min(m, n.order);
  return isFinite(m) ? m - 1 : 0;
}

export function descendants(doc: DesignDoc, id: string, idx = childIndex(doc)): DNode[] {
  const out: DNode[] = [];
  const stack = [...(idx.get(id) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    stack.push(...(idx.get(n.id) ?? []));
  }
  return out;
}

export function ancestors(doc: DesignDoc, id: string): DNode[] {
  const out: DNode[] = [];
  let cur = doc.nodes[id]?.parent;
  let guard = 0;
  while (cur && guard++ < 200) {
    const n = doc.nodes[cur];
    if (!n) break;
    out.push(n);
    cur = n.parent;
  }
  return out;
}

export function isContainer(t: NodeType) {
  return CONTAINER_TYPES.includes(t);
}

/** Can `child` go inside `parent` (no cycles, real containers, not into instances). */
export function canNest(doc: DesignDoc, child: string, parent: string | null) {
  if (!parent) return true;
  const p = doc.nodes[parent];
  if (!p || !isContainer(p.type) || p.type === "instance") return false;
  if (parent === child) return false;
  return !ancestors(doc, parent).some((a) => a.id === child);
}

/** Absolute top-left of a real layer, from its ancestors' stored positions (resolved positions preferred when given). */
export function absPos(doc: DesignDoc, id: string, resolved?: Map<string, RNode>): { x: number; y: number } {
  const r = resolved?.get(id);
  if (r) return { x: r.ax, y: r.ay };
  let x = 0,
    y = 0;
  let cur: DNode | undefined = doc.nodes[id];
  let guard = 0;
  while (cur && guard++ < 200) {
    x += cur.x;
    y += cur.y;
    cur = cur.parent ? doc.nodes[cur.parent] : undefined;
  }
  return { x, y };
}

/** Moves layers under another parent, keeping where they are on the page. */
export function reparent(d: Draft, ids: string[], parent: string | null, page: string, resolved?: Map<string, RNode>, beforeOrder?: number) {
  const pAbs = parent ? absPos(d.doc, parent, resolved) : { x: 0, y: 0 };
  let order = beforeOrder ?? topOrder(d.doc, parent, page);
  for (const id of ids) {
    const n = d.get(id);
    if (!n || !canNest(d.doc, id, parent)) continue;
    const a = absPos(d.doc, id, resolved);
    const moved: Partial<DNode> = { parent, page, x: a.x - pAbs.x, y: a.y - pAbs.y, order: order };
    order += beforeOrder !== undefined ? 0.001 : 1;
    if (n.page !== page) for (const c of descendants(d.doc, id)) d.patch(c.id, { page });
    d.patch(id, moved);
  }
}

/** Copies of layers (with everything inside), placed under `parent` and moved by (dx, dy). */
export function cloneTrees(doc: DesignDoc, ids: string[], parent: string | null, page: string, dx = 0, dy = 0): DNode[] {
  const idx = childIndex(doc);
  const out: DNode[] = [];
  let order = topOrder(doc, parent, page);
  const map = new Map<string, string>();
  const copy = (n: DNode, newParent: string | null, root: boolean) => {
    const id = uid();
    map.set(n.id, id);
    const c: DNode = structuredClone(n);
    c.id = id;
    c.parent = newParent;
    c.page = page;
    if (root) {
      c.x += dx;
      c.y += dy;
      c.order = order++;
    }
    out.push(c);
    for (const ch of idx.get(n.id) ?? []) copy(ch, id, false);
  };
  for (const id of ids) {
    const n = doc.nodes[id];
    if (n) copy(n, parent, true);
  }
  // Interactions pointing inside the copy follow it; component props target the copied layers.
  for (const c of out) {
    if (c.props) c.props = c.props.map((p) => ({ ...p, target: map.get(p.target) ?? p.target }));
  }
  return out;
}

/** Wraps layers (same parent) in a group or frame. Returns the new id. */
export function wrap(d: Draft, ids: string[], type: "group" | "frame" | "component", resolved: Map<string, RNode>): string | null {
  const nodes = ids.map((id) => d.get(id)).filter(Boolean) as DNode[];
  if (!nodes.length) return null;
  const parent = nodes[0]!.parent;
  const page = nodes[0]!.page;
  const same = nodes.filter((n) => n.parent === parent);
  const rects = same.map((n) => {
    const r = resolved.get(n.id);
    return r ? { x: r.ax, y: r.ay, w: r.w, h: r.h } : { ...absPos(d.doc, n.id), w: n.w, h: n.h };
  });
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  const pAbs = parent ? absPos(d.doc, parent, resolved) : { x: 0, y: 0 };
  const order = Math.max(...same.map((n) => n.order));
  const g = makeNode(type, page, parent, {
    x: x0 - pAbs.x,
    y: y0 - pAbs.y,
    w: x1 - x0,
    h: y1 - y0,
    order,
    ...(type !== "group" ? { fills: [], clip: false } : {}),
  });
  d.put(g);
  same
    .sort((a, b) => a.order - b.order)
    .forEach((n, i) => {
      const a = absPos(d.doc, n.id, resolved);
      d.patch(n.id, { parent: g.id, x: a.x - x0, y: a.y - y0, order: i + 1 });
    });
  return g.id;
}

/** Moves a container's children out to its parent and removes it. */
export function unwrap(d: Draft, id: string, resolved: Map<string, RNode>) {
  const g = d.get(id);
  if (!g) return [];
  const kids = childrenOf(d.doc, id, g.page);
  const pAbs = g.parent ? absPos(d.doc, g.parent, resolved) : { x: 0, y: 0 };
  kids.forEach((k, i) => {
    const a = absPos(d.doc, k.id, resolved);
    d.patch(k.id, { parent: g.parent, x: a.x - pAbs.x, y: a.y - pAbs.y, order: g.order + (i + 1) / (kids.length + 1) });
  });
  d.remove(id);
  return kids.map((k) => k.id);
}

/** Deletes layers and everything inside them. Instances of a deleted component keep their last look (detached). */
export function removeTrees(d: Draft, ids: string[], resolvedAll?: Map<string, RNode>) {
  const idx = childIndex(d.doc);
  const gone = new Set<string>();
  for (const id of ids) {
    if (!d.get(id)) continue;
    gone.add(id);
    for (const c of descendants(d.doc, id, idx)) gone.add(c.id);
  }
  // Instances of components being deleted: detach them first so they don't go blank.
  for (const n of Object.values(d.doc.nodes)) {
    if (n.type === "instance" && n.componentId && gone.has(n.componentId) && !gone.has(n.id)) {
      const r = resolvedAll?.get(n.id);
      if (r) detach(d, n.id, r);
    }
  }
  for (const id of gone) d.remove(id);
}

/** Turns an instance into a plain frame with real copies of what it showed. */
export function detach(d: Draft, instanceId: string, r: RNode) {
  const inst = d.get(instanceId);
  if (!inst || inst.type !== "instance") return;
  const page = inst.page;
  const make = (rn: RNode, parent: string) => {
    rn.children.forEach((c, i) => {
      const n: DNode = {
        ...stripResolved(c),
        id: uid(),
        parent,
        page,
        order: i + 1,
      };
      if (n.type === "text" && n.text) n.text = { ...n.text };
      if (n.type === "instance" && c.okey !== undefined) {
        // A nested instance stays an instance (its content comes from its component, so no
        // child rows); the outer overrides that reached into it move onto it.
        const pre = `${c.okey}/`;
        const o = { ...(n.overrides ?? {}) };
        for (const [k, v] of Object.entries(inst.overrides ?? {})) if (k.startsWith(pre)) o[k.slice(pre.length)] = { ...(o[k.slice(pre.length)] ?? {}), ...v };
        n.overrides = o;
        d.put(n);
        return;
      }
      d.put(n);
      make(c, n.id);
    });
  };
  d.patch(instanceId, {
    type: "frame",
    name: inst.name,
    componentId: undefined,
    overrides: undefined,
    propValues: undefined,
    fills: r.fills,
    strokes: r.strokes,
    radius: r.radius,
    effects: r.effects,
    layout: r.layout ?? null,
    clip: r.clip ?? true,
  });
  make(r, instanceId);
}

export function stripResolved(r: RNode): DNode {
  const { rid: _rid, src: _src, okey: _okey, inst: _inst, children: _c, ax: _ax, ay: _ay, tl: _tl, ...n } = r;
  return n as DNode;
}

/** Makes a component from layers: a lone frame becomes one, anything else gets wrapped. */
export function makeComponent(d: Draft, ids: string[], resolved: Map<string, RNode>): string | null {
  if (ids.length === 1) {
    const n = d.get(ids[0]!);
    if (n && (n.type === "frame" || n.type === "group")) {
      d.patch(n.id, { type: "component", clip: n.type === "group" ? false : n.clip, props: n.props ?? [] });
      return n.id;
    }
  }
  const id = wrap(d, ids, "component", resolved);
  if (id) d.patch(id, { props: [] });
  return id;
}

/** A new instance of a component at (x, y) under `parent`. */
export function makeInstance(doc: DesignDoc, componentId: string, page: string, parent: string | null, x: number, y: number): DNode | null {
  const c = doc.nodes[componentId];
  if (!c || c.type !== "component") return null;
  return makeNode("instance", page, parent, {
    name: c.name,
    componentId,
    x,
    y,
    w: c.w,
    h: c.h,
    sizing: c.sizing,
    overrides: {},
    propValues: {},
    order: topOrder(doc, parent, page),
  });
}

/** Resizes a container and moves / stretches its children by their constraints (no auto layout). */
export function resizeWithConstraints(d: Draft, id: string, next: { x: number; y: number; w: number; h: number }) {
  const n = d.get(id);
  if (!n) return;
  if (isContainer(n.type) && !n.layout && n.type !== "group" && n.type !== "instance") {
    for (const c of childrenOf(d.doc, id, n.page)) {
      const moved = applyConstraints({ x: c.x, y: c.y, w: c.w, h: c.h, constraints: c.constraints }, n.w, n.h, next.w, next.h);
      if (moved.x !== c.x || moved.y !== c.y || moved.w !== c.w || moved.h !== c.h) {
        if (moved.w !== c.w || moved.h !== c.h) resizeWithConstraints(d, c.id, { x: moved.x, y: moved.y, w: moved.w, h: moved.h });
        d.patch(c.id, { x: moved.x, y: moved.y, w: moved.w, h: moved.h });
      }
    }
  } else if (n.type === "group") {
    // Groups scale what's inside.
    const sx = n.w ? next.w / n.w : 1;
    const sy = n.h ? next.h / n.h : 1;
    for (const c of childrenOf(d.doc, id, n.page)) {
      const nx = { x: c.x * sx, y: c.y * sy, w: Math.max(1, c.w * sx), h: Math.max(0, c.h * sy) };
      resizeWithConstraints(d, c.id, nx);
      d.patch(c.id, nx);
      if (c.points?.length) d.patch(c.id, { points: c.points.map((p) => scalePt(p, sx, sy)) });
    }
  }
  if (n.points?.length && n.w && n.h) {
    const sx = next.w / n.w;
    const sy = n.h ? next.h / n.h : 1;
    d.patch(id, { points: n.points.map((p) => scalePt(p, sx, sy)) });
  }
  if (n.type === "text" && n.text && n.text.resize === "auto-width" && next.w !== n.w) {
    d.patch(id, { text: { ...n.text, resize: "auto-height" } });
  }
  d.patch(id, next);
}

function scalePt<P extends { x: number; y: number; in?: { x: number; y: number }; out?: { x: number; y: number } }>(p: P, sx: number, sy: number): P {
  return {
    ...p,
    x: p.x * sx,
    y: p.y * sy,
    in: p.in ? { x: p.in.x * sx, y: p.in.y * sy } : undefined,
    out: p.out ? { x: p.out.x * sx, y: p.out.y * sy } : undefined,
  };
}

/** Nodes referencing a removed style / token keep their last value. */
export function detachStyle(d: Draft, styleId: string) {
  for (const n of Object.values(d.doc.nodes)) {
    let changed = false;
    const fills = n.fills.map((f) => {
      if (f.type === "solid" && f.styleId === styleId) {
        changed = true;
        const { styleId: _s, ...rest } = f;
        return rest;
      }
      return f;
    });
    const strokes = n.strokes.map((s) => {
      if (s.styleId === styleId) {
        changed = true;
        const { styleId: _s, ...rest } = s;
        return rest;
      }
      return s;
    });
    if (changed) d.patch(n.id, { fills, strokes });
    if (n.text?.styleId === styleId) d.patch(n.id, { text: { ...n.text, styleId: undefined } });
    if (n.radiusToken === styleId) d.patch(n.id, { radiusToken: undefined });
    if (n.layout && (n.layout.gapToken === styleId || n.layout.paddingToken === styleId))
      d.patch(n.id, {
        layout: { ...n.layout, gapToken: n.layout.gapToken === styleId ? undefined : n.layout.gapToken, paddingToken: n.layout.paddingToken === styleId ? undefined : n.layout.paddingToken },
      });
  }
}

/** Layers whose props can be edited for a given resolved node (instances edit overrides on the root). */
export function isVirtual(rid: string) {
  return rid.includes("/");
}
