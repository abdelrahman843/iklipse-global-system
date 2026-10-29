import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeSvg, RenderProvider, type RenderCtx } from "@/components/design/Render";
import { imageUrl } from "@/lib/wb/api";
import { buildPdf, type PdfPage } from "@/lib/wb/exportImage";
import { saveBlob } from "@/lib/nativeApp";
import { childIndex, resolveNode, walk, type RNode } from "./layout";
import type { DesignDoc } from "./types";

// -----------------------------------------------------------------------------
// Exports layers as SVG, PNG, JPG and PDF. Everything goes through the same
// SVG renderer as the canvas (Render.tsx, as static markup), so exports look
// like the canvas.
//
// - SVG: one self-contained file. Several layers sit side by side, left to
//   right with `gap` px between them, top-aligned. Images are inlined as
//   data: URLs. The size is each layer's box (a rotated layer: the box around
//   it); shadows and strokes outside that box are cut off, like Figma's
//   default export.
// - PNG / JPG: that SVG drawn on a canvas at `scale` (capped so the canvas
//   stays within what browsers allow). JPG gets a white background unless
//   one is given. Fonts: an SVG drawn through <img> can't use the page's
//   web fonts, so text uses the installed font or the fallback.
// - PDF: one page per layer, each a JPEG (the whiteboard's PDF writer,
//   exportImage.ts). Page size: 1 px = 0.75 pt (96 dpi), the long side capped
//   at 1440 pt, like the whiteboard's slide export.
// - exportLayers: PDF = one multi-page file; other formats = one file per
//   layer, downloaded one after another, named after the layers.
// -----------------------------------------------------------------------------

export type ExportFormat = "png" | "jpg" | "svg" | "pdf";

export interface SvgOptions {
  /** Space between layers when several go in one file (px). Default 20. */
  gap?: number;
  /** Fill behind everything (none by default: transparent). */
  background?: string;
  /** Inline images as data: URLs (default true). */
  inlineImages?: boolean;
}

export interface SvgResult {
  svg: string;
  w: number;
  h: number;
}

const MAX_SIDE = 16384;
const SAFE_PIXELS = 16_000_000;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Standalone SVG markup for one or more layers. */
export async function exportSvg(doc: DesignDoc, rootIds: string[], opts: SvgOptions = {}): Promise<string> {
  return (await buildSvg(doc, rootIds, opts)).svg;
}

/** exportSvg plus the size of the drawing (px). */
export async function buildSvg(doc: DesignDoc, rootIds: string[], opts: SvgOptions = {}): Promise<SvgResult> {
  const idx = childIndex(doc);
  const roots = rootIds.map((id) => resolveNode(doc, id, idx)).filter((r): r is RNode => !!r);
  if (!roots.length) throw new Error("There's nothing to export.");
  const gap = opts.gap ?? 20;

  // Each layer at its own origin (rotated ones: the box around them), side by side.
  let x = 0;
  let h = 0;
  const placed = roots.map((r) => {
    const a = (r.rotation * Math.PI) / 180;
    const bw = Math.abs(r.w * Math.cos(a)) + Math.abs(r.h * Math.sin(a));
    const bh = Math.abs(r.w * Math.sin(a)) + Math.abs(r.h * Math.cos(a));
    const n: RNode = { ...r, x: x + (bw - r.w) / 2, y: (bh - r.h) / 2, visible: true };
    x += bw + gap;
    h = Math.max(h, bh);
    return n;
  });
  const w = Math.max(1, Math.ceil(x - gap));
  h = Math.max(1, Math.ceil(h));

  const images = opts.inlineImages === false ? new Map<string, string>() : await inlineImages(placed);
  const ctx: RenderCtx = {
    prefix: "x",
    // Missing images draw as the placeholder rather than a link that expires.
    img: (src) => (src.startsWith("data:") ? src : (images.get(src) ?? (opts.inlineImages === false ? null : ""))),
  };
  const body = renderToStaticMarkup(
    createElement(RenderProvider, {
      value: ctx,
      children: placed.map((n) => createElement(NodeSvg, { key: n.rid, n })),
    }),
  );
  const bg = opts.background ? `<rect width="${w}" height="${h}" fill="${escapeAttr(opts.background)}"/>` : "";
  const svg = `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${bg}${body}</svg>`;
  return { svg, w, h };
}

/** Every image source in the trees → a data: URL (storage paths fetched through signed URLs). */
async function inlineImages(roots: RNode[]): Promise<Map<string, string>> {
  const srcs = new Set<string>();
  walk(roots, (n) => {
    if (n.image?.src && !n.image.src.startsWith("data:")) srcs.add(n.image.src);
  });
  const out = new Map<string, string>();
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        const url = src.startsWith("blob:") || /^https?:/.test(src) ? src : await imageUrl(src);
        if (!url) return;
        const res = await fetch(url);
        if (!res.ok) return;
        out.set(src, await blobToDataUrl(await res.blob()));
      } catch {
        /* one missing image shouldn't stop the export */
      }
    }),
  );
  return out;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
}

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ------------------------------------------------------------------- raster --
export interface RasterOptions {
  format: "png" | "jpg";
  scale: number;
  background?: string;
}

