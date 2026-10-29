import { beforeAll, describe, expect, it } from "vitest";
import { colorValues, colorWithAlpha, cssFor, cssText, parseColor, type CssRule } from "../css";
import { resolveNode, type RNode } from "../layout";
import { N, layout, makeDoc, solid, useFakeMeasure } from "./helpers";

beforeAll(useFakeMeasure);

const map = (rules: CssRule[]) => Object.fromEntries(rules.map((r) => [r.prop, r.value]));

function tree() {
  const doc = makeDoc([
    N("frame", "F", null, {
      x: 40,
      y: 50,
      w: 400,
      h: 200,
      clip: true,
      radius: [8, 8, 0, 0],
      layout: layout({ gap: 12, padding: { t: 16, r: 24, b: 16, l: 24 }, justify: "space-between", align: "center" }),
      fills: [solid("#FFFFFF")],
      effects: [{ type: "drop-shadow", x: 0, y: 4, blur: 12, spread: 0, color: "rgba(0, 0, 0, 0.25)" }],
    }),
    N("rect", "A", "F", { order: 1, w: 40, h: 40, sizing: { h: "fill", v: "fill" }, radius: 6, fills: [solid("#FF0000", { opacity: 0.5 })] }),
    N("frame", "H", "F", { order: 2, w: 10, h: 10, sizing: { h: "hug", v: "fixed" }, layout: layout({ mode: "vertical", wrap: false }), fills: [] }),
    N("rect", "X", "F", { order: 3, absolute: true, x: 5, y: 6, w: 10, h: 10, rotation: 45, opacity: 0.4 }),
  ]);
  const f = resolveNode(doc, "F")!;
  const k = Object.fromEntries(f.children.map((c) => [c.id, c])) as Record<string, RNode>;
  return { f, ...k } as { f: RNode } & Partial<Record<string, RNode>>;
}

