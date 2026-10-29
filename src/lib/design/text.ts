import type { TextProps } from "./types";

// -----------------------------------------------------------------------------
// Text measuring and line breaking for text layers. The renderer, the layout
// engine (hug sizes) and the exporters all use the same lines, so what's on
// the canvas is what gets exported. Measuring uses a canvas 2D context; tests
// (and anything without a DOM) can swap in their own measurer.
// -----------------------------------------------------------------------------

export type Measure = (text: string, font: string, letterSpacing: number) => number;

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

const canvasMeasure: Measure = (text, font, letterSpacing) => {
  const key = `${font}|${letterSpacing}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (!ctx && typeof document !== "undefined") ctx = document.createElement("canvas").getContext("2d");
  let w: number;
  if (ctx) {
    ctx.font = font;
    w = ctx.measureText(text).width + letterSpacing * text.length;
  } else {
    // No DOM: a rough average glyph width.
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    w = text.length * size * 0.55 + letterSpacing * text.length;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(key, w);
  return w;
};

let measure: Measure = canvasMeasure;

/** Tests: use a deterministic measurer. Pass null to restore the canvas one. */
export function setMeasure(fn: Measure | null) {
  measure = fn ?? canvasMeasure;
  cache.clear();
}

export function cssFont(t: Pick<TextProps, "fontFamily" | "fontWeight" | "fontSize" | "italic">) {
  const fam = /[\s]/.test(t.fontFamily) && !/^["']/.test(t.fontFamily) ? `"${t.fontFamily}"` : t.fontFamily;
  return `${t.italic ? "italic " : ""}${t.fontWeight} ${t.fontSize}px ${fam}, system-ui, sans-serif`;
}

export function lineHeightOf(t: Pick<TextProps, "fontSize" | "lineHeight">) {
  return t.lineHeight && t.lineHeight > 0 ? t.lineHeight : Math.round(t.fontSize * 1.2 * 100) / 100;
}

export function transformText(s: string, tr: TextProps["transform"]) {
  if (tr === "upper") return s.toUpperCase();
  if (tr === "lower") return s.toLowerCase();
  if (tr === "title") return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return s;
}

export interface TextLayout {
  lines: { text: string; width: number }[];
  width: number;
  height: number;
  lineHeight: number;
}

/**
 * Break `t.content` into lines. `maxWidth` wraps (auto-height / fixed);
 * undefined keeps each paragraph on one line (auto-width).
 */
export function layoutText(t: TextProps, maxWidth?: number): TextLayout {
  const font = cssFont(t);
  const ls = t.letterSpacing ?? 0;
  const lh = lineHeightOf(t);
  const content = transformText(t.content ?? "", t.transform);
  const out: { text: string; width: number }[] = [];
  for (const para of content.split("\n")) {
    if (maxWidth === undefined || maxWidth <= 0) {
      out.push({ text: para, width: measure(para, font, ls) });
      continue;
    }
    // Greedy wrap on spaces; a word longer than the line breaks by characters.
    const words = para.split(/(\s+)/);
    let line = "";
    let lineW = 0;
    const push = () => {
      const trimmed = line.replace(/\s+$/, "");
      out.push({ text: trimmed, width: measure(trimmed, font, ls) });
      line = "";
      lineW = 0;
    };
    for (const word of words) {
      if (!word) continue;
      const ww = measure(word, font, ls);
      if (lineW + ww <= maxWidth || (!line && /^\s+$/.test(word))) {
        line += word;
        lineW += ww;
        continue;
      }
      if (/^\s+$/.test(word)) {
        push();
        continue;
      }
      if (line) push();
      if (ww <= maxWidth) {
        line = word;
        lineW = ww;
        continue;
      }
      // Very long word: split it.
      let chunk = "";
      for (const ch of word) {
        const cw = measure(chunk + ch, font, ls);
        if (cw > maxWidth && chunk) {
          out.push({ text: chunk, width: measure(chunk, font, ls) });
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
      lineW = measure(chunk, font, ls);
    }
    if (line || !out.length || para === "") push();
  }
  const width = out.reduce((m, l) => Math.max(m, l.width), 0);
  return { lines: out, width, height: out.length * lh, lineHeight: lh };
}

/** The box a text layer takes for its resize mode. */
export function textBox(t: TextProps, w: number, h: number): { w: number; h: number; layout: TextLayout } {
  if (t.resize === "auto-width") {
    const layout = layoutText(t);
    return { w: Math.ceil(layout.width), h: Math.ceil(layout.height), layout };
  }
  const layout = layoutText(t, w);
  if (t.resize === "auto-height") return { w, h: Math.ceil(layout.height), layout };
  return { w, h, layout };
}
