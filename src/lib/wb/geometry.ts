import type { ConnectorData, ConnectorEnd, ConnectorKind, Geom, Side, WbItem } from "./types";
import { num } from "./types";

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RAD = Math.PI / 180;

export function rotatePoint(p: Pt, c: Pt, deg: number): Pt {
  if (!deg) return p;
  const a = deg * RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Axis-aligned box around a (possibly rotated) item. */
export function geomBounds(g: Geom): Rect {
  if (!g.rotation) return { x: g.x, y: g.y, w: g.w, h: g.h };
  const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  const pts = [
    { x: g.x, y: g.y },
    { x: g.x + g.w, y: g.y },
    { x: g.x + g.w, y: g.y + g.h },
    { x: g.x, y: g.y + g.h },
  ].map((p) => rotatePoint(p, c, g.rotation));
  return boundsOfPoints(pts);
}

export function boundsOfPoints(pts: Pt[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRects(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const intersects = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

export const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

export function normRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Point inside a rotated item box. */
export function pointInGeom(g: Geom, p: Pt, pad = 0): boolean {
  const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  const q = rotatePoint(p, c, -g.rotation);
  return q.x >= g.x - pad && q.x <= g.x + g.w + pad && q.y >= g.y - pad && q.y <= g.y + g.h + pad;
}

export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  let t = len ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Pt, pts: Pt[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i - 1]!, pts[i]!));
  return d;
}

// --------------------------------------------------------------- connectors --
const SIDE_DIR: Record<Side, Pt> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export function sidePoint(g: Geom, side: Side): Pt {
  const p =
    side === "top"
      ? { x: g.x + g.w / 2, y: g.y }
      : side === "bottom"
        ? { x: g.x + g.w / 2, y: g.y + g.h }
        : side === "left"
          ? { x: g.x, y: g.y + g.h / 2 }
          : { x: g.x + g.w, y: g.y + g.h / 2 };
  return rotatePoint(p, center(g), g.rotation);
}

function rotateDir(d: Pt, deg: number): Pt {
  return rotatePoint(d, { x: 0, y: 0 }, deg);
}

/** The side of a box facing a point. */
export function facingSide(g: Geom, toward: Pt): Side {
  const c = center(g);
  const q = rotatePoint(toward, c, -g.rotation);
  const dx = (q.x - c.x) / Math.max(g.w, 1);
  const dy = (q.y - c.y) / Math.max(g.h, 1);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** Nearest side to a point (for dropping a connector end on an item). */
export function nearestSide(g: Geom, p: Pt): Side {
  let best: Side = "top";
  let bd = Infinity;
  for (const s of ["top", "right", "bottom", "left"] as Side[]) {
    const sp = sidePoint(g, s);
    const d = Math.hypot(sp.x - p.x, sp.y - p.y);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

export interface ResolvedEnd {
  p: Pt;
  /** Unit direction the line leaves this end in (outward normal), or null for a free end. */
  dir: Pt | null;
  attached: boolean;
}

type GeomOf = (id: string) => Geom | null;

function endBase(end: ConnectorEnd | undefined, geomOf: GeomOf): { g: Geom | null; free: Pt } {
  const g = end?.id ? geomOf(end.id) : null;
  return { g, free: { x: num(end?.x), y: num(end?.y) } };
}

/** Rough centre of an end, used to pick facing sides. */
function endCenter(end: ConnectorEnd | undefined, geomOf: GeomOf): Pt {
  const { g, free } = endBase(end, geomOf);
  return g ? center(g) : free;
}

export function resolveEnd(end: ConnectorEnd | undefined, other: ConnectorEnd | undefined, geomOf: GeomOf): ResolvedEnd {
  const { g, free } = endBase(end, geomOf);
  if (!g) return { p: free, dir: null, attached: false };
  if (end?.side && end.side !== "auto") {
    return { p: sidePoint(g, end.side), dir: rotateDir(SIDE_DIR[end.side], g.rotation), attached: true };
  }
  if (end?.fx != null && end?.fy != null && !end.side) {
    const p = rotatePoint({ x: g.x + end.fx * g.w, y: g.y + end.fy * g.h }, center(g), g.rotation);
    const s = facingSide(g, endCenter(other, geomOf));
    return { p, dir: rotateDir(SIDE_DIR[s], g.rotation), attached: true };
  }
  const s = facingSide(g, endCenter(other, geomOf));
  return { p: sidePoint(g, s), dir: rotateDir(SIDE_DIR[s], g.rotation), attached: true };
}

function axisToward(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? 1 : -1, y: 0 };
  return { x: 0, y: dy >= 0 ? 1 : -1 };
}

const snapAxis = (d: Pt): Pt => (Math.abs(d.x) >= Math.abs(d.y) ? { x: Math.sign(d.x) || 1, y: 0 } : { x: 0, y: Math.sign(d.y) || 1 });

export interface ConnectorGeometry {
  d: string;
  /** Polyline approximation (hit testing, bounds, label placement). */
  pts: Pt[];
  start: Pt;
  end: Pt;
  /** Angles (radians) the line arrives at each end, pointing outward. */
  startAngle: number;
  endAngle: number;
  mid: Pt;
  bounds: Rect;
}

function cubicAt(p0: Pt, c0: Pt, c1: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c0.x + 3 * u * t * t * c1.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c0.y + 3 * u * t * t * c1.y + t * t * t * p1.y,
  };
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  // Drop middle points of straight runs.
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01)) {
      out.splice(i, 1);
    }
  }
  return out;
}

