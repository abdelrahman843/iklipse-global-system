import { emptyData, makeNode, shortId, uid } from "./doc";
import { parseColor, toHex } from "./css";
import { layoutText } from "./text";
import type { DesignDoc, DesignFile, DNode, DocData, Interaction, NodeType, Override, Page, Paint, PathPoint, Stroke, TextProps } from "./types";
import { DESIGN_FORMAT, DESIGN_FORMAT_VERSION } from "./types";

// -----------------------------------------------------------------------------
// Import / export of whole documents (the native JSON file format) and SVG
// import.
//
// Native files: toDesignFile writes the current doc; parseDesignFile checks
// format and version and fills in optional fields that older or hand-written
// files leave out; importDesignFile gives every page, layer, style and token
// a fresh id (so a file can be imported into the doc it came from) and
// rewrites every reference to them. Imported pages go after the existing
// ones.
//
// SVG import turns markup into layers, all inside one frame (or a group when
// the SVG has no size) named after the SVG. Supported: svg (viewBox, size,
// preserveAspectRatio meet), g / nested svg, rect (rx), circle, ellipse,
// line, polyline, polygon, path (M L H V C S Q T A Z, absolute and relative;
// arcs become cubic curves; each subpath its own layer), single-line text and
// images with a data: href. Paint comes from attributes, inline style and
// inherited group values; fill="url(#id)" picks up linear / radial gradient
// stops. Transforms: any matrix composes; shapes keep their type under
// translate / scale / rotate, and turn into paths under a skew (text and
// images take the rotation and the average scale instead). Not supported:
// <use>, <style> sheets, clip paths, masks, filters, patterns, markers,
// external image links, multi-line text (tspans are flattened into one line).
// -----------------------------------------------------------------------------

// ------------------------------------------------------------- native files --
export function toDesignFile(doc: DesignDoc, name: string): DesignFile {
  return {
    format: DESIGN_FORMAT,
    version: DESIGN_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    name,
    data: structuredClone(doc.data),
    nodes: Object.values(doc.nodes).map((n) => structuredClone(n)),
  };
}

const NODE_TYPES: NodeType[] = ["frame", "group", "rect", "ellipse", "line", "arrow", "polygon", "star", "path", "text", "image", "component", "instance"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const numOr = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Reads a native design file. Throws an Error with a message fit for the user when it can't. */
export function parseDesignFile(json: string): DesignFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("This file isn't valid JSON, so it can't be a design file.");
  }
  if (!isObj(raw)) throw new Error("This file isn't a design file (expected a JSON object).");
  if (raw.format !== DESIGN_FORMAT) throw new Error(`This isn't an iklipse design file (format "${String(raw.format ?? "missing")}", expected "${DESIGN_FORMAT}").`);
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("This design file has no valid version number.");
  if (version > DESIGN_FORMAT_VERSION)
    throw new Error(`This design file was made by a newer version of iklipse (format v${version}; this app reads up to v${DESIGN_FORMAT_VERSION}). Refresh the app and try again.`);
  if (raw.nodes !== undefined && !Array.isArray(raw.nodes)) throw new Error("This design file is damaged: its layer list isn't a list.");
  if (raw.data !== undefined && !isObj(raw.data)) throw new Error("This design file is damaged: its document data isn't an object.");

  const rawData = (raw.data ?? {}) as Obj;
  const pages: Page[] = arr<unknown>(rawData.pages)
    .filter(isObj)
    .filter((p) => typeof p.id === "string" && p.id)
    .map((p) => ({
      id: p.id as string,
      name: typeof p.name === "string" ? p.name : "Page",
      ...(typeof p.bg === "string" ? { bg: p.bg } : {}),
      start: typeof p.start === "string" ? p.start : null,
    }));

  const nodes: DNode[] = arr<unknown>(raw.nodes).map((v, i) => {
    if (!isObj(v)) throw new Error(`This design file is damaged: layer ${i + 1} isn't an object.`);
    if (typeof v.id !== "string" || !v.id) throw new Error(`This design file is damaged: layer ${i + 1} has no id.`);
    if (!NODE_TYPES.includes(v.type as NodeType)) throw new Error(`This design file is damaged: layer "${String(v.name ?? v.id)}" has an unknown type "${String(v.type)}".`);
    const n = { ...v } as unknown as DNode;
    n.name = typeof v.name === "string" ? v.name : n.type;
    n.page = typeof v.page === "string" ? v.page : "";
    n.parent = typeof v.parent === "string" && v.parent ? v.parent : null;
    n.order = numOr(v.order, i);
    n.x = numOr(v.x, 0);
    n.y = numOr(v.y, 0);
    n.w = numOr(v.w, 100);
    n.h = numOr(v.h, 100);
    n.rotation = numOr(v.rotation, 0);
    n.visible = v.visible !== false;
    n.locked = v.locked === true;
    n.opacity = numOr(v.opacity, 1);
    n.fills = arr<Paint>(v.fills).filter(isObj);
    n.strokes = arr<Stroke>(v.strokes).filter(isObj);
    return n;
  });

  // Layers on pages the file doesn't list: give them a page.
  const known = new Set(pages.map((p) => p.id));
  const orphanPages = [...new Set(nodes.map((n) => n.page).filter((p) => !known.has(p)))];
  for (const id of orphanPages) {
    const pid = id || shortId();
    pages.push({ id: pid, name: `Page ${pages.length + 1}`, start: null });
    known.add(pid);
    if (!id) for (const n of nodes) if (!n.page) n.page = pid;
  }
  if (!pages.length) pages.push(emptyData().pages[0]!);

  const data: DocData = {
    pages,
    colors: arr<DocData["colors"][number]>(rawData.colors).filter((c) => isObj(c) && typeof c.id === "string"),
    textStyles: arr<DocData["textStyles"][number]>(rawData.textStyles).filter((c) => isObj(c) && typeof c.id === "string"),
    tokens: arr<DocData["tokens"][number]>(rawData.tokens).filter((c) => isObj(c) && typeof c.id === "string"),
    library: arr<unknown>(rawData.library).filter((x): x is string => typeof x === "string"),
  };
  return {
    format: DESIGN_FORMAT,
    version,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    name: typeof raw.name === "string" ? raw.name : "Untitled",
    data,
    nodes,
  };
}

