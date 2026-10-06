// -----------------------------------------------------------------------------
// Whiteboard (Miro-style canvas) model. One row of public.wb_item per thing on
// the canvas; type-specific settings live in `data` (see migration 0038).
// World coordinates are canvas pixels at 100% zoom; (x, y) is the top-left of
// the unrotated box and `rotation` (degrees) turns it around its centre.
// -----------------------------------------------------------------------------

export type ItemType = "sticky" | "shape" | "text" | "frame" | "image" | "connector" | "pen" | "card" | "emoji";

export interface WbItem {
  id: string;
  board_id: string;
  type: ItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  frame_id: string | null;
  group_id: string | null;
  locked: boolean;
  data: Record<string, unknown>;
  sid?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type Geom = Pick<WbItem, "x" | "y" | "w" | "h" | "rotation">;

/** Columns a client may change (the rest are server-stamped). */
export const ITEM_COLS = ["type", "x", "y", "w", "h", "rotation", "z", "frame_id", "group_id", "locked"] as const;
export type ItemCol = (typeof ITEM_COLS)[number];

export type Align = "left" | "center" | "right";
export type VAlign = "top" | "middle" | "bottom";
export type Dash = "solid" | "dashed" | "dotted";
export type FontFamily = "sans" | "serif" | "mono";

/** Shared text styling on stickies, shapes, text and cards. */
export interface TextStyle {
  text?: string;
  /** Pixels at 100% zoom; "auto" shrinks to fit the box (stickies, shapes). */
  fontSize?: number | "auto";
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: Align;
  valign?: VAlign;
  font?: FontFamily;
}

export interface StickyData extends TextStyle {
  color?: string; // text colour (auto when unset)
  fill?: string;
  showAuthor?: boolean;
}

export type ShapeKind =
  | "rect"
  | "round"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "pentagon"
  | "hexagon"
  | "octagon"
  | "star"
  | "parallelogram"
  | "trapezoid"
  | "arrow_right"
  | "arrow_left"
  | "chevron"
  | "cross"
  | "callout"
  | "cylinder"
  | "cloud"
  | "heart"
  | "document";

export interface ShapeData extends TextStyle {
  shape?: ShapeKind;
  fill?: string; // colour token, "none" = transparent
  stroke?: string;
  strokeWidth?: number;
  dash?: Dash;
  opacity?: number; // fill opacity 0..1
}

export interface TextData extends TextStyle {
  fill?: string; // highlight behind the text, "none" by default
  /** Width follows the text until someone resizes it. */
  autoWidth?: boolean;
}

export interface FrameData {
  title?: string;
  fill?: string;
  /** Slide order for presenting; frames without one sort by position. */
  order?: number;
}

export interface ImageData {
  path?: string; // storage object in the "whiteboard" bucket
  nw?: number;
  nh?: number;
  name?: string;
}

export type Side = "top" | "right" | "bottom" | "left";
export type Cap = "none" | "arrow" | "triangle" | "circle" | "diamond" | "bar";
export type ConnectorKind = "straight" | "elbow" | "curved";

/** One end of a connector: stuck to an item (side or relative point) or free. */
export interface ConnectorEnd {
  id?: string | null;
  side?: Side | "auto" | null;
  /** Relative point on the item box (0..1), used when side is unset. */
  fx?: number;
  fy?: number;
  /** World point for a free end. */
  x?: number;
  y?: number;
}

export interface ConnectorData {
  start?: ConnectorEnd;
  end?: ConnectorEnd;
  kind?: ConnectorKind;
  color?: string;
  width?: number;
  dash?: Dash;
  startCap?: Cap;
  endCap?: Cap;
  label?: string;
}

export interface PenData {
  /** Flattened [x0, y0, x1, y1, ...] relative to the item's top-left. */
  points?: number[];
  color?: string;
  width?: number;
  highlighter?: boolean;
  /** Box size the points were drawn in (resizing scales them). */
  bw?: number;
  bh?: number;
}

export interface CardData {
  title?: string;
  description?: string;
  fill?: string; // colour strip
  assignee?: string | null;
  due?: string | null; // yyyy-mm-dd
  done?: boolean;
}

export interface EmojiData {
  emoji?: string;
}

// ------------------------------------------------------------------ colours --
// Content colours come from the system palette: the label colours (light,
// sticky-note friendly) and the board colours (deep). "ink" / "surface" follow
// the theme, so default text and shapes stay readable in dark and light mode.
export const LIGHT_COLORS = ["#f5cd47", "#fea362", "#f87168", "#e774bb", "#9f8fef", "#579dff", "#6cc3e0", "#4bce97", "#94c748", "#8590a2"];
export const DEEP_COLORS = ["#946f00", "#a54800", "#ae2e24", "#943d73", "#5e4db2", "#0055cc", "#206a83", "#1f845a", "#4c6b1f", "#44546f"];
export const THEME_COLORS = ["ink", "surface"] as const;
export const ALL_COLORS = [...THEME_COLORS, ...LIGHT_COLORS, ...DEEP_COLORS];

export const COLOR_NAMES: Record<string, string> = {
  ink: "Text",
  surface: "Paper",
  none: "Transparent",
  "#f5cd47": "Yellow",
  "#fea362": "Orange",
  "#f87168": "Red",
  "#e774bb": "Pink",
  "#9f8fef": "Purple",
  "#579dff": "Blue",
  "#6cc3e0": "Sky",
  "#4bce97": "Green",
  "#94c748": "Lime",
  "#8590a2": "Grey",
  "#946f00": "Dark yellow",
  "#a54800": "Dark orange",
  "#ae2e24": "Dark red",
  "#943d73": "Dark pink",
  "#5e4db2": "Dark purple",
  "#0055cc": "Dark blue",
  "#206a83": "Dark sky",
  "#1f845a": "Dark green",
  "#4c6b1f": "Dark lime",
  "#44546f": "Slate",
};

export const DEFAULT_STICKY = "#f5cd47";

/** CSS colour for a stored colour token. */
export function cssColor(c: string | null | undefined, fallback = "transparent"): string {
  if (!c) return fallback;
  if (c === "none") return "transparent";
  if (c === "ink") return "rgb(var(--c-ink))";
  if (c === "surface") return "rgb(var(--c-surface))";
  return c;
}

/** Readable text colour on a stored fill token. */
export function textOn(fill: string | null | undefined): string {
  if (!fill || fill === "none") return "rgb(var(--c-ink))";
  if (fill === "surface") return "rgb(var(--c-ink))";
  if (fill === "ink") return "rgb(var(--c-surface))";
  const h = fill.replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return "rgb(var(--c-ink))";
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#172b4d" : "#ffffff";
}

export const FONT_STACK: Record<FontFamily, string> = {
  sans: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

// ------------------------------------------------------------------- tools --
export type Tool =
  | "select"
  | "hand"
  | "sticky"
  | "text"
  | "shape"
  | "connector"
  | "pen"
  | "highlighter"
  | "eraser"
  | "frame"
  | "comment"
  | "emoji"
  | "card";

export interface Viewport {
  x: number; // screen offset of world origin
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

/** Items whose text is edited in place. */
export const TEXT_TYPES: ItemType[] = ["sticky", "shape", "text", "card"];
/** Items connectors can stick to. */
export const CONNECTABLE: ItemType[] = ["sticky", "shape", "text", "image", "card", "frame", "emoji"];
/** Items that may turn. */
export const ROTATABLE: ItemType[] = ["shape", "text", "image", "emoji"];

export function str(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
export function num(v: unknown, d = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
export function bool(v: unknown): boolean {
  return v === true;
}
