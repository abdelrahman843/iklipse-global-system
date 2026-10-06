import type { WbItem } from "./types";

/** Frames in presentation order: data.order first, then top to bottom, left to right. */
export function orderedFrames(items: Record<string, WbItem>): WbItem[] {
  const ord = (f: WbItem) => (typeof f.data.order === "number" && Number.isFinite(f.data.order) ? f.data.order : Infinity);
  return Object.values(items)
    .filter((it) => it.type === "frame")
    .sort((a, b) => {
      const oa = ord(a);
      const ob = ord(b);
      if (oa !== ob) return oa < ob ? -1 : 1;
      return a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1);
    });
}