/**
 * The pages, layers and document data after importing `file` into `into`.
 * `data` is `into.data` with the imported pages, styles, tokens and library
 * entries appended; `nodes` are the new layers (add them to the doc as is).
 */
export function importDesignFile(file: DesignFile, into: DesignDoc): { pages: Page[]; nodes: DNode[]; data: DocData } {
  const nodeMap = new Map<string, string>();
  const pageMap = new Map<string, string>();
  const colorMap = new Map<string, string>();
  const textMap = new Map<string, string>();
  const tokenMap = new Map<string, string>();
  for (const n of file.nodes) nodeMap.set(n.id, uid());
  for (const p of file.data.pages) pageMap.set(p.id, shortId());
  for (const c of file.data.colors) colorMap.set(c.id, shortId());
  for (const t of file.data.textStyles) textMap.set(t.id, shortId());
  for (const t of file.data.tokens) tokenMap.set(t.id, shortId());

  const via = (m: Map<string, string>, id: string) => m.get(id) ?? id;
  const viaOpt = (m: Map<string, string>, id: string | undefined) => (id === undefined ? undefined : via(m, id));
  // Override keys are node ids, or "a/b" paths of them inside nested instances ("" = the instance itself).
  const key = (k: string) => (k ? k.split("/").map((s) => via(nodeMap, s)).join("/") : k);

  const paints = (ps: Paint[]): Paint[] => ps.map((p) => (p.type === "solid" && p.styleId ? { ...p, styleId: via(colorMap, p.styleId) } : p));
  const strokes = (ss: Stroke[]): Stroke[] => ss.map((s) => (s.styleId ? { ...s, styleId: via(colorMap, s.styleId) } : s));
  const override = (o: Override): Override => {
    const out: Override = { ...o };
    if (o.fills) out.fills = paints(o.fills);
    if (o.strokes) out.strokes = strokes(o.strokes);
    return out;
  };
  const interaction = (it: Interaction): Interaction => {
    const a = it.action;
    return {
      ...it,
      id: shortId(),
      action: a.type === "navigate" || a.type === "overlay" ? { ...a, target: via(nodeMap, a.target) } : a,
    };
  };

  // Page names: keep them unless they clash with a page already there.
  const taken = new Set(into.data.pages.map((p) => p.name));
  const pages: Page[] = file.data.pages.map((p) => {
    let name = p.name;
    if (taken.has(name)) {
      name = `${p.name} (imported)`;
      for (let i = 2; taken.has(name); i++) name = `${p.name} (imported ${i})`;
    }
    taken.add(name);
    return { ...p, id: via(pageMap, p.id), name, start: p.start ? via(nodeMap, p.start) : (p.start ?? null) };
  });

  const nodes: DNode[] = file.nodes.map((src) => {
    const n: DNode = structuredClone(src);
    n.id = via(nodeMap, src.id);
    n.page = via(pageMap, src.page);
    n.parent = src.parent && nodeMap.has(src.parent) ? nodeMap.get(src.parent)! : null;
    n.fills = paints(src.fills ?? []);
    n.strokes = strokes(src.strokes ?? []);
    if (n.text?.styleId) n.text = { ...n.text, styleId: via(textMap, n.text.styleId) };
    if (n.radiusToken) n.radiusToken = via(tokenMap, n.radiusToken);
    if (n.layout) n.layout = { ...n.layout, gapToken: viaOpt(tokenMap, n.layout.gapToken), paddingToken: viaOpt(tokenMap, n.layout.paddingToken) };
    if (n.layout && n.layout.gapToken === undefined) delete n.layout.gapToken;
    if (n.layout && n.layout.paddingToken === undefined) delete n.layout.paddingToken;
    if (n.componentId) n.componentId = via(nodeMap, n.componentId);
    if (n.overrides) n.overrides = Object.fromEntries(Object.entries(n.overrides).map(([k, o]) => [key(k), override(o)]));
    if (n.props) n.props = n.props.map((p) => ({ ...p, target: key(p.target) }));
    if (n.interactions) n.interactions = n.interactions.map(interaction);
    return n;
  });

  const colors = file.data.colors.map((c) => ({ ...c, id: via(colorMap, c.id) }));
  const textStyles = file.data.textStyles.map((t) => ({ ...t, id: via(textMap, t.id) }));
  const tokens = file.data.tokens.map((t) => ({ ...t, id: via(tokenMap, t.id) }));
  const library = (file.data.library ?? []).filter((id) => nodeMap.has(id)).map((id) => nodeMap.get(id)!);

  const d = into.data;
  return {
    pages,
    nodes,
    data: {
      ...d,
      pages: [...d.pages, ...pages],
      colors: [...d.colors, ...colors],
      textStyles: [...d.textStyles, ...textStyles],
      tokens: [...d.tokens, ...tokens],
      library: [...(d.library ?? []), ...library],
    },
  };
}