function elbowRoute(p0: Pt, d0: Pt, p1: Pt, d1: Pt): Pt[] {
  const G = 24;
  const s = { x: p0.x + d0.x * G, y: p0.y + d0.y * G };
  const e = { x: p1.x + d1.x * G, y: p1.y + d1.y * G };
  const h0 = d0.x !== 0;
  const h1 = d1.x !== 0;
  let mids: Pt[];
  if (h0 && h1) {
    const mx = (s.x + e.x) / 2;
    mids = [{ x: mx, y: s.y }, { x: mx, y: e.y }];
  } else if (!h0 && !h1) {
    const my = (s.y + e.y) / 2;
    mids = [{ x: s.x, y: my }, { x: e.x, y: my }];
  } else if (h0) {
    mids = [{ x: e.x, y: s.y }];
  } else {
    mids = [{ x: s.x, y: e.y }];
  }
  return dedupe([p0, s, ...mids, e, p1]);
}

/** Rounded-corner path through an orthogonal polyline. */
function roundedPath(pts: Pt[], r = 10): string {
  if (pts.length < 3) return `M${pts.map((p) => `${p.x},${p.y}`).join(" L")}`;
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const c = pts[i + 1]!;
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const p = { x: b.x - ((b.x - a.x) / (l1 || 1)) * rr, y: b.y - ((b.y - a.y) / (l1 || 1)) * rr };
    const q = { x: b.x + ((c.x - b.x) / (l2 || 1)) * rr, y: b.y + ((c.y - b.y) / (l2 || 1)) * rr };
    d += ` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${last.x},${last.y}`;
}

export function connectorGeometry(data: ConnectorData, geomOf: GeomOf): ConnectorGeometry {
  const a = resolveEnd(data.start, data.end, geomOf);
  const b = resolveEnd(data.end, data.start, geomOf);
  const kind: ConnectorKind = data.kind ?? "curved";
  const p0 = a.p;
  const p1 = b.p;
  let pts: Pt[];
  let d: string;
  if (kind === "straight") {
    pts = [p0, p1];
    d = `M${p0.x},${p0.y} L${p1.x},${p1.y}`;
  } else if (kind === "elbow") {
    const d0 = a.dir ? snapAxis(a.dir) : axisToward(p0, p1);
    const d1 = b.dir ? snapAxis(b.dir) : axisToward(p1, p0);
    pts = elbowRoute(p0, d0, p1, d1);
    d = roundedPath(pts);
  } else {
    const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const k = Math.max(30, dist * 0.4);
    const d0 = a.dir ?? (b.dir ? { x: 0, y: 0 } : { x: 0, y: 0 });
    const d1 = b.dir ?? { x: 0, y: 0 };
    const c0 = { x: p0.x + d0.x * k, y: p0.y + d0.y * k };
    const c1 = { x: p1.x + d1.x * k, y: p1.y + d1.y * k };
    d = `M${p0.x},${p0.y} C${c0.x},${c0.y} ${c1.x},${c1.y} ${p1.x},${p1.y}`;
    pts = [];
    for (let i = 0; i <= 24; i++) pts.push(cubicAt(p0, c0, c1, p1, i / 24));
  }
  const n = pts.length;
  const startAngle = Math.atan2(pts[0]!.y - pts[Math.min(1, n - 1)]!.y, pts[0]!.x - pts[Math.min(1, n - 1)]!.x);
  const endAngle = Math.atan2(pts[n - 1]!.y - pts[Math.max(n - 2, 0)]!.y, pts[n - 1]!.x - pts[Math.max(n - 2, 0)]!.x);
  return { d, pts, start: p0, end: p1, startAngle, endAngle, mid: pointAlong(pts, 0.5), bounds: boundsOfPoints(pts) };
}

