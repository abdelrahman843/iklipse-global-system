import { str, type WbItem } from "./types";
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

export type SlideDir = "row" | "column";

/**
 * Which way the slides run around `f`: a column when its neighbour in the
 * order sits above or below it (Miro boards often stack frames), else a row.
 */
export function slideDir(f: WbItem, frames: WbItem[]): SlideDir {
  const i = frames.findIndex((x) => x.id === f.id);
  const nb = frames[i - 1] ?? frames[i + 1];
  if (!nb) return "row";
  const dx = Math.abs(nb.x + nb.w / 2 - (f.x + f.w / 2));
  const dy = Math.abs(nb.y + nb.h / 2 - (f.y + f.h / 2));
  return dy > dx ? "column" : "row";
}

/**
 * Room for a new w x h frame right before / after `at`, in the way the slides
 * run: the frames further along that line (and what's on them) move over.
 * Returns the new frame's top-left and the moves.
 */
function makeRoom(at: WbItem, where: "before" | "after", w: number, h: number, frames: WbItem[]) {
  const s = S();
  const col = slideDir(at, frames) === "column";
  const start = (f: WbItem) => (col ? f.y : f.x);
  const end = (f: WbItem) => (col ? f.y + f.h : f.x + f.w);
  // Frames on the same line (overlapping across it).
  const line = frames.filter((f) => (col ? f.x < at.x + at.w && f.x + f.w > at.x : f.y < at.y + at.h && f.y + f.h > at.y));
  // Keep the spacing the line already has.
  const next = line.filter((f) => f.id !== at.id && start(f) >= end(at) - 1).sort((a, b) => start(a) - start(b))[0];
  const gap = next ? Math.min(400, Math.max(40, start(next) - end(at))) : GAP;
  const pos = where === "after" ? end(at) + gap : start(at);
  const spot = col ? { x: at.x, y: pos } : { x: pos, y: at.y };
  const shift = (col ? h : w) + gap;
  const moves: Record<string, WbItem> = {};
  for (const f of line) {
    // Everything from the gap on moves along (for "before", `at` itself too).
    if (where === "after" ? f.id === at.id || start(f) < start(at) : start(f) < start(at)) continue;
    for (const it of [f, ...Object.values(s.items).filter((k) => k.frame_id === f.id)]) {
      moves[it.id] = col ? { ...it, y: it.y + shift } : { ...it, x: it.x + shift };
    }
  }
  return { spot, moves };
}

/** "Reel - 01", "Reel - 02"... : frames named <text><number> along a line get renumbered in order. */
function renumber(list: WbItem[], changes: Record<string, WbItem>) {
  const cur = (f: WbItem) => changes[f.id] ?? S().items[f.id] ?? f;
  const parsed = list.map((f) => /^(.*?)(\d+)\s*$/.exec(str(cur(f).data.title)));
  if (parsed.length < 2 || parsed.some((m) => !m) || new Set(parsed.map((m) => m![1])).size !== 1) return;
  const first = parseInt(parsed[0]![2]!, 10);
  const pad = parsed[0]![2]!.length;
  list.forEach((f, i) => {
    const title = parsed[0]![1] + String(first + i).padStart(pad, "0");
    const it = cur(f);
    if (str(it.data.title) !== title) changes[f.id] = mergeItem(it, { data: { title } });
  });
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
  const c = viewCenter();
  const room = after ? makeRoom(after, "after", SLIDE_W, SLIDE_H, frames) : { spot: { x: c.x - SLIDE_W / 2, y: c.y - SLIDE_H / 2 }, moves: {} };
  const { x, y } = room.spot;
  const frame = makeFrame(x, y, SLIDE_W, SLIDE_H, `Slide ${frames.length + 1}`, key === "section" ? SECTION_FILL : "surface");
  let z = maxZ(s);
  const kids = layoutItems(key, x, y).map((it) => ({ ...it, frame_id: frame.id, z: ++z }));
  const list = [...frames];
  list.splice(at + 1, 0, frame);
  const changes = orderChanges(list, { ...room.moves, [frame.id]: frame });
  for (const k of kids) changes[k.id] = k;
  commit(changes, { select: [] });
  set({ slideId: frame.id });
  return frame.id;
}

/** Copy a slide (and what's on it) right after itself. */
export function duplicateSlide(id: string): string | null {
  return insertFrameCopy(id, "after", false);
}

/**
 * A copy of a frame and what's on it, right before / after it (Miro's "add
 * next card"): later frames along the line move over, numbered titles follow
 * on, and with `fresh` the copy's video links are emptied for new ones.
 */
export function insertFrameCopy(id: string, where: "before" | "after", fresh = true): string | null {
  const s = S();
  const f = s.items[id];
  if (!f || f.type !== "frame" || !s.canEdit) return null;
  const frames = orderedFrames(s.items);
  const kids = Object.values(s.items).filter((it) => it.frame_id === id);
  const { spot, moves } = makeRoom(f, where, f.w, f.h, frames);
  // Make room first, then drop the copy in the gap (all one undo step).
  const key = `insert-frame:${id}:${Date.now()}`;
  if (Object.keys(moves).length) commit(moves, { key });
  const ids = placeCopies([f, ...kids], { x: spot.x + f.w / 2, y: spot.y + f.h / 2 }, true, key);
  const st = S();
  const copy = ids.map((x) => st.items[x]).find((it) => it?.type === "frame");
  if (!copy) return null;
  const changes: Record<string, WbItem> = {};
  if (fresh) {
    for (const x of ids) {
      const it = st.items[x];
      if (it?.type === "embed" && str(it.data.url)) changes[x] = mergeItem(it, { data: { url: "" } });
    }
  }
  const list = orderedFrames(st.items).filter((x) => x.id !== copy.id);
  const i = list.findIndex((x) => x.id === id);
  list.splice(where === "after" ? i + 1 : i, 0, copy);
  Object.assign(changes, orderChanges(list));
  // Renumber the frames on this line ("Reel - 03" after "Reel - 02").
  const dir = slideDir(copy, list);
  const line = list.filter((x) => {
    const g = changes[x.id] ?? x;
    return dir === "column" ? g.x < copy.x + copy.w && g.x + g.w > copy.x : g.y < copy.y + copy.h && g.y + g.h > copy.y;
  });
  renumber(line, changes);
  commit(changes, { select: [copy.id], key });
  set({ slideId: copy.id });
  return copy.id;
}

/** Lay every slide out in order, side by side or stacked, from where the first one is. */
export function arrangeSlides(dir: SlideDir) {
  const s = S();
  const frames = orderedFrames(s.items);
  if (frames.length < 2 || !s.canEdit) return;
  const changes: Record<string, WbItem> = {};
  let x = frames[0]!.x;
  let y = frames[0]!.y;
  for (const f of frames) {
    const dx = x - f.x;
    const dy = y - f.y;
    if (dx || dy) {
      for (const it of [f, ...Object.values(s.items).filter((k) => k.frame_id === f.id)]) changes[it.id] = { ...it, x: it.x + dx, y: it.y + dy };
    }
    if (dir === "row") x += f.w + GAP;
    else y += f.h + GAP;
  }
  // The slides view follows its slide wherever it went.
  commit(changes);
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
