import type { RNode } from "./layout";
import { lineHeightOf } from "./text";
import type { ColorStop, Paint, Stroke } from "./types";

// -----------------------------------------------------------------------------
// Developer handoff: CSS for one resolved layer (Inspect panel, "Copy CSS").
// Reads the resolved tree, so styles, tokens, overrides and auto layout sizes
// are already applied.
//
// Choices worth knowing:
// - Position: a layer gets `position: absolute; left; top` when its parent
//   has no auto layout (or it opts out with "absolute"). Top-level layers and
//   auto layout children get none: the flex parent places them.
// - Fills: the last fill draws on top (like the canvas), so the CSS
//   background list is reversed. Extra solid layers become flat gradients,
//   since only the bottom background layer may be a plain colour.
// - Linear gradients: our angle 0 runs left to right, 90 top to bottom; CSS
//   counts from "to top", so css = angle + 90deg. Radial gradients fill the
//   box like the SVG renderer (ellipse, closest-side).
// - Strokes: inside → `box-shadow: inset 0 0 0 <w>`, outside →
//   `box-shadow: 0 0 0 <w>` (neither changes the box size, like Figma);
//   center (and any dashed stroke) → `border` with `box-sizing: border-box`.
// - Blur: the canvas uses stdDeviation = blur / 2, which is what CSS
//   `filter: blur()` takes. Shadow blur radii are copied as is.
// -----------------------------------------------------------------------------

export interface CssRule {
  prop: string;
  value: string;
}

const px = (v: number) => `${Math.round(v * 100) / 100}px`;
const num = (v: number) => String(Math.round(v * 1000) / 1000);