/** Point at a fraction of a polyline's length. */
export function pointAlong(pts: Pt[], t: number): Pt {
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  let want = total * t;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (want <= l) {
      const k = l ? want / l : 0;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
    want -= l;
  }
  return pts[pts.length - 1]!;
}

/** Arrow-head path at a line end. `angle` points outward along the line. */
export function capPath(cap: string, p: Pt, angle: number, width: number): { d: string; filled: boolean } | null {
  const s = 6 + width * 2.2;
  const at = (dx: number, dy: number) => {
    const c = Math.cos(angle);
    const n = Math.sin(angle);
    return { x: p.x + dx * c - dy * n, y: p.y + dx * n + dy * c };
  };
  const P = (q: Pt) => `${q.x},${q.y}`;
  switch (cap) {
    case "arrow": {
      const a = at(-s, -s * 0.6);
      const b = at(-s, s * 0.6);
      return { d: `M${P(a)} L${P(p)} L${P(b)}`, filled: false };
    }
    case "triangle": {
      const a = at(-s, -s * 0.55);
      const b = at(-s, s * 0.55);
      return { d: `M${P(p)} L${P(a)} L${P(b)} Z`, filled: true };
    }
    case "circle": {
      const r = s * 0.42;
      const c = at(-r, 0);
      return { d: `M${c.x - r},${c.y} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`, filled: true };
    }
    case "diamond": {
      const a = at(-s * 0.5, -s * 0.45);
      const b = at(-s, 0);
      const c = at(-s * 0.5, s * 0.45);
      return { d: `M${P(p)} L${P(a)} L${P(b)} L${P(c)} Z`, filled: true };
    }
    case "bar": {
      const a = at(0, -s * 0.6);
      const b = at(0, s * 0.6);
      return { d: `M${P(a)} L${P(b)}`, filled: false };
    }
    default:
      return null;
  }
}

// ----------------------------------------------------------------- snapping --
export interface Guide {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
}

/**
 * Snap a moving box to the edges / centres of nearby boxes. Returns the
 * correction to add and the guide lines to draw.
 */
export function snapBox(box: Rect, others: Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = [box.x, box.x + box.w / 2, box.x + box.w];
  const ys = [box.y, box.y + box.h / 2, box.y + box.h];
  let bestX: { d: number; at: number } | null = null;
  let bestY: { d: number; at: number } | null = null;
  for (const o of others) {
    const oxs = [o.x, o.x + o.w / 2, o.x + o.w];
    const oys = [o.y, o.y + o.h / 2, o.y + o.h];
    for (const x of xs)
      for (const ox of oxs) {
        const d = ox - x;
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: ox };
      }
    for (const y of ys)
      for (const oy of oys) {
        const d = oy - y;
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: oy };
      }
  }
  const dx = bestX?.d ?? 0;
  const dy = bestY?.d ?? 0;
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const guides: Guide[] = [];
  if (bestX) {
    const hits = others.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - bestX!.at) < 0.5));
    const all = [moved, ...hits];
    guides.push({ axis: "x", at: bestX.at, from: Math.min(...all.map((r) => r.y)), to: Math.max(...all.map((r) => r.y + r.h)) });
  }
  if (bestY) {
    const hits = others.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - bestY!.at) < 0.5));
    const all = [moved, ...hits];
    guides.push({ axis: "y", at: bestY.at, from: Math.min(...all.map((r) => r.x)), to: Math.max(...all.map((r) => r.x + r.w)) });
  }
  return { dx, dy, guides };
}

// ------------------------------------------------------------------ helpers --
export function itemGeom(it: Pick<WbItem, "x" | "y" | "w" | "h" | "rotation">): Geom {
  return { x: it.x, y: it.y, w: it.w, h: it.h, rotation: it.rotation };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
