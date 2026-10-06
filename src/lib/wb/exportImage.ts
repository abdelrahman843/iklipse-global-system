import { useWb, type WbState } from "./store";
import {
  bool,
  num,
  str,
  textOn,
  FONT_STACK,
  type Align,
  type ConnectorData,
  type FontFamily,
  type Geom,
  type ShapeKind,
  type TextStyle,
  type VAlign,
  type WbItem,
} from "./types";
import { capPath, connectorGeometry, geomBounds, inflate, unionRects, type ConnectorGeometry, type Rect } from "./geometry";
import { shapePath, shapeTextBox } from "./shapes";
import { fitFontSize, fontString, wrapText, LINE_HEIGHT } from "./text";
import { imageUrl } from "./api";
import { createPalette, type Palette } from "./paint";

// -----------------------------------------------------------------------------
// PNG export: draws the board (or some items) onto a 2D canvas the same way
// ItemView renders them in the DOM, then downloads the file.
// -----------------------------------------------------------------------------

const PAD = 40;
const MAX_SIDE = 16384;
const MAX_PIXELS = 120_000_000;
/** Many browsers (Safari above all) refuse canvases bigger than this. */
const SAFE_PIXELS = 16_000_000;
const EMOJI_FONT = `${FONT_STACK.sans}, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"`;

type GeomFn = (id: string) => Geom | null;

interface Ctx {
  c: CanvasRenderingContext2D;
  P: Palette;
  /** Pixels per world unit (shadows ignore the transform, so they need it). */
  k: number;
  geomOf: GeomFn;
  images: Map<string, HTMLImageElement>;
  connectors: Map<string, ConnectorGeometry>;
}

/** Download the board (or the given items, with their frames' content) as a PNG. */
export async function exportPng({ ids, title, scale = 2 }: { ids?: string[]; title: string; scale?: number }): Promise<void> {
  const s = useWb.getState();
  const items = collect(s, ids);
  if (!items.length) throw new Error(ids?.length ? "There's nothing selected to export." : "The board is empty.");

  const geomOf: GeomFn = (id) => s.items[id] ?? null;
  const connectors = new Map<string, ConnectorGeometry>();
  for (const it of items) if (it.type === "connector") connectors.set(it.id, connectorGeometry(it.data as ConnectorData, geomOf));

  const bounds = unionRects(items.map((it) => itemBounds(it, connectors)));
  if (!bounds) throw new Error("The board is empty.");
  const world = inflate(bounds, PAD);

  try {
    await document.fonts?.ready;
  } catch {
    /* fonts API unavailable */
  }
  const images = await loadImages(items);

  let blob = await render(items, world, fitScale(world, scale, MAX_PIXELS), { geomOf, connectors, images });
  // Too big for this browser: try again within the safe size.
  if (!blob) blob = await render(items, world, fitScale(world, scale, SAFE_PIXELS), { geomOf, connectors, images });
  if (!blob) throw new Error("The image is too large for this browser. Try exporting a selection.");
  download(blob, `${safeName(title)}.png`);
}

function fitScale(r: Rect, want: number, maxPixels: number) {
  return Math.max(0.05, Math.min(want, MAX_SIDE / r.w, MAX_SIDE / r.h, Math.sqrt(maxPixels / (r.w * r.h))));
}

function collect(s: WbState, ids?: string[]): WbItem[] {
  if (!ids?.length) return Object.values(s.items);
  const out = new Set(ids.filter((id) => s.items[id]));
  for (const id of [...out]) {
    if (s.items[id]!.type !== "frame") continue;
    for (const it of Object.values(s.items)) if (it.frame_id === id) out.add(it.id);
  }
  return [...out].map((id) => s.items[id]!);
}

function frameTitleSize(w: number) {
  return Math.max(14, Math.min(40, Math.round(w / 64)));
}

