import { makeNode } from "../doc";
import { setMeasure } from "../text";
import type { AutoLayout, DesignDoc, DNode, DocData, NodeType, Paint } from "../types";

// Shared fixtures for the design mode tests.

export const PAGE = "p1";

/** Deterministic text measuring: every glyph is half the font size wide. */
export function useFakeMeasure() {
  setMeasure((text, font, letterSpacing) => {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
    return text.length * size * 0.5 + letterSpacing * text.length;
  });
}

export function data(p: Partial<DocData> = {}): DocData {
  return { pages: [{ id: PAGE, name: "Page 1", start: null }], colors: [], textStyles: [], tokens: [], library: [], ...p };
}

export function makeDoc(nodes: DNode[], d: Partial<DocData> = {}): DesignDoc {
  return { data: data(d), nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) };
}

/** A layer with a fixed id. */
export function N(type: NodeType, id: string, parent: string | null, p: Partial<DNode> = {}): DNode {
  return makeNode(type, PAGE, parent, { id, ...p });
}

export function layout(p: Partial<AutoLayout> = {}): AutoLayout {
  return { mode: "horizontal", gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, justify: "start", align: "start", ...p };
}

export const solid = (color: string, extra: Partial<Extract<Paint, { type: "solid" }>> = {}): Paint => ({ type: "solid", color, ...extra });
