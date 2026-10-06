import type { Cap, ConnectorEnd, ConnectorKind, ItemType, ShapeKind, WbItem } from "./types";
import { DEFAULT_STICKY } from "./types";
import { maxZ, newId, useWb } from "./store";
import { measureTextHeight, measureTextWidth, LINE_HEIGHT } from "./text";

// Default items, sized like Miro's at 100% zoom.

export const STICKY_SIZE = 200;
export const TEXT_SIZE = 20;

function base(type: ItemType, x: number, y: number, w: number, h: number, data: Record<string, unknown>, z?: number): WbItem {
  const s = useWb.getState();
  return {
    id: newId(),
    board_id: s.boardId!,
    type,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    w: Math.round(w * 100) / 100,
    h: Math.round(h * 100) / 100,
    rotation: 0,
    z: z ?? maxZ(s) + 1,
    frame_id: null,
    group_id: null,
    locked: false,
    data,
  };
}

/** Centre-placed sticky note. */
export function makeSticky(cx: number, cy: number, fill = DEFAULT_STICKY, text = "", z?: number, size = STICKY_SIZE): WbItem {
  return base("sticky", cx - size / 2, cy - size / 2, size, size, { text, fill, fontSize: "auto", align: "center", valign: "middle" }, z);
}

export function makeShape(shape: ShapeKind, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}, z?: number): WbItem {
  return base(
    "shape",
    x,
    y,
    w,
    h,
    { shape, fill: "surface", stroke: "ink", strokeWidth: 2, dash: "solid", text: "", fontSize: 16, align: "center", valign: "middle", ...extra },
    z,
  );
}

export function makeText(x: number, y: number, text = "", fontSize = TEXT_SIZE, extra: Record<string, unknown> = {}, z?: number): WbItem {
  const w = Math.max(40, measureTextWidth(text || "Text", fontSize) + 4);
  return base("text", x, y, w, Math.ceil(fontSize * LINE_HEIGHT), { text, fontSize, color: "ink", align: "left", autoWidth: true, ...extra }, z);
}

/** Text with a fixed width (wraps). */
export function makeTextBox(x: number, y: number, w: number, text: string, fontSize = TEXT_SIZE, extra: Record<string, unknown> = {}, z?: number): WbItem {
  const h = Math.max(Math.ceil(fontSize * LINE_HEIGHT), Math.ceil(measureTextHeight(text, w, fontSize)));
  return base("text", x, y, w, h, { text, fontSize, color: "ink", align: "left", ...extra }, z);
}

export function makeFrame(x: number, y: number, w: number, h: number, title?: string, fill = "surface"): WbItem {
  const s = useWb.getState();
  const n = Object.values(s.items).filter((i) => i.type === "frame").length + 1;
  // Frames sit under everything else.
  let z = 0;
  for (const it of Object.values(s.items)) if (it.z < z) z = it.z;
  return base("frame", x, y, w, h, { title: title ?? `Frame ${n}`, fill }, z - 1);
}

export function makeConnector(
  start: ConnectorEnd,
  end: ConnectorEnd,
  kind: ConnectorKind = "curved",
  endCap: Cap = "arrow",
  extra: Record<string, unknown> = {},
  z?: number,
): WbItem {
  return base("connector", 0, 0, 0, 0, { start, end, kind, color: "ink", width: 2, dash: "solid", startCap: "none", endCap, ...extra }, z);
}

export function makePen(points: number[], x: number, y: number, w: number, h: number, color: string, width: number, highlighter = false): WbItem {
  return base("pen", x, y, Math.max(w, 1), Math.max(h, 1), { points, color, width, highlighter, bw: Math.max(w, 1), bh: Math.max(h, 1) });
}

export function makeCard(x: number, y: number, title = "", extra: Record<string, unknown> = {}, z?: number): WbItem {
  return base("card", x, y, 320, 140, { title, description: "", fill: "#579dff", assignee: null, due: null, ...extra }, z);
}

export function makeEmoji(cx: number, cy: number, emoji: string, size = 72): WbItem {
  return base("emoji", cx - size / 2, cy - size / 2, size, size, { emoji });
}

export function makeImage(cx: number, cy: number, path: string, nw: number, nh: number, name?: string): WbItem {
  const s = useWb.getState();
  // Fit roughly a third of the screen at the current zoom.
  const maxW = Math.max(200, (s.screen.w * 0.4) / s.viewport.zoom);
  const k = Math.min(1, maxW / nw);
  const w = nw * k;
  const h = nh * k;
  return base("image", cx - w / 2, cy - h / 2, w, h, { path, nw, nh, name });
}