export function cssFor(n: RNode, parent: RNode | null): CssRule[] {
  const out: CssRule[] = [];
  const add = (prop: string, value: string) => out.push({ prop, value });
  const inFlex = !!parent?.layout && !n.absolute;
  const pl = parent?.layout;
  const sizing = n.sizing ?? { h: "fixed", v: "fixed" };

  // ---- size
  const dim = (axis: "h" | "v") => {
    const prop = axis === "h" ? "width" : "height";
    const s = sizing[axis];
    const size = axis === "h" ? n.w : n.h;
    if (s === "fill" && inFlex && pl) {
      const main = (pl.mode === "horizontal") === (axis === "h");
      if (main) add("flex", "1 1 0");
      else add("align-self", "stretch");
      return;
    }
    if (s === "hug") add(prop, "fit-content");
    else add(prop, px(size));
  };
  dim("h");
  dim("v");

  // ---- position
  if (parent && (!parent.layout || n.absolute)) {
    add("position", "absolute");
    add("left", px(n.x));
    add("top", px(n.y));
  }
  if (n.rotation) add("transform", `rotate(${num(n.rotation)}deg)`);
  if (n.opacity < 1) add("opacity", num(n.opacity));
  if (n.blend && n.blend !== "normal" && n.blend !== "pass-through") add("mix-blend-mode", n.blend);

  // ---- auto layout
  const L = n.layout;
  if (L) {
    add("display", "flex");
    add("flex-direction", L.mode === "horizontal" ? "row" : "column");
    if (L.wrap && L.mode === "horizontal") add("flex-wrap", "wrap");
    add("justify-content", JUSTIFY[L.justify]);
    add("align-items", ALIGN[L.align]);
    if (L.justify !== "space-between" || L.wrap) add("gap", px(L.gap));
    if (L.wrap && L.mode === "horizontal" && L.rowGap !== undefined && L.rowGap !== L.gap) add("row-gap", px(L.rowGap));
    const p = L.padding;
    if (p.t || p.r || p.b || p.l) add("padding", paddingValue(p));
  }
  if (n.clip && (n.type === "frame" || n.type === "component" || n.type === "instance")) add("overflow", "hidden");

  // ---- paints
  const fills = n.fills.filter((f) => f.visible !== false);
  if (n.type === "text") {
    const f = fills[fills.length - 1];
    if (f) add("color", f.type === "solid" ? colorWithAlpha(f.color, f.opacity ?? 1) : colorWithAlpha(f.stops[0]?.color ?? "#000000", f.opacity ?? 1));
  } else if (n.type !== "line" && n.type !== "arrow" && n.type !== "path" && fills.length) {
    add("background", backgroundValue(fills));
  }

  // ---- strokes, shadows
  const shadows: string[] = [];
  const strokes = n.strokes.filter((s) => s.visible !== false && s.width > 0);
  if (n.type === "line" || n.type === "arrow") {
    const s = strokes[0];
    if (s) add("border-top", `${px(s.width)} ${s.dash?.length ? "dashed" : "solid"} ${colorWithAlpha(s.color, 1)}`);
  } else if (n.type !== "text") {
    let bordered = false;
    for (const s of strokes) {
      const align = s.align ?? (n.type === "path" ? "center" : "inside");
      if ((align === "center" || s.dash?.length) && !bordered) {
        add("border", borderValue(s));
        add("box-sizing", "border-box");
        bordered = true;
      } else if (align === "outside") shadows.push(`0 0 0 ${px(s.width)} ${colorWithAlpha(s.color, 1)}`);
      else shadows.push(`inset 0 0 0 ${px(s.width)} ${colorWithAlpha(s.color, 1)}`);
    }
  }
  const effects = (n.effects ?? []).filter((e) => e.visible !== false);
  for (const e of n.type === "text" ? [] : effects) {
    if (e.type === "drop-shadow") shadows.push(`${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread ?? 0)} ${colorWithAlpha(e.color, 1)}`);
    else if (e.type === "inner-shadow") shadows.push(`inset ${px(e.x)} ${px(e.y)} ${px(e.blur)} ${px(e.spread ?? 0)} ${colorWithAlpha(e.color, 1)}`);
  }
  if (n.type === "text") {
    const ts = textShadows(n);
    if (ts) add("text-shadow", ts);
  } else if (shadows.length) add("box-shadow", shadows.join(", "));
  const blur = effects.find((e) => e.type === "layer-blur");
  if (blur) add("filter", `blur(${px(blur.blur / 2)})`);

  // ---- corners
  if (n.type === "ellipse") add("border-radius", "50%");
  else if (n.radius !== undefined) {
    const r = n.radius;
    if (Array.isArray(r)) {
      if (r.some((v) => v)) add("border-radius", r.every((v) => v === r[0]) ? px(r[0]) : r.map(px).join(" "));
    } else if (r) add("border-radius", px(r));
  }

  // ---- text
  const t = n.text;
  if (n.type === "text" && t) {
    add("font-family", fontFamily(t.fontFamily));
    add("font-size", px(t.fontSize));
    add("font-weight", String(t.fontWeight));
    if (t.italic) add("font-style", "italic");
    add("line-height", px(lineHeightOf(t)));
    if (t.letterSpacing) add("letter-spacing", px(t.letterSpacing));
    if (t.align !== "left") add("text-align", t.align);
    if (t.transform && t.transform !== "none") add("text-transform", TRANSFORM[t.transform]);
    if (t.decoration && t.decoration !== "none") add("text-decoration", t.decoration === "strike" ? "line-through" : "underline");
  }
  return out;
}

/** Rules as a CSS declaration block body ("prop: value;" per line). */
export function cssText(rules: CssRule[]): string {
  return rules.map((r) => `${r.prop}: ${r.value};`).join("\n");
}

const JUSTIFY = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between" } as const;
const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch", baseline: "baseline" } as const;
const TRANSFORM = { upper: "uppercase", lower: "lowercase", title: "capitalize" } as const;

function paddingValue(p: { t: number; r: number; b: number; l: number }) {
  if (p.t === p.r && p.r === p.b && p.b === p.l) return px(p.t);
  if (p.t === p.b && p.l === p.r) return `${px(p.t)} ${px(p.r)}`;
  return `${px(p.t)} ${px(p.r)} ${px(p.b)} ${px(p.l)}`;
}

function borderValue(s: Stroke) {
  return `${px(s.width)} ${s.dash?.length ? "dashed" : "solid"} ${colorWithAlpha(s.color, 1)}`;
}

/** Text: drop shadows become text-shadow (CSS has no inner text shadow). */
function textShadows(n: RNode) {
  const out: string[] = [];
  for (const e of n.effects ?? []) if (e.visible !== false && e.type === "drop-shadow") out.push(`${px(e.x)} ${px(e.y)} ${px(e.blur)} ${colorWithAlpha(e.color, 1)}`);
  return out.join(", ");
}