// --------------------------------------------------------------- SVG import --
type M = [number, number, number, number, number, number]; // a b c d e f
const ID: M = [1, 0, 0, 1, 0, 0];

function mul(m: M, n: M): M {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

function apply(m: M, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Linear part only (for bezier handles, which are relative). */
function applyVec(m: M, x: number, y: number) {
  return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

function parseTransform(s: string | null): M {
  let m: M = ID;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(s))) {
    const a = numbers(hit[2]!);
    let t: M = ID;
    switch (hit[1]) {
      case "matrix":
        if (a.length === 6) t = a as M;
        break;
      case "translate":
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        const cx = a[1] ?? 0;
        const cy = a[2] ?? 0;
        t = mul(mul([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

function numbers(s: string): number[] {
  return (s.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
}

/** Inherited presentation values. */
interface Style {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  dash: number[] | undefined;
  color: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  anchor: "start" | "middle" | "end";
}

const ROOT_STYLE: Style = {
  fill: "#000000",
  fillOpacity: 1,
  stroke: "none",
  strokeOpacity: 1,
  strokeWidth: 1,
  dash: undefined,
  color: "#000000",
  fontFamily: "Inter",
  fontSize: 16,
  fontWeight: 400,
  italic: false,
  anchor: "start",
};

/** attribute or inline style value (style wins, like CSS). */
function prop(el: Element, name: string): string | null {
  const style = el.getAttribute("style");
  if (style) {
    for (const decl of style.split(";")) {
      const i = decl.indexOf(":");
      if (i > 0 && decl.slice(0, i).trim().toLowerCase() === name) return decl.slice(i + 1).trim();
    }
  }
  const a = el.getAttribute(name);
  return a === null ? null : a.trim();
}

function inherit(el: Element, s: Style): Style {
  const out = { ...s };
  const v = (n: string) => {
    const x = prop(el, n);
    return x === null || x === "inherit" ? null : x;
  };
  const color = v("color");
  if (color) out.color = color;
  const fill = v("fill");
  if (fill) out.fill = fill;
  const fo = v("fill-opacity");
  if (fo) out.fillOpacity = clamp01(parseFloat(fo));
  const stroke = v("stroke");
  if (stroke) out.stroke = stroke;
  const so = v("stroke-opacity");
  if (so) out.strokeOpacity = clamp01(parseFloat(so));
  const sw = v("stroke-width");
  if (sw && !isNaN(parseFloat(sw))) out.strokeWidth = parseFloat(sw);
  const dash = v("stroke-dasharray");
  if (dash) out.dash = dash === "none" ? undefined : numbers(dash);
  const ff = v("font-family");
  if (ff) out.fontFamily = ff.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
  const fs = v("font-size");
  if (fs && !isNaN(parseFloat(fs))) out.fontSize = parseFloat(fs);
  const fw = v("font-weight");
  if (fw) out.fontWeight = fw === "bold" || fw === "bolder" ? 700 : fw === "normal" ? 400 : fw === "lighter" ? 300 : parseInt(fw, 10) || out.fontWeight;
  const fst = v("font-style");
  if (fst) out.italic = fst === "italic" || fst === "oblique";
  const ta = v("text-anchor");
  if (ta === "start" || ta === "middle" || ta === "end") out.anchor = ta;
  return out;
}

const clamp01 = (v: number) => (isNaN(v) ? 1 : Math.max(0, Math.min(1, v)));

/** Opacity from a colour string (rgba / #rrggbbaa) times the extra opacity. */
function solidPaint(color: string, opacity: number): Paint | null {
  const c = parseColor(color);
  if (!c) return null;
  const a = Math.round(c.a * opacity * 1000) / 1000;
  return a >= 1 ? { type: "solid", color: toHex(c) } : { type: "solid", color: toHex(c), opacity: a };
}

interface Ctx {
  doc: Document;
  page: string;
}

function paintFor(ctx: Ctx, value: string, opacity: number, current: string): Paint | null {
  if (!value || value === "none" || value === "transparent") return null;
  if (value === "currentColor") value = current;
  const ref = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value);
  if (ref) {
    const g = ctx.doc.getElementById(ref[1]!);
    return g ? gradientPaint(ctx, g, opacity) : { type: "solid", color: "#CCCCCC", ...(opacity < 1 ? { opacity } : {}) };
  }
  return solidPaint(value, opacity);
}

function gradientPaint(ctx: Ctx, g: Element, opacity: number): Paint | null {
  // Stops may come from a gradient this one links to.
  let stopsEl: Element = g;
  for (let i = 0; i < 5 && !stopsEl.getElementsByTagName("stop").length; i++) {
    const href = stopsEl.getAttribute("href") ?? stopsEl.getAttribute("xlink:href");
    const next = href?.startsWith("#") ? ctx.doc.getElementById(href.slice(1)) : null;
    if (!next) break;
    stopsEl = next;
  }
  const stops = [...stopsEl.getElementsByTagName("stop")].map((s) => {
    const off = s.getAttribute("offset") ?? "0";
    const pos = off.endsWith("%") ? parseFloat(off) / 100 : parseFloat(off);
    const c = parseColor(prop(s, "stop-color") ?? "#000000") ?? { r: 0, g: 0, b: 0, a: 1 };
    const so = clamp01(parseFloat(prop(s, "stop-opacity") ?? "1"));
    const a = c.a * so;
    return { pos: isNaN(pos) ? 0 : clamp01(pos), color: a >= 1 ? toHex(c) : `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(a * 1000) / 1000})` };
  });
  if (!stops.length) return null;
  const op = opacity < 1 ? { opacity } : {};
  const tag = g.localName;
  if (tag === "radialGradient") return { type: "radial", stops, ...op };
  if (tag !== "linearGradient") return solidPaint(stops[0]!.color, opacity);
  const coord = (n: string, d: number) => {
    const v = g.getAttribute(n);
    if (v === null) return d;
    return v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
  };
  const dx = coord("x2", 1) - coord("x1", 0);
  const dy = coord("y2", 0) - coord("y1", 0);
  const angle = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) * 100) / 100;
  return { type: "linear", angle: (angle + 360) % 360, stops, ...op };
}

function strokeFor(ctx: Ctx, s: Style, scale: number): Stroke[] {
  const p = paintFor(ctx, s.stroke, s.strokeOpacity, s.color);
  if (!p || s.strokeWidth <= 0) return [];
  const color = p.type === "solid" ? (p.opacity !== undefined && p.opacity < 1 ? rgbaOf(p.color, p.opacity) : p.color) : (p.stops[0]?.color ?? "#000000");
  const st: Stroke = { color, width: round(s.strokeWidth * scale), align: "center" };
  if (s.dash?.length) st.dash = s.dash.map((d) => round(d * scale));
  return [st];
}

function rgbaOf(hex: string, a: number) {
  const c = parseColor(hex)!;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(a * 1000) / 1000})`;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** A layer while importing: absolute box, children; positions become relative at the end. */
interface Draft {
  node: DNode;
  kids: Draft[];
}

/** How a matrix maps a box: axis-aligned, rotated (uniform scale) or skewed. */
function decompose(m: M): { kind: "box"; sx: number; sy: number; rot: number } | { kind: "skew" } {
  const [a, b, c, d] = m;
  if (Math.abs(b) < 1e-9 && Math.abs(c) < 1e-9) return { kind: "box", sx: a, sy: d, rot: 0 };
  const s1 = Math.hypot(a, b);
  const s2 = Math.hypot(c, d);
  // Orthogonal columns with a positive determinant: a rotation with scales.
  if (Math.abs(a * c + b * d) < 1e-6 * s1 * s2 && a * d - b * c > 0) return { kind: "box", sx: s1, sy: s2, rot: (Math.atan2(b, a) * 180) / Math.PI };
  return { kind: "skew" };
}

/** Puts a (x, y, w, h) box through a matrix; null when it skews. */
function boxThrough(m: M, x: number, y: number, w: number, h: number) {
  const dec = decompose(m);
  if (dec.kind === "skew") return null;
  const c = apply(m, x + w / 2, y + h / 2);
  const nw = Math.abs(w * dec.sx);
  const nh = Math.abs(h * dec.sy);
  return { x: c.x - nw / 2, y: c.y - nh / 2, w: nw, h: nh, rotation: round(dec.rot), scale: Math.sqrt(Math.abs(dec.sx * dec.sy)) };
}

const scaleOf = (m: M) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

const SKIP = new Set(["defs", "clipPath", "mask", "symbol", "style", "script", "title", "desc", "metadata", "linearGradient", "radialGradient", "pattern", "filter", "marker", "use", "foreignObject"]);

/** Imports SVG markup as layers on `page` under `parent`, the wrapper's top-left at `at`. */
export function importSvg(svgText: string, page: string, parent: string | null, at: { x: number; y: number }, name?: string): DNode[] {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length)
    throw new Error("This doesn't look like an SVG file (it couldn't be read as SVG markup).");
  const ctx: Ctx = { doc, page };

  const vb = numbers(root.getAttribute("viewBox") ?? "");
  const hasVb = vb.length === 4 && vb[2]! > 0 && vb[3]! > 0;
  const len = (v: string | null) => (v && !v.trim().endsWith("%") && !isNaN(parseFloat(v)) ? parseFloat(v) : null);
  let w = len(root.getAttribute("width"));
  let h = len(root.getAttribute("height"));
  if (hasVb) {
    if (w === null && h === null) {
      w = vb[2]!;
      h = vb[3]!;
    } else if (w === null) w = (h! * vb[2]!) / vb[3]!;
    else if (h === null) h = (w * vb[3]!) / vb[2]!;
  }
  let m: M = ID;
  if (hasVb && w !== null && h !== null) {
    const par = root.getAttribute("preserveAspectRatio") ?? "";
    const sx = w / vb[2]!;
    const sy = h / vb[3]!;
    if (par.startsWith("none")) m = [sx, 0, 0, sy, -vb[0]! * sx, -vb[1]! * sy];
    else {
      // Default xMidYMid meet: uniform scale, centred.
      const s = par.includes("slice") ? Math.max(sx, sy) : Math.min(sx, sy);
      const ox = (w - vb[2]! * s) / 2 - vb[0]! * s;
      const oy = (h - vb[3]! * s) / 2 - vb[1]! * s;
      m = [s, 0, 0, s, ox, oy];
    }
  }

  const kids = children(ctx, root, m, inherit(root, ROOT_STYLE));
  const title = [...root.children].find((c) => c.localName === "title")?.textContent?.trim();
  const wrapName = name || title || "SVG";
  const sized = w !== null && h !== null && w > 0 && h > 0;
  const wrapper = makeNode(sized ? "frame" : "group", page, parent, {
    name: wrapName,
    x: 0,
    y: 0,
    w: w ?? 0,
    h: h ?? 0,
    fills: [],
    ...(sized ? { clip: true } : {}),
  });
  const top: Draft = { node: wrapper, kids };
  if (!sized) {
    const b = bounds(kids);
    if (!b) return [];
    Object.assign(wrapper, b);
  }
  const out: DNode[] = [];
  finalize(top, { x: 0, y: 0 }, out);
  wrapper.x = at.x;
  wrapper.y = at.y;
  return out;
}

/** Absolute boxes → parent-relative positions, groups sized to their content. Pushes depth-first. */
function finalize(d: Draft, parentAbs: { x: number; y: number }, out: DNode[]) {
  const abs = { x: d.node.x, y: d.node.y };
  d.node.x = round(abs.x - parentAbs.x);
  d.node.y = round(abs.y - parentAbs.y);
  d.node.w = round(d.node.w);
  d.node.h = round(d.node.h);
  out.push(d.node);
  d.kids.forEach((k, i) => {
    k.node.parent = d.node.id;
    k.node.order = i + 1;
    finalize(k, abs, out);
  });
}

function bounds(ds: Draft[]) {
  if (!ds.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const d of ds) {
    x0 = Math.min(x0, d.node.x);
    y0 = Math.min(y0, d.node.y);
    x1 = Math.max(x1, d.node.x + d.node.w);
    y1 = Math.max(y1, d.node.y + d.node.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function children(ctx: Ctx, el: Element, m: M, s: Style): Draft[] {
  const out: Draft[] = [];
  for (const c of [...el.children]) {
    const d = element(ctx, c, m, s);
    if (d) out.push(...d);
  }
  return out;
}

function element(ctx: Ctx, el: Element, parentM: M, parentStyle: Style): Draft[] | null {
  const tag = el.localName;
  if (SKIP.has(tag)) return null;
  if (prop(el, "display") === "none" || prop(el, "visibility") === "hidden") return null;
  let m = mul(parentM, parseTransform(el.getAttribute("transform")));
  const s = inherit(el, parentStyle);
  const opacity = clamp01(parseFloat(prop(el, "opacity") ?? "1"));
  const label = el.getAttribute("id") || el.getAttribute("inkscape:label") || undefined;
  const base = (type: NodeType, p: Partial<DNode>): DNode =>
    makeNode(type, ctx.page, null, { ...(label ? { name: label } : {}), ...(opacity < 1 ? { opacity } : {}), ...p });
  const fills = () => {
    const f = paintFor(ctx, s.fill, s.fillOpacity, s.color);
    return f ? [f] : [];
  };
  const a = (n: string) => parseFloat(el.getAttribute(n) ?? "0") || 0;

  switch (tag) {
    case "g":
    case "a":
    case "svg": {
      if (tag === "svg") m = mul(m, [1, 0, 0, 1, a("x"), a("y")]);
      const kids = children(ctx, el, m, s);
      if (!kids.length) return null;
      if (tag === "a" && kids.length === 1 && opacity >= 1) return kids;
      const g = base("group", { name: label ?? "Group" });
      Object.assign(g, bounds(kids));
      return [{ node: g, kids }];
    }
    case "rect": {
      const x = a("x"),
        y = a("y"),
        w = a("width"),
        h = a("height");
      if (w <= 0 || h <= 0) return null;
      const rx = Math.min(w / 2, el.hasAttribute("rx") ? a("rx") : a("ry"));
      const box = boxThrough(m, x, y, w, h);
      if (box) {
        const n = base("rect", { x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation, fills: fills(), strokes: strokeFor(ctx, s, box.scale) });
        if (rx > 0) n.radius = round(rx * box.scale);
        return [{ node: n }].map(leaf);
      }
      return [pathDraft(ctx, base, rectPoints(x, y, w, h), true, m, s, fills())].map(leaf);
    }
    case "circle":
    case "ellipse": {
      const cx = a("cx"),
        cy = a("cy");
      const rx = tag === "circle" ? a("r") : a("rx") || a("ry");
      const ry = tag === "circle" ? a("r") : a("ry") || a("rx");
      if (rx <= 0 || ry <= 0) return null;
      const box = boxThrough(m, cx - rx, cy - ry, rx * 2, ry * 2);
      if (box) return [leaf({ node: base("ellipse", { x: box.x, y: box.y, w: box.w, h: box.h, rotation: box.rotation, fills: fills(), strokes: strokeFor(ctx, s, box.scale) }) })];
      return [leaf(pathDraft(ctx, base, ellipsePoints(cx, cy, rx, ry), true, m, s, fills()))];
    }
    case "line": {
      const p1 = apply(m, a("x1"), a("y1"));
      const p2 = apply(m, a("x2"), a("y2"));
      const x0 = Math.min(p1.x, p2.x);
      const y0 = Math.min(p1.y, p2.y);
      const strokes = strokeFor(ctx, s, scaleOf(m));
      if (!strokes.length) return null;
      const n = base("line", {
        x: x0,
        y: y0,
        w: Math.abs(p2.x - p1.x),
        h: Math.abs(p2.y - p1.y),
        strokes,
        points: [
          { x: round(p1.x - x0), y: round(p1.y - y0) },
          { x: round(p2.x - x0), y: round(p2.y - y0) },
        ],
      });
      return [leaf({ node: n })];
    }
    case "polyline":
    case "polygon": {
      const v = numbers(el.getAttribute("points") ?? "");
      const pts: PathPoint[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push({ x: v[i]!, y: v[i + 1]! });
      if (pts.length < 2) return null;
      return [leaf(pathDraft(ctx, base, pts, tag === "polygon", m, s, fills()))];
    }
    case "path": {
      const subs = parsePathData(el.getAttribute("d") ?? "");
      const ds = subs.filter((sp) => sp.points.length >= 2).map((sp) => leaf(pathDraft(ctx, base, sp.points, sp.closed, m, s, fills())));
      if (!ds.length) return null;
      if (ds.length === 1) return ds;
      // Several subpaths: one layer each, kept together in a group.
      const g = base("group", { name: label ?? "Path" });
      for (const d of ds) {
        d.node.opacity = 1;
        d.node.name = "Vector";
      }
      Object.assign(g, bounds(ds));
      return [{ node: g, kids: ds }];
    }
    case "text": {
      const content = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!content) return null;
      const first = [...el.children].find((c) => c.localName === "tspan");
      const xAttr = el.getAttribute("x") ?? first?.getAttribute("x") ?? "0";
      const yAttr = el.getAttribute("y") ?? first?.getAttribute("y") ?? "0";
      const x = numbers(xAttr)[0] ?? 0;
      const y = numbers(yAttr)[0] ?? 0;
      const style = first ? inherit(first, s) : s;
      const text: TextProps = {
        content,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeight: null,
        letterSpacing: 0,
        align: style.anchor === "middle" ? "center" : style.anchor === "end" ? "right" : "left",
        valign: "top",
        italic: style.italic || undefined,
        resize: "auto-width",
      };
      const dec = decompose(m);
      const k = dec.kind === "box" ? Math.sqrt(Math.abs(dec.sx * dec.sy)) : scaleOf(m);
      text.fontSize = round(text.fontSize * k);
      const tl = layoutText(text);
      const tw = Math.ceil(tl.width);
      const th = Math.ceil(tl.height);
      // (x, y) is the baseline at the anchor; the renderer puts the baseline 0.9 em down a 1.2 em line.
      const p = apply(m, x, y);
      const left = style.anchor === "middle" ? p.x - tw / 2 : style.anchor === "end" ? p.x - tw : p.x;
      const tf = paintFor(ctx, style.fill, style.fillOpacity, style.color);
      const n = base("text", {
        name: label ?? content.slice(0, 40),
        x: left,
        y: p.y - text.fontSize * 0.9,
        w: tw,
        h: th,
        rotation: dec.kind === "box" ? round(dec.rot) : 0,
        text,
        fills: tf ? [tf] : [],
        strokes: [],
      });
      return [leaf({ node: n })];
    }
    case "image": {
      const href = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? el.getAttribute("xlink:href");
      if (!href || !href.startsWith("data:image/")) return null;
      const w = a("width"),
        h = a("height");
      if (w <= 0 || h <= 0) return null;
      const dec = decompose(m);
      const box = boxThrough(m, a("x"), a("y"), w, h) ?? { ...apply(m, a("x"), a("y")), w: w * scaleOf(m), h: h * scaleOf(m), rotation: 0 };
      // "fill" draws like slice (cover), "fit" like meet; there's no stretch mode.
      const par = el.getAttribute("preserveAspectRatio") ?? "";
      const n = base("image", {
        name: label ?? "Image",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        rotation: dec.kind === "box" ? box.rotation : 0,
        image: { src: href, nw: w, nh: h, fit: par.startsWith("none") || par.includes("slice") ? "fill" : "fit" },
      });
      return [leaf({ node: n })];
    }
    default:
      return null;
  }
}

function leaf(d: { node: DNode; kids?: Draft[] }): Draft {
  return { node: d.node, kids: d.kids ?? [] };
}

/** A path layer from points in SVG user space (handles relative), boxed to its bounds. */
function pathDraft(ctx: Ctx, base: (t: NodeType, p: Partial<DNode>) => DNode, pts: PathPoint[], closed: boolean, m: M, s: Style, fills: Paint[]): Draft {
  const tp = pts.map((p) => {
    const q = apply(m, p.x, p.y);
    const out: PathPoint = { x: q.x, y: q.y };
    if (p.in) out.in = applyVec(m, p.in.x, p.in.y);
    if (p.out) out.out = applyVec(m, p.out.x, p.out.y);
    return out;
  });
  const b = curveBounds(tp, closed);
  const local = tp.map((p) => {
    const out: PathPoint = { x: round(p.x - b.x), y: round(p.y - b.y) };
    if (p.in) out.in = { x: round(p.in.x), y: round(p.in.y) };
    if (p.out) out.out = { x: round(p.out.x), y: round(p.out.y) };
    return out;
  });
  const n = base("path", {
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
    points: local,
    closed,
    fills: closed ? fills : [],
    strokes: strokeFor(ctx, s, scaleOf(m)),
  });
  // An open path with a fill but no stroke draws nothing in our renderer: close it.
  if (!closed && fills.length && !n.strokes.length) {
    n.closed = true;
    n.fills = fills;
  }
  return { node: n, kids: [] };
}

/** Tight-ish bounds of a point list with bezier handles (curves sampled). */
function curveBounds(pts: PathPoint[], closed: boolean) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  const segs = closed ? pts.length : pts.length - 1;
  for (const p of pts) add(p.x, p.y);
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if (!a.out && !b.in) continue;
    const c1 = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : a;
    const c2 = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : b;
    for (let k = 1; k < 24; k++) {
      const t = k / 24;
      const u = 1 - t;
      add(u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y);
    }
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

function rectPoints(x: number, y: number, w: number, h: number): PathPoint[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** An ellipse as four cubic curves. */
function ellipsePoints(cx: number, cy: number, rx: number, ry: number): PathPoint[] {
  const k = 0.5522847498;
  return [
    { x: cx + rx, y: cy, in: { x: 0, y: -ry * k }, out: { x: 0, y: ry * k } },
    { x: cx, y: cy + ry, in: { x: rx * k, y: 0 }, out: { x: -rx * k, y: 0 } },
    { x: cx - rx, y: cy, in: { x: 0, y: ry * k }, out: { x: 0, y: -ry * k } },
    { x: cx, y: cy - ry, in: { x: -rx * k, y: 0 }, out: { x: rx * k, y: 0 } },
  ];
}

// ------------------------------------------------------------- path data --
export interface SubPath {
  points: PathPoint[];
  closed: boolean;
}

/** SVG path data → subpaths of points with relative bezier handles (absolute coordinates). */
export function parsePathData(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let cur = null as SubPath | null;
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  // Last control points for S / T reflection.
  let lastC: { x: number; y: number } | null = null;
  let lastQ: { x: number; y: number } | null = null;
  let i = 0;
  let cmd = "";
  const isCmd = (t: string | undefined) => !!t && /^[a-zA-Z]$/.test(t);
  const n = () => Number(tokens[i++]);
  // Not enough numbers for the command: drop a stray number, never the next command.
  const bad = () => {
    if (!isCmd(tokens[i])) i++;
  };
  const has = (k: number) => {
    for (let j = 0; j < k; j++) if (tokens[i + j] === undefined || isCmd(tokens[i + j])) return false;
    return true;
  };
  const last = () => cur!.points[cur!.points.length - 1]!;
  const start = (px: number, py: number) => {
    if (cur && cur.points.length) out.push(cur);
    cur = { points: [{ x: px, y: py }], closed: false };
    sx = px;
    sy = py;
  };
  const ensure = () => {
    if (!cur) start(x, y);
  };
  const lineTo = (px: number, py: number) => {
    ensure();
    cur!.points.push({ x: px, y: py });
    x = px;
    y = py;
  };
  const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, px: number, py: number) => {
    ensure();
    const p = last();
    p.out = { x: c1x - p.x, y: c1y - p.y };
    cur!.points.push({ x: px, y: py, in: { x: c2x - px, y: c2y - py } });
    x = px;
    y = py;
  };

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]!;
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    const C = cmd.toUpperCase();
    let nextC: { x: number; y: number } | null = null;
    let nextQ: { x: number; y: number } | null = null;
    switch (C) {
      case "M": {
        if (!has(2)) {
          bad();
          break;
        }
        const px = ox + n(),
          py = oy + n();
        start(px, py);
        x = px;
        y = py;
        // Extra pairs after M are line-tos.
        cmd = rel ? "l" : "L";
        break;
      }
      case "L":
        if (!has(2)) {
          bad();
          break;
        }
        lineTo(ox + n(), oy + n());
        break;
      case "H":
        if (!has(1)) {
          bad();
          break;
        }
        lineTo((rel ? x : 0) + n(), y);
        break;
      case "V":
        if (!has(1)) {
          bad();
          break;
        }
        lineTo(x, (rel ? y : 0) + n());
        break;
      case "C": {
        if (!has(6)) {
          bad();
          break;
        }
        const c1x = ox + n(),
          c1y = oy + n(),
          c2x = ox + n(),
          c2y = oy + n(),
          px = ox + n(),
          py = oy + n();
        cubicTo(c1x, c1y, c2x, c2y, px, py);
        nextC = { x: c2x, y: c2y };
        break;
      }
      case "S": {
        if (!has(4)) {
          bad();
          break;
        }
        const c1 = lastC ? { x: 2 * x - lastC.x, y: 2 * y - lastC.y } : { x, y };
        const c2x = ox + n(),
          c2y = oy + n(),
          px = ox + n(),
          py = oy + n();
        cubicTo(c1.x, c1.y, c2x, c2y, px, py);
        nextC = { x: c2x, y: c2y };
        break;
      }
      case "Q": {
        if (!has(4)) {
          bad();
          break;
        }
        const qx = ox + n(),
          qy = oy + n(),
          px = ox + n(),
          py = oy + n();
        quadTo(qx, qy, px, py);
        nextQ = { x: qx, y: qy };
        break;
      }
      case "T": {
        if (!has(2)) {
          bad();
          break;
        }
        const q: { x: number; y: number } = lastQ ? { x: 2 * x - lastQ.x, y: 2 * y - lastQ.y } : { x, y };
        const px = ox + n(),
          py = oy + n();
        quadTo(q.x, q.y, px, py);
        nextQ = q;
        break;
      }
      case "A": {
        if (!has(7)) {
          bad();
          break;
        }
        const rx = n(),
          ry = n(),
          rot = n(),
          large = n(),
          sweep = n(),
          px = ox + n(),
          py = oy + n();
        arcTo(rx, ry, rot, !!large, !!sweep, px, py);
        break;
      }
      case "Z": {
        if (cur) {
          const sp = cur;
          const pts = sp.points;
          const f = pts[0]!;
          const l = pts[pts.length - 1]!;
          // A closing segment that ends on the start point: merge the two.
          if (pts.length > 1 && Math.abs(l.x - f.x) < 1e-6 && Math.abs(l.y - f.y) < 1e-6) {
            if (l.in) f.in = l.in;
            pts.pop();
          }
          sp.closed = true;
          out.push(sp);
          cur = null;
        }
        x = sx;
        y = sy;
        cmd = "";
        break;
      }
      default:
        cmd = "";
        i++;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  if (cur && cur.points.length) out.push(cur);
  return out;

  function quadTo(qx: number, qy: number, px: number, py: number) {
    cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), px + (2 / 3) * (qx - px), py + (2 / 3) * (qy - py), px, py);
  }

  /** SVG arc (endpoint form) as cubic curves (SVG spec F.6.5). */
  function arcTo(rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, px: number, py: number) {
    if ((px === x && py === y) || !rx || !ry) {
      if (px !== x || py !== y) lineTo(px, py);
      return;
    }
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    const dx = (x - px) / 2;
    const dy = (y - py) / 2;
    const x1 = cos * dx + sin * dy;
    const y1 = -sin * dx + cos * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) {
      rx *= Math.sqrt(lam);
      ry *= Math.sqrt(lam);
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let k = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) k = -k;
    const cxp = (k * rx * y1) / ry;
    const cyp = (-k * ry * x1) / rx;
    const cx = cos * cxp - sin * cyp + (x + px) / 2;
    const cy = sin * cxp + cos * cyp + (y + py) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => {
      const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      return a;
    };
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
    const step = dt / segs;
    const alpha = (4 / 3) * Math.tan(step / 4);
    const pt = (t: number) => ({ x: cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, y: cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos });
    const dpt = (t: number) => ({ x: -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, y: -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos });
    let ta = t1;
    for (let s = 0; s < segs; s++) {
      const tb = ta + step;
      const a = pt(ta);
      const b = s === segs - 1 ? { x: px, y: py } : pt(tb);
      const da = dpt(ta);
      const db = dpt(tb);
      cubicTo(a.x + alpha * da.x, a.y + alpha * da.y, b.x - alpha * db.x, b.y - alpha * db.y, b.x, b.y);
      ta = tb;
    }
  }
}
