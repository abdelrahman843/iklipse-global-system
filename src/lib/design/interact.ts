import type { RNode } from "./layout";
import type { Rect } from "./types";

// -----------------------------------------------------------------------------
// Canvas interaction math, kept pure: which layer a click selects, snapping,
// marquee hits, where a dragged layer lands.
// -----------------------------------------------------------------------------

/** Root-to-leaf chain of resolved layers for a hit rid. */
export function pathTo(rid: string, parentOf: Map<string, RNode | null>, byId: Map<string, RNode>): RNode[] {
  const out: RNode[] = [];
  let cur: RNode | null | undefined = byId.get(rid);
  let guard = 0;
  while (cur && guard++ < 100) {
    out.unshift(cur);
    cur = parentOf.get(cur.rid) ?? null;
  }
  return out;
}

const OPENS = new Set(["frame", "component"]);

/**
 * What a click on `path` selects (Figma rules): inside a top-level frame, its
 * direct child; groups and instances are selected whole until you enter them
 * (double-click, or a selection already inside); Ctrl / Cmd picks the deepest.
 */
export function pickTarget(path: RNode[], selection: string[], deep: boolean, parentOf: Map<string, RNode | null>): RNode | null {
  if (!path.length) return null;
  const visible = path.filter((n) => n.visible !== false);
  if (!visible.length) return null;
  if (deep) {
    // Deepest unlocked layer.
    for (let i = visible.length - 1; i >= 0; i--) if (!visible[i]!.locked) return visible[i]!;
    return null;
  }
  // Containers that are "open": ancestors of something selected, or selected containers' parents.
  const open = new Set<string>();
  for (const id of selection) {
    let p = parentOf.get(id) ?? null;
    while (p) {
      open.add(p.rid);
      p = parentOf.get(p.rid) ?? null;
    }
  }
  let d = 0;
  if (visible.length > 1 && OPENS.has(visible[0]!.type) && visible[0]!.parent === null) d = 1;
  while (d < visible.length - 1 && open.has(visible[d]!.rid)) d++;
  // Locked layers can't be picked on the canvas: go to the nearest unlocked ancestor.
  while (d >= 0 && visible[d]!.locked) d--;
  return d >= 0 ? visible[d]! : null;
}

/** The next layer down the path from a selected one (double-click to enter). */
export function enterTarget(path: RNode[], selected: string): RNode | null {
  const i = path.findIndex((n) => n.rid === selected);
  if (i < 0 || i >= path.length - 1) return null;
  return path[i + 1]!;
}

export function intersects(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function contains(a: Rect, b: Rect) {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Marquee: layers under `scope` (page roots when null) the rectangle touches. */
export function marqueeHits(rect: Rect, scope: RNode[]): string[] {
  return scope.filter((n) => n.visible !== false && !n.locked && intersects(rect, { x: n.ax, y: n.ay, w: n.w, h: n.h })).map((n) => n.rid);
}

export interface Guide {
  x?: number;
  y?: number;
  y0?: number;
  y1?: number;
  x0?: number;
  x1?: number;
}

/**
 * Snap a moving box to other boxes' edges and centres. Returns the offset to
 * add and the guide lines to draw (world coordinates).
 */
export function snapBox(moving: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [moving.x, moving.x + moving.w / 2, moving.x + moving.w];
  const ys = [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
  let bestX: { d: number; at: number; o: Rect } | null = null;
  let bestY: { d: number; at: number; o: Rect } | null = null;
  for (const o of others) {
    const oxs = [o.x, o.x + o.w / 2, o.x + o.w];
    const oys = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const a of xs)
      for (const b of oxs) {
        const d = b - a;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: b, o };
      }
    for (const a of ys)
      for (const b of oys) {
        const d = b - a;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: b, o };
      }
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const guides: Guide[] = [];
  if (bestX) {
    const m = { ...moving, x: moving.x + dx, y: moving.y + dy };
    guides.push({ x: bestX.at, y0: Math.min(m.y, bestX.o.y), y1: Math.max(m.y + m.h, bestX.o.y + bestX.o.h) });
  }
  if (bestY) {
    const m = { ...moving, x: moving.x + dx, y: moving.y + dy };
    guides.push({ y: bestY.at, x0: Math.min(m.x, bestY.o.x), x1: Math.max(m.x + m.w, bestY.o.x + bestY.o.w) });
  }
  return { dx, dy, guides };
}

/** Snap a single point (resize handles, new shapes). */
export function snapPoint(p: { x: number; y: number }, others: Rect[], threshold: number): { x: number; y: number; guides: Guide[] } {
  const r = snapBox({ x: p.x, y: p.y, w: 0, h: 0 }, others, threshold);
  return { x: p.x + r.dx, y: p.y + r.dy, guides: r.guides };
}

/** Deepest frame / component under a point that isn't one of `exclude` (drop targets, new shapes). */
export function containerAt(roots: RNode[], p: { x: number; y: number }, exclude: Set<string>): RNode | null {
  let found: RNode | null = null;
  const visit = (nodes: RNode[]) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]!;
      if (n.visible === false || exclude.has(n.rid) || n.rid.includes("/")) continue;
      if (n.type !== "frame" && n.type !== "component" && n.type !== "group") continue;
      if (p.x >= n.ax && p.x <= n.ax + n.w && p.y >= n.ay && p.y <= n.ay + n.h) {
        if (n.type !== "group") found = n;
        visit(n.children);
        return;
      }
    }
  };
  visit(roots);
  return found;
}

