import { textBox, type TextLayout } from "./text";
import type { DesignDoc, DNode, AutoLayout, Override, Rect } from "./types";
import { OVERRIDABLE } from "./types";

// -----------------------------------------------------------------------------
// The resolved tree: what's actually drawn. Instances expand into virtual
// copies of their component (with overrides and property values applied),
// styles and tokens turn into values, and auto layout places children.
// Everything that draws or measures (canvas, export, prototype, inspect)
// reads this tree, never the raw rows.
//
// Virtual ids: a layer inside an instance is "<instance id>/<key>", where key
// is the component layer's id ("<nested instance's layer>/<id>" one level in).
// -----------------------------------------------------------------------------

export interface RNode extends DNode {
  /** Id in the resolved tree (virtual inside instances). */
  rid: string;
  /** The real row behind it: itself, or the instance it's inside. */
  src: string;
  /** Inside an instance: the key overrides use. */
  okey?: string;
  /** Inside an instance: that instance's real id. */
  inst?: string;
  children: RNode[];
  /** Absolute top-left on the page (rotation of ancestors not applied). */
  ax: number;
  ay: number;
  tl?: TextLayout;
}

export function sortedChildren(doc: DesignDoc, parent: string | null, page: string): DNode[] {
  const out: DNode[] = [];
  for (const n of Object.values(doc.nodes)) if (n.parent === parent && n.page === page) out.push(n);
  out.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  return out;
}