function itemBounds(it: WbItem, connectors: Map<string, ConnectorGeometry>): Rect {
  if (it.type === "connector") {
    const geo = connectors.get(it.id)!;
    const w = num(it.data.width, 2);
    let r = inflate(geo.bounds, 6 + w * 3.2);
    const label = str(it.data.label);
    if (label) r = unionRects([r, { x: geo.mid.x - 150, y: geo.mid.y - 14, w: 300, h: 28 }])!;
    return r;
  }
  const b = geomBounds(it);
  if (it.type === "frame") {
    const t = frameTitleSize(it.w) * LINE_HEIGHT + 8;
    return { x: b.x, y: b.y - t, w: b.w, h: b.h + t };
  }
  if (it.type === "sticky") return inflate(b, 14);
  if (it.type === "pen") return inflate(b, num(it.data.width, 3));
  if (it.type === "shape") return inflate(b, num(it.data.strokeWidth, 2));
  return b;
}

async function render(
  items: WbItem[],
  world: Rect,
  k: number,
  shared: Pick<Ctx, "geomOf" | "connectors" | "images">,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(world.w * k));
  canvas.height = Math.max(1, Math.round(world.h * k));
  const c = canvas.getContext("2d");
  if (!c) return null;
  const P = createPalette();
  c.fillStyle = P.theme("--c-bg");
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.setTransform(k, 0, 0, k, -world.x * k, -world.y * k);
  c.textBaseline = "middle";

  const ctx: Ctx = { c, P, k, ...shared };
  // Paint order matches the canvas: frames first, then by z.
  const order = [...items].sort((a, b) => (a.type === "frame" ? 0 : 1) - (b.type === "frame" ? 0 : 1) || a.z - b.z || (a.id < b.id ? -1 : 1));
  for (const it of order) {
    c.save();
    try {
      drawItem(ctx, it);
    } catch {
      /* one bad item shouldn't spoil the export */
    }
    c.restore();
  }

  try {
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } catch {
    throw new Error("An image on the board blocked the export.");
  } finally {
    // Free the bitmap right away (large exports hold a lot of memory).
    canvas.width = 0;
    canvas.height = 0;
  }
}

function drawItem(ctx: Ctx, it: WbItem) {
  const { c } = ctx;
  if (it.type === "connector") return drawConnector(ctx, it);
  // Box items: local coordinates (0,0)-(w,h), turned around the centre.
  c.translate(it.x + it.w / 2, it.y + it.h / 2);
  if (it.rotation) c.rotate((it.rotation * Math.PI) / 180);
  c.translate(-it.w / 2, -it.h / 2);
  switch (it.type) {
    case "sticky":
      return drawSticky(ctx, it);
    case "shape":
      return drawShape(ctx, it);
    case "text":
      return drawTextItem(ctx, it);
    case "frame":
      return drawFrame(ctx, it);
    case "image":
      return drawImage(ctx, it);
    case "pen":
      return drawPen(ctx, it);
    case "card":
      return drawCard(ctx, it);
    case "emoji":
      return drawEmoji(ctx, it);
  }
}

// ------------------------------------------------------------------- text --
function drawText(
  ctx: Ctx,
  text: string,
  box: Rect,
  st: TextStyle,
  size: number,
  color: string,
  def: { align: Align; valign: VAlign },
  maxLines = Infinity,
) {
  if (!text) return;
  const { c } = ctx;
  c.font = fontString(size, (st.font as FontFamily) ?? "sans", !!st.bold, !!st.italic);
  c.fillStyle = color;
  c.textBaseline = "middle";
  let lines = wrapText(c, text, Math.max(1, box.w));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = ellipsize(c, `${lines[maxLines - 1]}…`, box.w);
  }
  const lh = size * LINE_HEIGHT;
  const total = lines.length * lh;
  const valign = st.valign ?? def.valign;
  const top = valign === "top" ? box.y : valign === "bottom" ? box.y + box.h - total : box.y + (box.h - total) / 2;
  const align = st.align ?? def.align;
  c.textAlign = align;
  const x = align === "left" ? box.x : align === "right" ? box.x + box.w : box.x + box.w / 2;
  const t = Math.max(1, size / 15);
  lines.forEach((line, i) => {
    const y = top + i * lh + lh / 2;
    c.fillText(line, x, y);
    if ((st.underline || st.strike) && line) {
      const w = c.measureText(line).width;
      const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
      if (st.underline) c.fillRect(x0, y + size * 0.42, w, t);
      if (st.strike) c.fillRect(x0, y - t / 2 + size * 0.04, w, t);
    }
  });
}

