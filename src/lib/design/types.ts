// -----------------------------------------------------------------------------
// Design mode (Figma-style UI/UX editor) document model.
//
// A design document belongs to a whiteboard board (one per board), so board
// members, roles and sharing apply unchanged. It lives in its own tables
// (migration 0133): design_doc holds the document-wide parts (pages, styles,
// tokens, component properties), design_node one row per layer.
//
// Geometry: x / y are relative to the parent's top-left (the page origin for
// top-level layers), w / h the box, rotation in degrees around the centre.
// Children of an auto layout frame get their x / y (and fill / hug sizes)
// from the layout engine (layout.ts); what's stored for them is ignored.
// -----------------------------------------------------------------------------

export const DESIGN_FORMAT = "iklipse-design";
export const DESIGN_FORMAT_VERSION = 1;

export type NodeType =
  | "frame"
  | "group"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "path"
  | "text"
  | "image"
  | "component"
  | "instance";

/** Types whose children are laid out inside them (and can clip them). */
export const CONTAINER_TYPES: NodeType[] = ["frame", "group", "component", "instance"];

export interface ColorStop {
  /** 0..1 along the gradient */
  pos: number;
  color: string;
}

export type Paint =
  | { type: "solid"; color: string; opacity?: number; styleId?: string; visible?: boolean }
  | { type: "linear"; angle: number; stops: ColorStop[]; opacity?: number; visible?: boolean }
  | { type: "radial"; stops: ColorStop[]; opacity?: number; visible?: boolean };

export interface Stroke {
  color: string;
  width: number;
  align?: "inside" | "center" | "outside";
  dash?: number[];
  styleId?: string;
  visible?: boolean;
}

export type Effect =
  | { type: "drop-shadow"; x: number; y: number; blur: number; spread?: number; color: string; visible?: boolean }
  | { type: "inner-shadow"; x: number; y: number; blur: number; spread?: number; color: string; visible?: boolean }
  | { type: "layer-blur"; blur: number; visible?: boolean };

export type HSizing = "fixed" | "hug" | "fill";

/** Auto layout on a frame / component (Figma's "auto layout"). */
export interface AutoLayout {
  mode: "horizontal" | "vertical";
  gap: number;
  /** Space between wrapped rows (horizontal + wrap only). */
  rowGap?: number;
  padding: { t: number; r: number; b: number; l: number };
  /** Main axis distribution. */
  justify: "start" | "center" | "end" | "space-between";
  /** Cross axis. */
  align: "start" | "center" | "end" | "stretch" | "baseline";
  wrap?: boolean;
  /** Token bindings: values come from doc tokens when set. */
  gapToken?: string;
  paddingToken?: string;
}

export interface Constraints {
  h: "left" | "right" | "left-right" | "center" | "scale";
  v: "top" | "bottom" | "top-bottom" | "center" | "scale";
}

export interface TextProps {
  content: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  /** px; null = auto (1.2 × size) */
  lineHeight?: number | null;
  letterSpacing?: number;
  align: "left" | "center" | "right" | "justify";
  valign?: "top" | "middle" | "bottom";
  italic?: boolean;
  decoration?: "none" | "underline" | "strike";
  transform?: "none" | "upper" | "lower" | "title";
  /** auto-width grows sideways, auto-height wraps at w, fixed clips nothing but keeps w / h */
  resize: "auto-width" | "auto-height" | "fixed";
  styleId?: string;
}

export interface PathPoint {
  x: number;
  y: number;
  /** Bezier handles, relative to the point. */
  in?: { x: number; y: number };
  out?: { x: number; y: number };
}

export interface ImageProps {
  /** Storage object in the private "whiteboard" bucket, or a data: URL (imports). */
  src: string;
  nw: number;
  nh: number;
  fit: "fill" | "fit" | "crop" | "tile";
  /** crop: the image is scaled by `scale` and offset by (x, y) inside the box (px). */
  crop?: { x: number; y: number; scale: number };
  name?: string;
}

export type Trigger = "click" | "hover" | "press" | "delay";
export type TransitionType = "instant" | "dissolve" | "slide-left" | "slide-right" | "slide-up" | "slide-down" | "push-left" | "push-right" | "smart";
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "spring";

export interface Interaction {
  id: string;
  trigger: Trigger;
  /** ms, for "delay" */
  delay?: number;
  action:
    | { type: "navigate"; target: string }
    | { type: "overlay"; target: string; position?: "center" | "top" | "bottom"; closeOnOutside?: boolean }
    | { type: "back" }
    | { type: "close-overlay" }
    | { type: "url"; url: string };
  transition: { type: TransitionType; duration: number; easing: Easing };
}