function fontFamily(f: string) {
  const fam = /\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f;
  return `${fam}, sans-serif`;
}

function stopsValue(stops: ColorStop[], opacity: number) {
  return [...stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${colorWithAlpha(s.color, opacity)} ${num(s.pos * 100)}%`)
    .join(", ");
}

/** One paint as a CSS image (or a colour when `asColor`). */
function paintValue(p: Paint, asColor: boolean): string {
  const op = p.opacity ?? 1;
  if (p.type === "solid") {
    const c = colorWithAlpha(p.color, op);
    return asColor ? c : `linear-gradient(${c}, ${c})`;
  }
  if (p.type === "linear") return `linear-gradient(${num((((p.angle + 90) % 360) + 360) % 360)}deg, ${stopsValue(p.stops, op)})`;
  return `radial-gradient(closest-side, ${stopsValue(p.stops, op)})`;
}

function backgroundValue(fills: Paint[]) {
  // CSS lists the top layer first; ours draws the last fill on top.
  const top = [...fills].reverse();
  return top.map((p, i) => paintValue(p, i === top.length - 1)).join(", ");
}

// ------------------------------------------------------------------ colours --
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#008000",
  lime: "#00FF00",
  blue: "#0000FF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  aqua: "#00FFFF",
  magenta: "#FF00FF",
  fuchsia: "#FF00FF",
  gray: "#808080",
  grey: "#808080",
  silver: "#C0C0C0",
  maroon: "#800000",
  olive: "#808000",
  navy: "#000080",
  purple: "#800080",
  teal: "#008080",
  orange: "#FFA500",
  pink: "#FFC0CB",
  brown: "#A52A2A",
};

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() / rgba() and basic names. Null when it can't. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED[s];
  if (named) return parseColor(named);
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? Math.round((v(6) / 255) * 1000) / 1000 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const ch = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    const vals = [ch(parts[0]!), ch(parts[1]!), ch(parts[2]!)];
    if (vals.some((v) => isNaN(v)) || isNaN(a)) return null;
    const [r, g, b] = vals.map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [number, number, number];
    return { r, g, b, a: Math.max(0, Math.min(1, a)) };
  }
  return null;
}

const hex2 = (v: number) => v.toString(16).padStart(2, "0").toUpperCase();

export function toHex(c: Rgba) {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

export function toRgba(c: Rgba) {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${num(c.a)})`;
}

/** A colour with an extra opacity, as hex when opaque and rgba() otherwise. */
export function colorWithAlpha(color: string, opacity: number): string {
  const c = parseColor(color);
  if (!c) return color;
  const a = c.a * opacity;
  return a >= 1 ? toHex(c) : toRgba({ ...c, a });
}

export interface ColorValue {
  /** #RRGGBB (alpha left out) */
  hex: string;
  /** rgba(r, g, b, a) with the paint's opacity applied */
  rgba: string;
  alpha: number;
  /** Where it's used: fill, stroke, shadow, text, gradient */
  use: "fill" | "stroke" | "shadow" | "text" | "gradient";
}

/** Every colour a layer uses (its own paints; `deep` also walks its children), without repeats. */
export function colorValues(n: RNode, deep = false): ColorValue[] {
  const out: ColorValue[] = [];
  const seen = new Set<string>();
  const push = (color: string, opacity: number, use: ColorValue["use"]) => {
    const c = parseColor(color);
    if (!c) return;
    const a = Math.round(c.a * opacity * 1000) / 1000;
    const v: ColorValue = { hex: toHex(c), rgba: toRgba({ ...c, a }), alpha: a, use };
    const key = `${v.rgba}|${use}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  const visit = (x: RNode) => {
    for (const f of x.fills) {
      if (f.visible === false) continue;
      if (f.type === "solid") push(f.color, f.opacity ?? 1, x.type === "text" ? "text" : "fill");
      else for (const s of f.stops) push(s.color, f.opacity ?? 1, "gradient");
    }
    for (const s of x.strokes) if (s.visible !== false) push(s.color, 1, "stroke");
    for (const e of x.effects ?? []) if (e.visible !== false && e.type !== "layer-blur") push(e.color, 1, "shadow");
    if (deep) for (const c of x.children) if (c.visible !== false) visit(c);
  };
  visit(n);
  return out;
}