/** Scale capped so the canvas fits what browsers allow. */
export function fitScale(w: number, h: number, want: number, maxPixels = SAFE_PIXELS) {
  return Math.max(0.01, Math.min(want, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(maxPixels / (w * h))));
}

/** One layer as a PNG / JPG blob. */
export async function exportRaster(doc: DesignDoc, rootId: string, opts: RasterOptions): Promise<Blob> {
  return (await rasterize(doc, rootId, opts)).blob;
}

async function rasterize(doc: DesignDoc, rootId: string, opts: RasterOptions, maxPixels = SAFE_PIXELS): Promise<{ blob: Blob; w: number; h: number; pw: number; ph: number }> {
  const { svg, w, h } = await buildSvg(doc, [rootId]);
  const k = fitScale(w, h, opts.scale, maxPixels);
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const img = await loadSvgImage(svg);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("This browser can't draw the export.");
  const bg = opts.background ?? (opts.format === "jpg" ? "#FFFFFF" : null);
  if (bg) {
    c.fillStyle = bg;
    c.fillRect(0, 0, cw, ch);
  }
  c.drawImage(img, 0, 0, cw, ch);
  const type = opts.format === "jpg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, 0.92));
  // Free the bitmap right away (large exports hold a lot of memory).
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("The image is too large for this browser. Try a smaller scale.");
  return { blob, w: cw, h: ch, pw: w, ph: h };
}

function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The layer couldn't be drawn for export."));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------- pdf --
/** PDF page size (pt) for a layer of w x h px: 0.75 pt per px, long side ≤ 1440 pt. */
export function pdfPageSize(w: number, h: number) {
  const pk = Math.min(0.75, 1440 / Math.max(w, h));
  return { pw: Math.round(w * pk * 100) / 100, ph: Math.round(h * pk * 100) / 100 };
}

/** A PDF from ready JPEG pages (pure; exportPdf rasterises, then calls this). */
export function pdfFromJpegs(pages: { jpeg: Uint8Array; w: number; h: number; layerW: number; layerH: number }[]): Uint8Array {
  const pp: PdfPage[] = pages.map((p) => ({ jpeg: p.jpeg, w: p.w, h: p.h, ...pdfPageSize(p.layerW, p.layerH) }));
  return buildPdf(pp);
}

/** Layers as one PDF, a page each. */
export async function exportPdf(doc: DesignDoc, rootIds: string[], opts: { scale: number }): Promise<Blob> {
  if (!rootIds.length) throw new Error("There's nothing to export.");
  const pages: Parameters<typeof pdfFromJpegs>[0] = [];
  for (const id of rootIds) {
    const r = await rasterize(doc, id, { format: "jpg", scale: opts.scale }, SAFE_PIXELS / 2);
    pages.push({ jpeg: new Uint8Array(await r.blob.arrayBuffer()), w: r.w, h: r.h, layerW: r.pw, layerH: r.ph });
  }
  const bytes = pdfFromJpegs(pages);
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}

// ----------------------------------------------------------------- download --
/** Saves a file (browser download, or the iklipse app's save). */
export function downloadBlob(blob: Blob, filename: string) {
  return saveBlob(blob, filename);
}

/** A file name from a layer name: no path / reserved characters, never empty. */
export function safeFileName(name: string, fallback = "Export") {
  const printable = [...name].filter((ch) => ch.charCodeAt(0) >= 32).join("");
  const t = printable
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return t || fallback;
}

/** File names for layers, made unique ("Card", "Card 2"), with a "@2x" suffix for scaled rasters. */
export function exportFileNames(names: string[], format: ExportFormat, scale: number) {
  const used = new Map<string, number>();
  const suffix = (format === "png" || format === "jpg") && scale !== 1 ? `@${Math.round(scale * 100) / 100}x` : "";
  return names.map((n) => {
    const base = safeFileName(n);
    const key = base.toLowerCase();
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    return `${base}${count > 1 ? ` ${count}` : ""}${suffix}.${format}`;
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exports layers and downloads the result: one PDF, or one file per layer. */
export async function exportLayers(doc: DesignDoc, ids: string[], opts: { format: ExportFormat; scale: number; name?: string }): Promise<void> {
  const layers = ids.filter((id) => doc.nodes[id]);
  if (!layers.length) throw new Error("Select a layer to export.");
  const names = layers.map((id) => doc.nodes[id]!.name);
  if (opts.format === "pdf") {
    const blob = await exportPdf(doc, layers, { scale: opts.scale });
    const name = opts.name ?? (layers.length === 1 ? names[0]! : `${names[0]!} and ${layers.length - 1} more`);
    await downloadBlob(blob, `${safeFileName(name)}.pdf`);
    return;
  }
  const files = exportFileNames(names, opts.format, opts.scale);
  for (let i = 0; i < layers.length; i++) {
    const id = layers[i]!;
    const blob =
      opts.format === "svg"
        ? new Blob([await exportSvg(doc, [id])], { type: "image/svg+xml" })
        : await exportRaster(doc, id, { format: opts.format, scale: opts.scale });
    await downloadBlob(blob, files[i]!);
    // Browsers drop downloads that start in the same instant.
    if (i < layers.length - 1) await pause(250);
  }
}