function ellipsize(c: CanvasRenderingContext2D, text: string, maxW: number) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text.replace(/…$/, "");
  while (t.length > 1 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

function autoSize(st: TextStyle, text: string, w: number, h: number, max: number, fallback: number) {
  if (st.fontSize === "auto" || st.fontSize == null) {
    return fitFontSize(text, w, h, { font: (st.font as FontFamily) ?? "sans", bold: st.bold, italic: st.italic, max });
  }
  return num(st.fontSize, fallback);
}

function dash(d: unknown, w: number): number[] {
  return d === "dashed" ? [w * 4, w * 3] : d === "dotted" ? [w, w * 2] : [];
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// ----------------------------------------------------------------- sticky --
function drawSticky(ctx: Ctx, it: WbItem) {
  const { c, P, k } = ctx;
  const d = it.data as TextStyle & { fill?: string };
  const fillTok = str(d.fill, "#f5cd47");
  const fill = P.token(fillTok) ?? "#f5cd47";
  c.save();
  c.shadowColor = "rgba(0, 0, 0, 0.18)";
  c.shadowBlur = 12 * k;
  c.shadowOffsetY = 4 * k;
  c.fillStyle = fill;
  c.fillRect(0, 0, it.w, it.h);
  c.restore();
  c.save();
  c.shadowColor = "rgba(0, 0, 0, 0.12)";
  c.shadowBlur = 2 * k;
  c.shadowOffsetY = 1 * k;
  c.fillStyle = fill;
  c.fillRect(0, 0, it.w, it.h);
  c.restore();
  const pad = Math.max(8, it.w * 0.07);
  const box = { x: pad, y: pad, w: it.w - pad * 2, h: it.h - pad * 2 };
  const text = str(d.text);
  const color = d.color ? (P.token(d.color) ?? P.theme("--c-ink")) : P.css(textOn(fillTok));
  const size = autoSize(d, text, box.w, box.h, Math.min(96, it.w * 0.28), 16);
  drawText(ctx, text, box, d, size, color, { align: "center", valign: "middle" });
}

// ------------------------------------------------------------------ shape --
function drawShape(ctx: Ctx, it: WbItem) {
  const { c, P } = ctx;
  const d = it.data as TextStyle & { shape?: ShapeKind; fill?: string; stroke?: string; strokeWidth?: number; dash?: string; opacity?: number };
  const kind = (d.shape ?? "rect") as ShapeKind;
  const path = new Path2D(shapePath(kind, it.w, it.h));
  const fillTok = str(d.fill, "surface");
  const fill = P.token(fillTok);
  if (fill) {
    c.globalAlpha = Math.max(0, Math.min(1, num(d.opacity, 1)));
    c.fillStyle = fill;
    c.fill(path);
    c.globalAlpha = 1;
  }
  const sw = num(d.strokeWidth, 2);
  const stroke = sw > 0 ? P.token(str(d.stroke, "ink")) : null;
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = sw;
    c.lineJoin = "round";
    c.setLineDash(dash(d.dash, sw));
    c.stroke(path);
    c.setLineDash([]);
  }
  const text = str(d.text);
  if (!text) return;
  const tb = shapeTextBox(kind, it.w, it.h);
  const color = d.color ? (P.token(d.color) ?? P.theme("--c-ink")) : P.css(textOn(fillTok === "none" ? null : fillTok));
  const size = autoSize(d, text, tb.w, tb.h, 64, 16);
  drawText(ctx, text, tb, d, size, color, { align: "center", valign: "middle" });
}

// ------------------------------------------------------------------- text --
function drawTextItem(ctx: Ctx, it: WbItem) {
  const { c, P } = ctx;
  const d = it.data as TextStyle & { fill?: string };
  const bg = P.token(str(d.fill, "none"));
  if (bg) {
    c.fillStyle = bg;
    c.fillRect(0, 0, it.w, it.h);
  }
  const size = num(d.fontSize, 20);
  const color = P.token(str(d.color, "ink")) ?? P.theme("--c-ink");
  drawText(ctx, str(d.text), { x: 0, y: 0, w: it.w, h: it.h }, { ...d, valign: "top" }, size, color, { align: "left", valign: "top" });
}

// ------------------------------------------------------------------ frame --
function drawFrame(ctx: Ctx, it: WbItem) {
  const { c, P } = ctx;
  const fill = P.token(str(it.data.fill, "surface"));
  if (fill) {
    c.fillStyle = fill;
    c.fillRect(0, 0, it.w, it.h);
  }
  c.strokeStyle = P.theme("--c-border");
  c.lineWidth = 1;
  c.strokeRect(-0.5, -0.5, it.w + 1, it.h + 1);
  const title = str(it.data.title, "Frame");
  if (!title) return;
  const size = frameTitleSize(it.w);
  c.font = fontString(size, "sans");
  c.fillStyle = P.theme("--c-subtle");
  c.textAlign = "left";
  c.textBaseline = "bottom";
  c.fillText(ellipsize(c, title, Math.max(size * 4, it.w)), 0, -6);
}

// ------------------------------------------------------------------ image --
function drawImage(ctx: Ctx, it: WbItem) {
  const img = ctx.images.get(str(it.data.path));
  if (img) ctx.c.drawImage(img, 0, 0, it.w, it.h);
}

async function loadImages(items: WbItem[]): Promise<Map<string, HTMLImageElement>> {
  const paths = [...new Set(items.filter((i) => i.type === "image").map((i) => str(i.data.path)).filter(Boolean))];
  const out = new Map<string, HTMLImageElement>();
  await Promise.all(
    paths.map(async (p) => {
      const url = await imageUrl(p).catch(() => null);
      if (!url) return;
      const img = await loadImage(url);
      if (img) out.set(p, img);
    }),
  );
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const t = setTimeout(() => resolve(null), 20_000);
    img.onload = () => {
      clearTimeout(t);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(t);
      resolve(null);
    };
    img.src = url;
  });
}

