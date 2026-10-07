import type { WbPreview } from "./api";
import type { WbItem } from "./types";
import { str } from "./types";
import { connectorGeometry, geomBounds, unionRects } from "./geometry";

/** Small sketch of the board for the whiteboards grid (largest items first, capped). */
export function buildPreview(items: Record<string, WbItem>): WbPreview | null {
  const list = Object.values(items);
  if (!list.length) return null;
  const geomOf = (id: string) => items[id] ?? null;
  const boxes = list.map((it) => {
    if (it.type === "connector") return connectorGeometry(it.data, geomOf).bounds;
    return geomBounds(it);
  });
  const all = unionRects(boxes)!;
  const W = 320;
  const H = 180;
  const k = Math.min(W / Math.max(all.w, 1), H / Math.max(all.h, 1));
  const ox = (W - all.w * k) / 2;
  const oy = (H - all.h * k) / 2;
  const r: WbPreview["r"] = [];
  const order = list
    .map((it, i) => ({ it, b: boxes[i]! }))
    .sort((a, b) => (a.it.type === "frame" ? -1 : 0) - (b.it.type === "frame" ? -1 : 0) || a.it.z - b.it.z);
  for (const { it, b } of order) {
    if (r.length >= 400) break;
    const x = Math.round((ox + (b.x - all.x) * k) * 10) / 10;
    const y = Math.round((oy + (b.y - all.y) * k) * 10) / 10;
    const w = Math.max(1, Math.round(b.w * k * 10) / 10);
    const h = Math.max(1, Math.round(b.h * k * 10) / 10);
    if (it.type === "frame") r.push([x, y, w, h, str(it.data.fill, "surface"), 1]);
    else if (it.type === "connector" || it.type === "pen") r.push([x, y, w, h, str(it.data.color, "ink"), 2]);
    else if (it.type === "text") r.push([x, y, w, h, str(it.data.color, "ink"), 3]);
    else if (it.type === "sticky") r.push([x, y, w, h, str(it.data.fill, "#f5cd47"), 0]);
    else if (it.type === "shape") r.push([x, y, w, h, str(it.data.fill, "surface") === "none" ? str(it.data.stroke, "ink") : str(it.data.fill, "surface"), 0]);
    else if (it.type === "card" || it.type === "doc" || it.type === "embed") r.push([x, y, w, h, "surface", 0]);
    else r.push([x, y, w, h, "#8590a2", 0]);
  }
  return { w: W, h: H, r };
}