/** Where a dragged layer goes among its auto layout siblings (index in flow order). */
export function flowIndex(parent: RNode, p: { x: number; y: number }, dragged: Set<string>): number {
  const L = parent.layout;
  if (!L) return -1;
  const flow = parent.children.filter((c) => c.visible !== false && !c.absolute && !dragged.has(c.rid));
  const horiz = L.mode === "horizontal";
  for (let i = 0; i < flow.length; i++) {
    const c = flow[i]!;
    const mid = horiz ? c.ax + c.w / 2 : c.ay + c.h / 2;
    if ((horiz ? p.x : p.y) < mid) return i;
  }
  return flow.length;
}

/** Resize a box from a handle. Handles: n, s, e, w, ne, nw, se, sw. */
export function resizeBox(
  start: Rect,
  handle: string,
  dx: number,
  dy: number,
  opts: { keepRatio?: boolean; fromCenter?: boolean },
): Rect {
  let { x, y, w, h } = start;
  const k = opts.fromCenter ? 2 : 1;
  if (handle.includes("e")) w = start.w + dx * k;
  if (handle.includes("w")) {
    w = start.w - dx * k;
    x = start.x + dx;
  }
  if (handle.includes("s")) h = start.h + dy * k;
  if (handle.includes("n")) {
    h = start.h - dy * k;
    y = start.y + dy;
  }
  if (opts.keepRatio && start.w > 0 && start.h > 0) {
    const ratio = start.w / start.h;
    const horizontalOnly = handle === "e" || handle === "w";
    const verticalOnly = handle === "n" || handle === "s";
    if (horizontalOnly) h = w / ratio;
    else if (verticalOnly) w = h * ratio;
    else if (Math.abs(w / start.w) > Math.abs(h / start.h)) h = w / ratio;
    else w = h * ratio;
    if (handle.includes("w")) x = start.x + start.w - w;
    if (handle.includes("n")) y = start.y + start.h - h;
    if (horizontalOnly) y = start.y + (start.h - h) / 2;
    if (verticalOnly) x = start.x + (start.w - w) / 2;
  }
  if (opts.fromCenter) {
    x = start.x + (start.w - w) / 2;
    y = start.y + (start.h - h) / 2;
  }
  // Dragging past the opposite edge flips the box.
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  return { x, y, w: Math.max(1, w), h: Math.max(0, h) };
}

/** Ruler tick spacing (world units) for a zoom level. */
export function tickStep(zoom: number) {
  const target = 80 / zoom;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  return steps.find((s) => s >= target) ?? 100000;
}