/** Children lists for a whole doc in one pass (parent id or "page:<id>" for roots). */
export function childIndex(doc: DesignDoc): Map<string, DNode[]> {
  const m = new Map<string, DNode[]>();
  for (const n of Object.values(doc.nodes)) {
    const k = n.parent ?? `page:${n.page}`;
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(n);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
  return m;
}

function tokenValue(doc: DesignDoc, id: string | undefined): number | undefined {
  if (!id) return undefined;
  const t = doc.data.tokens.find((x) => x.id === id);
  return t && typeof t.value === "number" ? t.value : t ? Number(t.value) || undefined : undefined;
}

/** Applies styles and token bindings to a node's own values. */
function applyStyles(doc: DesignDoc, n: DNode): DNode {
  let out = n;
  const colors = doc.data.colors;
  if (n.fills.some((f) => f.type === "solid" && f.styleId) || n.strokes.some((s) => s.styleId)) {
    out = {
      ...out,
      fills: n.fills.map((f) => {
        if (f.type !== "solid" || !f.styleId) return f;
        const st = colors.find((c) => c.id === f.styleId);
        return st ? { ...f, color: st.color } : f;
      }),
      strokes: n.strokes.map((s) => {
        if (!s.styleId) return s;
        const st = colors.find((c) => c.id === s.styleId);
        return st ? { ...s, color: st.color } : s;
      }),
    };
  }
  if (n.text?.styleId) {
    const ts = doc.data.textStyles.find((s) => s.id === n.text!.styleId);
    if (ts)
      out = {
        ...out,
        text: {
          ...n.text,
          fontFamily: ts.fontFamily,
          fontWeight: ts.fontWeight,
          fontSize: ts.fontSize,
          lineHeight: ts.lineHeight ?? n.text.lineHeight,
          letterSpacing: ts.letterSpacing ?? n.text.letterSpacing,
        },
      };
  }
  const r = tokenValue(doc, n.radiusToken);
  if (r !== undefined) out = { ...out, radius: r };
  if (n.layout && (n.layout.gapToken || n.layout.paddingToken)) {
    const g = tokenValue(doc, n.layout.gapToken);
    const p = tokenValue(doc, n.layout.paddingToken);
    out = {
      ...out,
      layout: {
        ...n.layout,
        gap: g ?? n.layout.gap,
        padding: p !== undefined ? { t: p, r: p, b: p, l: p } : n.layout.padding,
      },
    };
  }
  return out;
}

function applyOverride(n: DNode, o: Override | undefined): DNode {
  if (!o) return n;
  const out: DNode = { ...n };
  for (const k of OVERRIDABLE) {
    if (!(k in o)) continue;
    if (k === "content") {
      if (out.text && typeof o.content === "string") out.text = { ...out.text, content: o.content };
    } else (out as unknown as Record<string, unknown>)[k] = (o as Record<string, unknown>)[k];
  }
  return out;
}

const MAX_DEPTH = 24;

/** Build the resolved tree of one page (laid out). */
export function resolvePage(doc: DesignDoc, page: string, idx = childIndex(doc)): RNode[] {
  const roots = (idx.get(`page:${page}`) ?? []).map((n) => build(doc, idx, n, null, 0));
  for (const r of roots) {
    layoutTree(r);
    layoutTree(r); // second pass settles wrapped text inside fill-width layers
    absolutes(r, 0, 0);
  }
  return roots;
}

/** Resolve a single subtree (exports of one layer, prototype frames). */
export function resolveNode(doc: DesignDoc, id: string, idx = childIndex(doc)): RNode | null {
  const n = doc.nodes[id];
  if (!n) return null;
  const r = build(doc, idx, n, null, 0);
  layoutTree(r);
  layoutTree(r);
  absolutes(r, 0, 0);
  return r;
}

interface InstCtx {
  inst: string; // real instance id
  prefix: string; // key prefix inside the instance
  overrides: Record<string, Override>;
  props: Record<string, Override>; // property values mapped to layer keys
}

function build(doc: DesignDoc, idx: Map<string, DNode[]>, raw: DNode, ctx: InstCtx | null, depth: number): RNode {
  const key = ctx ? ctx.prefix + raw.id : undefined;
  let n = raw;
  if (ctx && key !== undefined) {
    n = applyOverride(n, ctx.props[key]);
    n = applyOverride(n, ctx.overrides[key]);
  }
  // After overrides, so overridden paints that use a colour style follow it.
  n = applyStyles(doc, n);
  const rn: RNode = {
    ...n,
    rid: ctx ? `${ctx.inst}/${key}` : n.id,
    src: ctx ? ctx.inst : n.id,
    okey: key,
    inst: ctx?.inst,
    children: [],
    ax: 0,
    ay: 0,
  };
  if (depth > MAX_DEPTH) return rn;

  if (n.type === "instance") {
    const comp = n.componentId ? doc.nodes[n.componentId] : undefined;
    if (comp && comp.type === "component") {
      // The instance looks like its component, except what it overrides.
      const master = applyStyles(doc, comp);
      // Its own box: its "" override, then (nested) what the outer instance set on it.
      const own = n.overrides ?? {};
      const rootOs = [own[""], ctx && key !== undefined ? ctx.overrides[key] : undefined];
      Object.assign(rn, {
        fills: master.fills,
        strokes: master.strokes,
        radius: master.radius,
        effects: master.effects,
        layout: master.layout,
        clip: master.clip,
        opacity: n.opacity,
      });
      if (rootOs.some(Boolean)) {
        for (const o of rootOs) if (o) Object.assign(rn, applyOverride(rn, o));
        const styled = applyStyles(doc, { ...rn, radiusToken: undefined, layout: null, text: undefined });
        rn.fills = styled.fills;
        rn.strokes = styled.strokes;
      }
      const props: Record<string, Override> = {};
      for (const p of comp.props ?? []) {
        const v = n.propValues?.[p.id] ?? p.default;
        const k = (ctx ? `${key}/` : "") + p.target;
        props[k] = { ...(props[k] ?? {}), ...(p.kind === "text" ? { content: String(v) } : { visible: !!v }) };
      }
      // Nested instance inside an instance: its overrides live in the outer one, under its key
      // (on top of the ones it has itself inside the component).
      let nested = ctx?.overrides ?? {};
      if (ctx && Object.keys(own).some((k) => k)) {
        nested = { ...nested };
        for (const [k, o] of Object.entries(own)) if (k) nested[`${key}/${k}`] = { ...o, ...(ctx.overrides[`${key}/${k}`] ?? {}) };
      }
      const inner: InstCtx = ctx
        ? { inst: ctx.inst, prefix: `${key}/`, overrides: nested, props: { ...props, ...ctx.props } }
        : { inst: n.id, prefix: "", overrides: n.overrides ?? {}, props };
      // Scale content when the instance has another size and the component no auto layout.
      rn.children = (idx.get(comp.id) ?? []).map((c) => build(doc, idx, c, inner, depth + 1));
      if (!master.layout) {
        const sx = comp.w ? n.w / comp.w : 1;
        const sy = comp.h ? n.h / comp.h : 1;
        if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) for (const c of rn.children) applyConstraints(c, comp.w, comp.h, n.w, n.h);
      }
    }
    return rn;
  }
  rn.children = (idx.get(raw.id) ?? []).map((c) => build(doc, idx, c, ctx, depth + 1));
  return rn;
}