// -------------------------------------------------------------------- pen --
/** Same smoothing as the DOM pen path (quadratic through midpoints). */
function penD(points: number[], sx: number, sy: number): string {
  if (points.length < 2) return "";
  const P = (i: number) => ({ x: points[i]! * sx, y: points[i + 1]! * sy });
  if (points.length <= 4) {
    const a = P(0);
    const b = points.length === 4 ? P(2) : a;
    return `M${a.x},${a.y} L${b.x + 0.01},${b.y}`;
  }
  let d = `M${P(0).x},${P(0).y}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const a = P(i);
    const b = P(i + 2);
    d += ` Q${a.x},${a.y} ${(a.x + b.x) / 2},${(a.y + b.y) / 2}`;
  }
  const last = P(points.length - 2);
  return `${d} L${last.x},${last.y}`;
}

function drawPen(ctx: Ctx, it: WbItem) {
  const { c, P } = ctx;
  const pts = Array.isArray(it.data.points) ? (it.data.points as number[]) : [];
  const d = penD(pts, it.w / Math.max(1, num(it.data.bw, it.w)), it.h / Math.max(1, num(it.data.bh, it.h)));
  if (!d) return;
  const hl = bool(it.data.highlighter);
  c.globalAlpha = hl ? 0.45 : 1;
  c.strokeStyle = P.token(str(it.data.color, "ink")) ?? P.theme("--c-ink");
  c.lineWidth = num(it.data.width, 3);
  c.lineCap = hl ? "square" : "round";
  c.lineJoin = "round";
  c.stroke(new Path2D(d));
  c.globalAlpha = 1;
}

// -------------------------------------------------------------- connector --
function drawConnector(ctx: Ctx, it: WbItem) {
  const { c, P } = ctx;
  const d = it.data as ConnectorData;
  const geo = ctx.connectors.get(it.id) ?? connectorGeometry(d, ctx.geomOf);
  const width = num(d.width, 2);
  const color = P.token(str(d.color, "ink")) ?? P.theme("--c-ink");
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = width;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.setLineDash(dash(d.dash, width));
  c.stroke(new Path2D(geo.d));
  c.setLineDash([]);
  const caps: [string, ConnectorGeometry["start"], number][] = [
    [str(d.startCap, "none"), geo.start, geo.startAngle],
    [str(d.endCap, "arrow"), geo.end, geo.endAngle],
  ];
  for (const [cap, p, angle] of caps) {
    const cp = capPath(cap, p, angle, width);
    if (!cp) continue;
    const path = new Path2D(cp.d);
    if (cp.filled) c.fill(path);
    c.stroke(path);
  }
  const label = str(d.label);
  if (!label) return;
  c.font = fontString(12, "sans");
  const text = ellipsize(c, label.replace(/\n/g, " "), 268);
  const tw = c.measureText(text).width;
  const bw = tw + 12;
  const bh = 12 * 1.4 + 4;
  c.fillStyle = P.theme("--c-bg");
  roundRect(c, geo.mid.x - bw / 2, geo.mid.y - bh / 2, bw, bh, 6);
  c.fill();
  c.fillStyle = P.theme("--c-ink");
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text, geo.mid.x, geo.mid.y);
}

// ------------------------------------------------------------------- card --
function drawCard(ctx: Ctx, it: WbItem) {
  const { c, P, k } = ctx;
  const d = it.data as { title?: string; description?: string; fill?: string; due?: string | null; done?: boolean };
  const { w, h } = it;
  c.save();
  c.shadowColor = P.theme("--c-shadow", 0.1);
  c.shadowBlur = 4 * k;
  c.shadowOffsetY = 1 * k;
  roundRect(c, 0, 0, w, h, 8);
  c.fillStyle = P.theme("--c-surface");
  c.fill();
  c.restore();
  c.save();
  roundRect(c, 0, 0, w, h, 8);
  c.clip();
  c.fillStyle = P.token(str(d.fill, "#579dff")) ?? "#579dff";
  c.fillRect(0, 0, 6, h);
  c.restore();
  roundRect(c, 0.5, 0.5, w - 1, h - 1, 8);
  c.strokeStyle = P.theme("--c-border");
  c.lineWidth = 1;
  c.stroke();

  const x0 = 6 + 12;
  const cw = Math.max(10, w - 6 - 24);
  let y = 12;
  const title = str(d.title);
  if (title) {
    c.font = fontString(16, "sans", true);
    const lines = wrapText(c, title, cw);
    const tlh = 16 * LINE_HEIGHT;
    drawText(
      ctx,
      title,
      { x: x0, y, w: cw, h: lines.length * tlh },
      { bold: true, strike: !!d.done },
      16,
      d.done ? P.theme("--c-ink", 0.6) : P.theme("--c-ink"),
      { align: "left", valign: "top" },
    );
    y += lines.length * tlh + 6;
  }
  const desc = str(d.description);
  const footer = 22;
  if (desc) {
    const room = h - y - 12 - footer;
    const maxLines = Math.max(0, Math.min(3, Math.floor(room / (12 * LINE_HEIGHT))));
    if (maxLines > 0) {
      drawText(ctx, desc, { x: x0, y, w: cw, h: room }, {}, 12, P.theme("--c-muted"), { align: "left", valign: "top" }, maxLines);
    }
  }
  // Footer: done tick and due date.
  let fx = x0;
  const fy = h - 12 - 11;
  if (d.done) {
    c.strokeStyle = P.theme("--c-success");
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(fx + 7, fy, 6, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(fx + 4.2, fy + 0.2);
    c.lineTo(fx + 6.3, fy + 2.3);
    c.lineTo(fx + 9.8, fy - 2.2);
    c.stroke();
    fx += 22;
  }
  if (d.due) {
    const date = new Date(`${d.due}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      const overdue = !d.done && new Date(`${d.due}T23:59:59`) < new Date();
      const label = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      c.font = fontString(11, "sans");
      const tw = c.measureText(label).width;
      c.fillStyle = overdue ? P.theme("--c-danger", 0.15) : P.theme("--c-inset");
      roundRect(c, fx, fy - 9, tw + 12, 18, 4);
      c.fill();
      c.fillStyle = overdue ? P.theme("--c-danger") : P.theme("--c-subtle");
      c.textAlign = "left";
      c.textBaseline = "middle";
      c.fillText(label, fx + 6, fy);
    }
  }
}

// ------------------------------------------------------------------ emoji --
function drawEmoji(ctx: Ctx, it: WbItem) {
  const { c, P } = ctx;
  const size = Math.min(it.w, it.h) * 0.82;
  c.font = `${size}px ${EMOJI_FONT}`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = P.theme("--c-ink");
  c.fillText(str(it.data.emoji, "👍"), it.w / 2, it.h / 2 + size * 0.04);
}

// --------------------------------------------------------------- download --
function safeName(title: string) {
  const printable = [...title].filter((ch) => ch.charCodeAt(0) >= 32).join("");
  const t = printable
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return t || "miro-board";
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