/** One editable property of a component, mapped onto a layer inside it. */
export interface ComponentProp {
  id: string;
  name: string;
  kind: "text" | "boolean";
  /** The layer inside the component this property drives. */
  target: string;
  default: string | boolean;
}

/** What an instance may change on a layer of its component. */
export const OVERRIDABLE = ["content", "fills", "strokes", "visible", "opacity", "image"] as const;
export type OverrideKey = (typeof OVERRIDABLE)[number];
export interface Override {
  content?: string;
  fills?: Paint[];
  strokes?: Stroke[];
  visible?: boolean;
  opacity?: number;
  image?: ImageProps;
}

export interface DNode {
  id: string;
  type: NodeType;
  name: string;
  /** Page this layer is on. */
  page: string;
  /** Parent layer, null at the top of the page. */
  parent: string | null;
  /** Order among siblings (fractional, lower = further back). */
  order: number;

  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;

  visible: boolean;
  locked: boolean;
  opacity: number;
  blend?: string;

  fills: Paint[];
  strokes: Stroke[];
  /** Corner radius; a 4-tuple sets each corner (tl, tr, br, bl). */
  radius?: number | [number, number, number, number];
  radiusToken?: string;
  effects?: Effect[];

  /** Frames, components: hide what overflows. */
  clip?: boolean;
  layout?: AutoLayout | null;
  /** How this layer sizes inside an auto layout parent (and for hug on its own content). */
  sizing?: { h: HSizing; v: HSizing };
  /** Inside an auto layout parent: skip the layout and keep x / y. */
  absolute?: boolean;
  constraints?: Constraints;
  /** Layout grid shown on frames (columns). */
  grid?: { columns: number; gutter: number; margin: number; color?: string; visible?: boolean } | null;

  text?: TextProps;
  image?: ImageProps;
  /** path, polygon, star: points in the node's own box (0..w, 0..h). */
  points?: PathPoint[];
  closed?: boolean;
  /** polygon / star */
  sides?: number;
  innerRatio?: number;
  /** line / arrow ends */
  caps?: { start: "none" | "arrow" | "circle"; end: "none" | "arrow" | "circle" };

  /** instance */
  componentId?: string;
  /** instance: per layer of the component (by its id), what differs. */
  overrides?: Record<string, Override>;
  /** instance: values of the component's properties */
  propValues?: Record<string, string | boolean>;
  /** component: its editable properties */
  props?: ComponentProp[];
  description?: string;

  /** Prototype interactions on this layer. */
  interactions?: Interaction[];
  /** frames: scroll behaviour in the prototype */
  overflow?: "none" | "vertical" | "horizontal" | "both";
  /** Export presets */
  exports?: { format: "png" | "jpg" | "svg" | "pdf"; scale: number }[];
}

export interface ColorStyle {
  id: string;
  name: string;
  color: string;
}

export interface TextStyleDef {
  id: string;
  name: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight?: number | null;
  letterSpacing?: number;
}

export interface Token {
  id: string;
  name: string;
  kind: "spacing" | "radius" | "color" | "font-size";
  value: number | string;
}

export interface Page {
  id: string;
  name: string;
  /** Canvas background */
  bg?: string;
  /** Prototype: the frame playback starts on. */
  start?: string | null;
}

export interface DocData {
  pages: Page[];
  colors: ColorStyle[];
  textStyles: TextStyleDef[];
  tokens: Token[];
  /** Component layer ids published to the team library (shown in Assets). */
  library?: string[];
}

export interface DesignDoc {
  data: DocData;
  nodes: Record<string, DNode>;
}

/** The versioned native file format (JSON import / export). */
export interface DesignFile {
  format: typeof DESIGN_FORMAT;
  version: number;
  exportedAt: string;
  name: string;
  data: DocData;
  nodes: DNode[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A frame preset (desktop / tablet / phone). */
export const FRAME_PRESETS: { group: string; name: string; w: number; h: number }[] = [
  { group: "Phone", name: "iPhone 15", w: 393, h: 852 },
  { group: "Phone", name: "iPhone SE", w: 375, h: 667 },
  { group: "Phone", name: "Android", w: 412, h: 915 },
  { group: "Tablet", name: "iPad mini", w: 744, h: 1133 },
  { group: "Tablet", name: "iPad Pro 11", w: 834, h: 1194 },
  { group: "Desktop", name: "Desktop", w: 1440, h: 1024 },
  { group: "Desktop", name: "MacBook Air", w: 1280, h: 832 },
  { group: "Desktop", name: "Wide", w: 1920, h: 1080 },
];

export const FONT_FAMILIES = ["Inter", "Roboto", "Open Sans", "Montserrat", "Poppins", "Lato", "Cairo", "Georgia", "Times New Roman", "Courier New", "system-ui"];