/** Moves / resizes a child for its constraints when its parent goes from (pw, ph) to (nw, nh). */
export function applyConstraints<T extends Pick<DNode, "x" | "y" | "w" | "h" | "constraints">>(c: T, pw: number, ph: number, nw: number, nh: number): T {
  const con = c.constraints ?? { h: "left", v: "top" };
  const dx = nw - pw;
  const dy = nh - ph;
  switch (con.h) {
    case "right":
      c.x += dx;
      break;
    case "left-right":
      c.w = Math.max(1, c.w + dx);
      break;
    case "center":
      c.x += dx / 2;
      break;
    case "scale":
      if (pw > 0) {
        c.x = (c.x * nw) / pw;
        c.w = Math.max(1, (c.w * nw) / pw);
      }
      break;
  }
  switch (con.v) {
    case "bottom":
      c.y += dy;
      break;
    case "top-bottom":
      c.h = Math.max(1, c.h + dy);
      break;
    case "center":
      c.y += dy / 2;
      break;
    case "scale":
      if (ph > 0) {
        c.y = (c.y * nh) / ph;
        c.h = Math.max(1, (c.h * nh) / ph);
      }
      break;
  }
  return c;
}

// ------------------------------------------------------------- auto layout --
function sizingOf(n: DNode) {
  return n.sizing ?? { h: "fixed" as const, v: "fixed" as const };
}

function inFlow(c: RNode) {
  return c.visible !== false && !c.absolute;
}

/** Hug sizes bottom-up, text boxes included. */
function hug(n: RNode) {
  for (const c of n.children) hug(c);
  if (n.type === "text" && n.text) {
    const tb = textBox(n.text, n.w, n.h);
    n.w = tb.w;
    n.h = tb.h;
    n.tl = tb.layout;
    return;
  }
  const L = n.layout;
  if (!L) {
    // Groups wrap their children.
    if (n.type === "group" && n.children.length) fitGroup(n);
    return;
  }
  const s = sizingOf(n);
  const flow = n.children.filter(inFlow);
  const content = contentSize(L, flow, s.h === "hug" ? Infinity : n.w - L.padding.l - L.padding.r);
  if (s.h === "hug") n.w = Math.max(0, content.w + L.padding.l + L.padding.r);
  if (s.v === "hug") n.h = Math.max(0, content.h + L.padding.t + L.padding.b);
}

/** Groups take the bounds of their children (children stay put on the page). */
function fitGroup(n: RNode) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of n.children) {
    if (c.visible === false) continue;
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + c.w);
    y1 = Math.max(y1, c.y + c.h);
  }
  if (!isFinite(x0)) return;
  for (const c of n.children) {
    c.x -= x0;
    c.y -= y0;
  }
  n.x += x0;
  n.y += y0;
  n.w = x1 - x0;
  n.h = y1 - y0;
}

function contentSize(L: AutoLayout, flow: RNode[], innerMain: number): { w: number; h: number } {
  if (!flow.length) return { w: 0, h: 0 };
  const horiz = L.mode === "horizontal";
  if (horiz && L.wrap && isFinite(innerMain)) {
    const rows = wrapRows(flow, innerMain, L.gap);
    const rg = L.rowGap ?? L.gap;
    let w = 0;
    let h = 0;
    rows.forEach((row, i) => {
      w = Math.max(w, row.reduce((s, c) => s + c.w, 0) + L.gap * (row.length - 1));
      h += Math.max(...row.map((c) => c.h)) + (i ? rg : 0);
    });
    return { w, h };
  }
  let main = 0;
  let cross = 0;
  for (const c of flow) {
    main += horiz ? c.w : c.h;
    cross = Math.max(cross, horiz ? c.h : c.w);
  }
  main += L.gap * (flow.length - 1);
  return horiz ? { w: main, h: cross } : { w: cross, h: main };
}

function wrapRows(flow: RNode[], inner: number, gap: number): RNode[][] {
  const rows: RNode[][] = [];
  let row: RNode[] = [];
  let used = 0;
  for (const c of flow) {
    const add = (row.length ? gap : 0) + c.w;
    if (row.length && used + add > inner + 0.01) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length ? gap : 0) + c.w;
    row.push(c);
  }
  if (row.length) rows.push(row);
  return rows;
}

/** Places children top-down: fill sizes, stretch, alignment, wrap. */
function place(n: RNode) {
  const L = n.layout;
  if (L) placeLayout(n, L);
  for (const c of n.children) {
    // A child whose width changed (fill / stretch) re-wraps its text.
    if (c.type === "text" && c.text && c.text.resize !== "auto-width") {
      const tb = textBox(c.text, c.w, c.h);
      if (c.text.resize === "auto-height") c.h = tb.h;
      c.tl = tb.layout;
    }
    place(c);
  }
}

