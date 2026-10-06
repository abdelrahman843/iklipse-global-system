import type { WbItem } from "./types";
import { orderedFrames } from "./frames";
import { useWb, commit, mergeItem, maxZ, viewCenter } from "./store";
import { makeFrame, makeShape, makeTextBox } from "./factory";
import { geomBounds } from "./geometry";
import { placeCopies } from "./actions";

// -----------------------------------------------------------------------------
// Slides (Miro's presentation format): every frame is a slide, in frame order.
// New slides are 16:9 frames laid out in a row, each from a layout.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

export const SLIDE_W = 1280;
export const SLIDE_H = 720;
const GAP = 160;

export type LayoutKey = "blank" | "title" | "content" | "two" | "section" | "quote" | "media";

export const LAYOUTS: { key: LayoutKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "content", label: "Title and content" },
  { key: "two", label: "Two columns" },
  { key: "media", label: "Text and image" },
  { key: "section", label: "Section" },
  { key: "quote", label: "Quote" },
  { key: "blank", label: "Blank" },
];

const BODY = "•  First point\n•  Second point\n•  Third point";
const WHITE = "#ffffff";
const SECTION_FILL = "#0055cc";

/** The content a layout puts in a frame at (x, y). */
function layoutItems(key: LayoutKey, x: number, y: number): WbItem[] {
  const pad = 96;
  const w = SLIDE_W - pad * 2;
  switch (key) {
    case "title":
      return [
        makeTextBox(x + pad, y + 240, w, "Presentation title", 72, { bold: true, align: "center" }),
        makeTextBox(x + pad, y + 380, w, "Subtitle or presenter name", 30, { align: "center", color: "#8590a2" }),
      ];
    case "content":
      return [makeTextBox(x + pad, y + 80, w, "Slide title", 52, { bold: true }), makeTextBox(x + pad, y + 200, w, BODY, 30)];
    case "two": {
      const col = (w - 64) / 2;
      return [
        makeTextBox(x + pad, y + 80, w, "Slide title", 52, { bold: true }),
        makeTextBox(x + pad, y + 200, col, "Left heading", 32, { bold: true }),
        makeTextBox(x + pad, y + 260, col, BODY, 26),
        makeTextBox(x + pad + col + 64, y + 200, col, "Right heading", 32, { bold: true }),
        makeTextBox(x + pad + col + 64, y + 260, col, BODY, 26),
      ];
    }
    case "media": {
      const col = (w - 64) / 2;
      return [
        makeTextBox(x + pad, y + 120, col, "Slide title", 48, { bold: true }),
        makeTextBox(x + pad, y + 240, col, BODY, 26),
        makeShape("round", x + pad + col + 64, y + 100, col, SLIDE_H - 200, {
          fill: "#8590a2",
          opacity: 0.15,
          stroke: "#8590a2",
          strokeWidth: 2,
          dash: "dashed",
          text: "Drop an image here",
          color: "#8590a2",
          fontSize: 24,
        }),
      ];
    }
    case "section":
      return [
        makeTextBox(x + pad, y + 270, w, "Section title", 80, { bold: true, color: WHITE }),
        makeTextBox(x + pad, y + 400, w, "What this part is about", 30, { color: WHITE }),
      ];
    case "quote":
      return [
        makeTextBox(x + pad + 80, y + 200, w - 160, "“A short quote that sums it up.”", 56, { align: "center", italic: true }),
        makeTextBox(x + pad, y + 470, w, "Name, role", 28, { align: "center", color: "#8590a2" }),
      ];
    default:
      return [];
  }
}

/** Where the next slide goes: right of the given slide (or of the last one). */
function nextSpot(after: WbItem | null, frames: WbItem[]) {
  if (after) {
    // Skip right past anything already sitting in that row.
    let x = after.x + after.w + GAP;
    for (const f of frames) if (f.id !== after.id && Math.abs(f.y - after.y) < SLIDE_H && f.x + f.w > x - GAP && f.x < x + SLIDE_W + GAP) x = Math.max(x, f.x + f.w + GAP);
    return { x, y: after.y };
  }
  const c = viewCenter();
  return { x: c.x - SLIDE_W / 2, y: c.y - SLIDE_H / 2 };
}

/** Rewrite the slide order so `list` is it (only frames whose order changed). */
function orderChanges(list: WbItem[], extra: Record<string, WbItem> = {}): Record<string, WbItem> {
  const out: Record<string, WbItem> = { ...extra };
  list.forEach((f, i) => {
    const base = out[f.id] ?? f;
    if (base.data.order !== i) out[f.id] = mergeItem(base, { data: { order: i } });
  });
  return out;
}

/** New slide from a layout, after `afterId` (or at the end). Returns its id. */
export function addSlide(key: LayoutKey, afterId?: string | null): string | null {
  const s = S();
  if (!s.canEdit) return null;
  const frames = orderedFrames(s.items);
  const at = afterId ? frames.findIndex((f) => f.id === afterId) : frames.length - 1;
  const after = at >= 0 ? frames[at]! : null;
  const { x, y } = nextSpot(after, frames);
  const frame = makeFrame(x, y, SLIDE_W, SLIDE_H, `Slide ${frames.length + 1}`, key === "section" ? SECTION_FILL : "surface");
  let z = maxZ(s);
  const kids = layoutItems(key, x, y).map((it) => ({ ...it, frame_id: frame.id, z: ++z }));
  const list = [...frames];
  list.splice(at + 1, 0, frame);
  const changes = orderChanges(list, { [frame.id]: frame });
  for (const k of kids) changes[k.id] = k;
  commit(changes, { select: [] });
  set({ slideId: frame.id });
  return frame.id;
}

/** Copy a slide (and what's on it) right after itself. */
export function duplicateSlide(id: string): string | null {
  const s = S();
  const f = s.items[id];
  if (!f || f.type !== "frame" || !s.canEdit) return null;
  const kids = Object.values(s.items).filter((it) => it.frame_id === id);
  const frames = orderedFrames(s.items);
  const spot = nextSpot(f, frames);
  const ids = placeCopies([f, ...kids], { x: spot.x + f.w / 2, y: spot.y + f.h / 2 }, true);
  const st = S();
  const copy = ids.map((x) => st.items[x]).find((it) => it?.type === "frame");
  if (!copy) return null;
  const list = orderedFrames(st.items).filter((x) => x.id !== copy.id);
  list.splice(list.findIndex((x) => x.id === id) + 1, 0, copy);
  commit(orderChanges(list), { select: [], key: `dup-slide:${copy.id}` });
  set({ slideId: copy.id });
  return copy.id;
}

/** Move a slide from one place in the order to another. */
export function moveSlide(from: number, to: number) {
  const list = orderedFrames(S().items);
  if (to < 0 || to >= list.length || from === to) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved!);
  commit(orderChanges(list));
}

/** Viewport that fits a slide into the free part of the screen. */
export function slideViewport(f: WbItem, inset: { left: number; top: number; right: number; bottom: number }) {
  const { w, h } = S().screen;
  const b = geomBounds(f);
  const aw = Math.max(80, w - inset.left - inset.right);
  const ah = Math.max(60, h - inset.top - inset.bottom);
  const zoom = Math.min(aw / b.w, ah / b.h, 4);
  return {
    zoom,
    x: inset.left + aw / 2 - (b.x + b.w / 2) * zoom,
    y: inset.top + ah / 2 - (b.y + b.h / 2) * zoom,
  };
}

export const slideNotes = (f: WbItem | undefined) => (typeof f?.data.notes === "string" ? f.data.notes : "");
