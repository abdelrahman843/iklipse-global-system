import { FONT_STACK, type FontFamily } from "./types";

// -----------------------------------------------------------------------------
// Text measuring for auto-sized text (stickies and shapes shrink their font to
// fit, like Miro) and for the PNG export, which draws text on a canvas. The DOM
// renders with the same line height and wrapping rules, so both agree closely.
// -----------------------------------------------------------------------------

export const LINE_HEIGHT = 1.3;

let ctx: CanvasRenderingContext2D | null = null;
function measureCtx() {
  if (!ctx) ctx = document.createElement("canvas").getContext("2d");
  return ctx!;
}

export function fontString(size: number, font: FontFamily = "sans", bold = false, italic = false) {
  return `${italic ? "italic " : ""}${bold ? "700 " : "400 "}${size}px ${FONT_STACK[font]}`;
}

/** Break text into lines no wider than maxW (explicit newlines kept, long words split). */
export function wrapText(c: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (c.measureText(next).width <= maxW || !line.trim()) {
        if (c.measureText(next).width > maxW && !line.trim()) {
          // A single word longer than the line: split it by characters.
          let chunk = line;
          for (const ch of w) {
            if (c.measureText(chunk + ch).width > maxW && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = next;
      } else {
        out.push(line.trimEnd());
        line = w.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const fitCache = new Map<string, number>();

/** Largest font size (px) at which the text fits in w x h. */
export function fitFontSize(
  text: string,
  w: number,
  h: number,
  opts: { font?: FontFamily; bold?: boolean; italic?: boolean; max?: number; min?: number } = {},
): number {
  const max = opts.max ?? 64;
  const min = opts.min ?? 4;
  const t = text || "M";
  const key = `${t}|${Math.round(w)}|${Math.round(h)}|${opts.font}|${opts.bold}|${opts.italic}|${max}`;
  const hit = fitCache.get(key);
  if (hit) return hit;
  const c = measureCtx();
  const fits = (s: number) => {
    c.font = fontString(s, opts.font, opts.bold, opts.italic);
    const lines = wrapText(c, t, w);
    const widest = Math.max(...lines.map((l) => c.measureText(l).width));
    return lines.length * s * LINE_HEIGHT <= h && widest <= w;
  };
  // Start near the answer (text area vs box area), then narrow it down.
  const guess = Math.sqrt((w * h) / Math.max(1, t.length * 0.5 * LINE_HEIGHT));
  let lo = Math.max(min, Math.min(max, guess * 0.5));
  let hi = Math.min(max, Math.max(lo + 1, guess * 1.6));
  if (!fits(lo)) lo = min;
  if (fits(hi)) {
    lo = hi;
    if (hi < max && fits(max)) lo = max;
  } else {
    for (let i = 0; i < 8 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
  }
  const size = Math.max(min, Math.floor(lo * 0.94 * 2) / 2);
  if (fitCache.size > 4000) fitCache.clear();
  fitCache.set(key, size);
  return size;
}

/** Natural width of text set on one line per paragraph (auto-width text items). */
export function measureTextWidth(text: string, size: number, font: FontFamily = "sans", bold = false, italic = false) {
  const c = measureCtx();
  c.font = fontString(size, font, bold, italic);
  return Math.max(...(text || " ").split("\n").map((l) => c.measureText(l || " ").width));
}

/** Height the text takes when wrapped to width w. */
export function measureTextHeight(text: string, w: number, size: number, font: FontFamily = "sans", bold = false, italic = false) {
  const c = measureCtx();
  c.font = fontString(size, font, bold, italic);
  return wrapText(c, text || " ", Math.max(1, w)).length * size * LINE_HEIGHT;
}

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g;

/** Split text into plain and link pieces (links render as anchors when not editing). */
export function linkify(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ text: text.slice(last, i) });
    parts.push({ text: m[0], href: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