describe("cssFor", () => {
  it("frames with auto layout: flex, gap, padding, alignment, clipping, corners, shadow", () => {
    const { f } = tree();
    const c = map(cssFor(f, null));
    expect(c).toMatchObject({
      width: "400px",
      height: "200px",
      display: "flex",
      "flex-direction": "row",
      "justify-content": "space-between",
      "align-items": "center",
      padding: "16px 24px",
      overflow: "hidden",
      background: "#FFFFFF",
      "border-radius": "8px 8px 0px 0px",
      "box-shadow": "0px 4px 12px 0px rgba(0, 0, 0, 0.25)",
    });
    // Top-level: no position; space-between: no gap.
    expect(c.position).toBeUndefined();
    expect(c.gap).toBeUndefined();
  });

  it("auto layout children: fill → flex / stretch, hug → fit-content, no position", () => {
    const { f, A, H } = tree();
    const a = map(cssFor(A!, f));
    expect(a).toMatchObject({ flex: "1 1 0", "align-self": "stretch", "border-radius": "6px", background: "rgba(255, 0, 0, 0.5)" });
    expect(a.width).toBeUndefined();
    expect(a.position).toBeUndefined();
    const h = map(cssFor(H!, f));
    expect(h).toMatchObject({ width: "fit-content", height: "10px", display: "flex", "flex-direction": "column" });
  });

  it("absolute children: position, rotation, opacity", () => {
    const { f, X } = tree();
    expect(map(cssFor(X!, f))).toMatchObject({ position: "absolute", left: "5px", top: "6px", transform: "rotate(45deg)", opacity: "0.4", width: "10px" });
  });

  it("children of a frame without auto layout are absolutely positioned", () => {
    const doc = makeDoc([N("frame", "F", null), N("ellipse", "E", "F", { x: 10, y: 20, w: 30, h: 30 })]);
    const f = resolveNode(doc, "F")!;
    expect(map(cssFor(f.children[0]!, f))).toMatchObject({ position: "absolute", left: "10px", top: "20px", "border-radius": "50%" });
  });

  it("gradients, layered fills (top first), strokes, inner shadow, blur", () => {
    const doc = makeDoc([
      N("rect", "R", null, {
        fills: [
          solid("#000000"),
          { type: "linear", angle: 0, stops: [{ pos: 0, color: "#FF0000" }, { pos: 1, color: "#0000FF" }] },
          { type: "radial", stops: [{ pos: 0, color: "#FFFFFF" }, { pos: 1, color: "#000000" }], opacity: 0.5 },
        ],
        strokes: [
          { color: "#111111", width: 2 },
          { color: "#222222", width: 3, align: "outside" },
        ],
        effects: [
          { type: "inner-shadow", x: 1, y: 2, blur: 3, color: "#000000" },
          { type: "layer-blur", blur: 8 },
        ],
      }),
    ]);
    const c = map(cssFor(resolveNode(doc, "R")!, null));
    expect(c.background).toBe(
      "radial-gradient(closest-side, rgba(255, 255, 255, 0.5) 0%, rgba(0, 0, 0, 0.5) 100%), linear-gradient(90deg, #FF0000 0%, #0000FF 100%), #000000",
    );
    expect(c["box-shadow"]).toBe("inset 0 0 0 2px #111111, 0 0 0 3px #222222, inset 1px 2px 3px 0px #000000");
    expect(c.filter).toBe("blur(4px)");
  });

  it("center or dashed strokes use border", () => {
    const doc = makeDoc([N("rect", "R", null, { strokes: [{ color: "#111111", width: 2, align: "center", dash: [4, 2] }] })]);
    expect(map(cssFor(resolveNode(doc, "R")!, null))).toMatchObject({ border: "2px dashed #111111", "box-sizing": "border-box" });
  });

  it("text: font, line height, spacing, alignment, colour, transform, decoration, style", () => {
    const doc = makeDoc([
      N("text", "T", null, {
        fills: [solid("#333333")],
        effects: [{ type: "drop-shadow", x: 0, y: 1, blur: 2, color: "#000000" }],
        text: {
          content: "Hi",
          fontFamily: "Open Sans",
          fontWeight: 600,
          fontSize: 18,
          lineHeight: 24,
          letterSpacing: 0.5,
          align: "center",
          italic: true,
          transform: "upper",
          decoration: "strike",
          resize: "auto-width",
        },
      }),
    ]);
    const c = map(cssFor(resolveNode(doc, "T")!, null));
    expect(c).toMatchObject({
      "font-family": '"Open Sans", sans-serif',
      "font-size": "18px",
      "font-weight": "600",
      "font-style": "italic",
      "line-height": "24px",
      "letter-spacing": "0.5px",
      "text-align": "center",
      color: "#333333",
      "text-transform": "uppercase",
      "text-decoration": "line-through",
      "text-shadow": "0px 1px 2px #000000",
    });
    expect(c.background).toBeUndefined();
  });

  it("wrap layouts get flex-wrap and row-gap", () => {
    const doc = makeDoc([N("frame", "F", null, { layout: layout({ gap: 8, rowGap: 16, wrap: true }) })]);
    expect(map(cssFor(resolveNode(doc, "F")!, null))).toMatchObject({ "flex-wrap": "wrap", gap: "8px", "row-gap": "16px" });
  });

  it("cssText joins rules", () => {
    expect(
      cssText([
        { prop: "width", value: "10px" },
        { prop: "height", value: "20px" },
      ]),
    ).toBe("width: 10px;\nheight: 20px;");
  });
});

describe("colours", () => {
  it("parses hex, short hex, rgba and names", () => {
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#FF000080")).toEqual({ r: 255, g: 0, b: 0, a: 0.502 });
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(100% 0% 0%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("nope")).toBeNull();
    expect(colorWithAlpha("#FF0000", 0.25)).toBe("rgba(255, 0, 0, 0.25)");
  });

  it("colorValues lists every colour once, with hex and rgba", () => {
    const { f } = tree();
    expect(colorValues(f)).toEqual([
      { hex: "#FFFFFF", rgba: "rgba(255, 255, 255, 1)", alpha: 1, use: "fill" },
      { hex: "#000000", rgba: "rgba(0, 0, 0, 0.25)", alpha: 0.25, use: "shadow" },
    ]);
    const deep = colorValues(f, true);
    expect(deep.map((c) => c.rgba)).toContain("rgba(255, 0, 0, 0.5)");
    expect(deep.filter((c) => c.hex === "#D9D9D9")).toHaveLength(1);
  });
});