function placeLayout(n: RNode, L: AutoLayout) {
  const horiz = L.mode === "horizontal";
  const flow = n.children.filter(inFlow);
  const p = L.padding;
  const innerW = Math.max(0, n.w - p.l - p.r);
  const innerH = Math.max(0, n.h - p.t - p.b);
  const innerMain = horiz ? innerW : innerH;
  const innerCross = horiz ? innerH : innerW;
  const mainOf = (c: RNode) => (horiz ? c.w : c.h);
  const setMain = (c: RNode, v: number) => (horiz ? (c.w = v) : (c.h = v));
  const setCross = (c: RNode, v: number) => (horiz ? (c.h = v) : (c.w = v));
  const crossOf = (c: RNode) => (horiz ? c.h : c.w);
  const parentHugMain = (horiz ? sizingOf(n).h : sizingOf(n).v) === "hug";

  // Cross-axis fill / stretch first (affects text heights).
  for (const c of flow) {
    const cs = horiz ? sizingOf(c).v : sizingOf(c).h;
    if (cs === "fill" || L.align === "stretch") setCross(c, innerCross);
  }

  if (horiz && L.wrap) {
    const rows = wrapRows(flow, innerMain, L.gap);
    const rg = L.rowGap ?? L.gap;
    let y = p.t;
    for (const row of rows) {
      const rowH = Math.max(...row.map((c) => c.h));
      const used = row.reduce((s, c) => s + c.w, 0) + L.gap * (row.length - 1);
      let x = p.l + startOffset(L.justify, innerMain - used, row.length);
      const gap = L.justify === "space-between" && row.length > 1 ? (innerMain - row.reduce((s, c) => s + c.w, 0)) / (row.length - 1) : L.gap;
      for (const c of row) {
        c.x = x;
        c.y = y + crossOffset(L.align, rowH - c.h);
        x += c.w + gap;
      }
      y += rowH + rg;
    }
    return;
  }

  // Main-axis fill shares what's left.
  const fills = flow.filter((c) => (horiz ? sizingOf(c).h : sizingOf(c).v) === "fill");
  if (fills.length && !parentHugMain) {
    const fixed = flow.filter((c) => !fills.includes(c)).reduce((s, c) => s + mainOf(c), 0);
    const gaps = L.justify === "space-between" ? 0 : L.gap * (flow.length - 1);
    const each = Math.max(1, (innerMain - fixed - gaps) / fills.length);
    for (const c of fills) setMain(c, each);
  }

  const total = flow.reduce((s, c) => s + mainOf(c), 0);
  let gap = L.gap;
  let pos: number;
  if (L.justify === "space-between" && flow.length > 1) {
    gap = Math.max(0, (innerMain - total) / (flow.length - 1));
    pos = 0;
  } else pos = startOffset(L.justify, innerMain - total - L.gap * (flow.length - 1), flow.length);
  const base = horiz ? p.l : p.t;
  const crossBase = horiz ? p.t : p.l;
  for (const c of flow) {
    const m = base + pos;
    const x = crossBase + crossOffset(L.align, innerCross - crossOf(c));
    if (horiz) {
      c.x = m;
      c.y = x;
    } else {
      c.y = m;
      c.x = x;
    }
    pos += mainOf(c) + gap;
  }
}

function startOffset(j: AutoLayout["justify"], free: number, _n: number) {
  if (j === "center") return free / 2;
  if (j === "end") return free;
  return 0;
}

function crossOffset(a: AutoLayout["align"], free: number) {
  if (a === "center") return free / 2;
  if (a === "end") return free;
  return 0;
}

function layoutTree(r: RNode) {
  hug(r);
  place(r);
  // Hug parents may have grown after their children filled / wrapped: settle once more.
  hug(r);
  place(r);
}

function absolutes(n: RNode, px: number, py: number) {
  n.ax = px + n.x;
  n.ay = py + n.y;
  for (const c of n.children) absolutes(c, n.ax, n.ay);
}

// ------------------------------------------------------------------ queries --
export function walk(nodes: RNode[], fn: (n: RNode, parent: RNode | null) => boolean | void, parent: RNode | null = null) {
  for (const n of nodes) {
    if (fn(n, parent) === false) continue;
    walk(n.children, fn, n);
  }
}

/** rid -> resolved node, and parent links, for a page. */
export function indexResolved(roots: RNode[]) {
  const byId = new Map<string, RNode>();
  const parentOf = new Map<string, RNode | null>();
  walk(roots, (n, p) => {
    byId.set(n.rid, n);
    parentOf.set(n.rid, p);
  });
  return { byId, parentOf };
}

export function absRect(n: RNode): Rect {
  return { x: n.ax, y: n.ay, w: n.w, h: n.h };
}

export function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
