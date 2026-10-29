import { beforeAll, describe, expect, it } from "vitest";
import { applyConstraints, indexResolved, resolveNode, resolvePage, type RNode } from "../layout";
import type { DNode } from "../types";
import { N, PAGE, layout, makeDoc, solid, useFakeMeasure } from "./helpers";

beforeAll(useFakeMeasure);

const kids = (r: RNode | null) => Object.fromEntries((r?.children ?? []).map((c) => [c.id, c]));

/** A 300 x 100 frame with two children (50 x 20, 30 x 40) in an auto layout. */
function row(l: Parameters<typeof layout>[0], frame: Partial<DNode> = {}) {
  const doc = makeDoc([
    N("frame", "F", null, { w: 300, h: 100, layout: layout(l), ...frame }),
    N("rect", "A", "F", { w: 50, h: 20, order: 1 }),
    N("rect", "B", "F", { w: 30, h: 40, order: 2 }),
  ]);
  return kids(resolveNode(doc, "F"));
}

describe("horizontal auto layout", () => {
  const pad = { t: 5, r: 5, b: 5, l: 20 };
  it("places children with gap and padding (justify start)", () => {
    const { A, B } = row({ gap: 10, padding: pad });
    expect([A!.x, A!.y, B!.x, B!.y]).toEqual([20, 5, 80, 5]);
  });
  it("justify center / end / space-between", () => {
    // inner main = 300 - 25 = 275, used = 50 + 30 + 10 = 90, free = 185
    let k = row({ gap: 10, padding: pad, justify: "center" });
    expect(k.A!.x).toBeCloseTo(20 + 92.5);
    expect(k.B!.x).toBeCloseTo(20 + 92.5 + 60);
    k = row({ gap: 10, padding: pad, justify: "end" });
    expect(k.A!.x).toBe(205);
    expect(k.B!.x + k.B!.w).toBe(295);
    k = row({ gap: 10, padding: pad, justify: "space-between" });
    expect(k.A!.x).toBe(20);
    expect(k.B!.x).toBe(265);
  });
  it("align start / center / end / stretch", () => {
    // inner cross = 100 - 10 = 90
    let k = row({ padding: pad, align: "center" });
    expect([k.A!.y, k.B!.y]).toEqual([40, 30]);
    k = row({ padding: pad, align: "end" });
    expect([k.A!.y, k.B!.y]).toEqual([75, 55]);
    k = row({ padding: pad, align: "stretch" });
    expect([k.A!.y, k.A!.h, k.B!.h]).toEqual([5, 90, 90]);
  });
});

describe("vertical auto layout", () => {
  it("stacks with gap / padding and aligns across", () => {
    const doc = makeDoc([
      N("frame", "F", null, { w: 200, h: 300, layout: layout({ mode: "vertical", gap: 8, padding: { t: 10, r: 10, b: 10, l: 10 }, align: "center" }) }),
      N("rect", "A", "F", { w: 50, h: 20, order: 1 }),
      N("rect", "B", "F", { w: 100, h: 40, order: 2 }),
    ]);
    const { A, B } = kids(resolveNode(doc, "F"));
    expect([A!.x, A!.y]).toEqual([10 + (180 - 50) / 2, 10]);
    expect([B!.x, B!.y]).toEqual([10 + (180 - 100) / 2, 38]);
  });
  it("justify end and space-between on the vertical axis", () => {
    const mk = (justify: "end" | "space-between") =>
      kids(
        resolveNode(
          makeDoc([
            N("frame", "F", null, { w: 100, h: 200, layout: layout({ mode: "vertical", gap: 10, justify }) }),
            N("rect", "A", "F", { w: 10, h: 20, order: 1 }),
            N("rect", "B", "F", { w: 10, h: 30, order: 2 }),
          ]),
          "F",
        ),
      );
    let k = mk("end");
    expect([k.A!.y, k.B!.y]).toEqual([140, 170]);
    k = mk("space-between");
    expect([k.A!.y, k.B!.y]).toEqual([0, 170]);
  });
});

describe("sizing", () => {
  it("hug parent wraps its content plus padding", () => {
    const doc = makeDoc([
      N("frame", "F", null, { w: 999, h: 999, sizing: { h: "hug", v: "hug" }, layout: layout({ gap: 5, padding: { t: 10, r: 10, b: 10, l: 10 } }) }),
      N("rect", "A", "F", { w: 50, h: 20, order: 1 }),
      N("rect", "B", "F", { w: 30, h: 40, order: 2 }),
    ]);
    const f = resolveNode(doc, "F")!;
    expect([f.w, f.h]).toEqual([105, 60]);
  });
  it("fill children share what's left on the main axis", () => {
    const doc = makeDoc([
      N("frame", "F", null, { w: 300, h: 50, layout: layout({ gap: 10 }) }),
      N("rect", "A", "F", { w: 50, h: 20, order: 1 }),
      N("rect", "B", "F", { w: 10, h: 20, order: 2, sizing: { h: "fill", v: "fixed" } }),
      N("rect", "C", "F", { w: 10, h: 20, order: 3, sizing: { h: "fill", v: "fill" } }),
    ]);
    const { A, B, C } = kids(resolveNode(doc, "F"));
    expect([B!.w, C!.w]).toEqual([115, 115]);
    expect([A!.x, B!.x, C!.x]).toEqual([0, 60, 185]);
    // Cross-axis fill takes the inner height.
    expect([B!.h, C!.h]).toEqual([20, 50]);
  });
  it("wraps rows (horizontal + wrap) with rowGap, and hugs their height", () => {
    const doc = makeDoc([
      N("frame", "F", null, { w: 100, h: 10, sizing: { h: "fixed", v: "hug" }, layout: layout({ gap: 10, rowGap: 5, wrap: true }) }),
      N("rect", "A", "F", { w: 40, h: 20, order: 1 }),
      N("rect", "B", "F", { w: 40, h: 20, order: 2 }),
      N("rect", "C", "F", { w: 40, h: 20, order: 3 }),
    ]);
    const f = resolveNode(doc, "F")!;
    const { A, B, C } = kids(f);
    expect([A!.x, A!.y, B!.x, B!.y]).toEqual([0, 0, 50, 0]);
    expect([C!.x, C!.y]).toEqual([0, 25]);
    expect(f.h).toBe(45);
  });
  it("ignores absolute and hidden children in the flow", () => {
    const doc = makeDoc([
      N("frame", "F", null, { w: 300, h: 100, layout: layout({ gap: 10 }) }),
      N("rect", "A", "F", { w: 50, h: 20, order: 1 }),
      N("rect", "X", "F", { w: 70, h: 70, order: 2, absolute: true, x: 7, y: 9 }),
      N("rect", "H", "F", { w: 70, h: 70, order: 3, visible: false }),
      N("rect", "B", "F", { w: 30, h: 40, order: 4 }),
    ]);
    const { B, X } = kids(resolveNode(doc, "F"));
    expect(B!.x).toBe(60);
    expect([X!.x, X!.y]).toEqual([7, 9]);
  });
  it("nested auto layout: inner hug row inside an outer hug column", () => {
    const doc = makeDoc([
      N("frame", "O", null, { x: 100, y: 50, sizing: { h: "hug", v: "hug" }, layout: layout({ mode: "vertical", gap: 4, padding: { t: 8, r: 8, b: 8, l: 8 } }) }),
      N("frame", "I", "O", { order: 1, sizing: { h: "hug", v: "hug" }, layout: layout({ gap: 6 }) }),
      N("rect", "a", "I", { w: 20, h: 10, order: 1 }),
      N("rect", "b", "I", { w: 30, h: 15, order: 2 }),
      N("rect", "T", "O", { w: 10, h: 10, order: 2 }),
    ]);
    const o = resolveNode(doc, "O")!;
    const inner = o.children[0]!;
    expect([inner.w, inner.h]).toEqual([56, 15]);
    expect([o.w, o.h]).toEqual([72, 8 + 15 + 4 + 10 + 8]);
    expect([inner.x, inner.y]).toEqual([8, 8]);
    expect(o.children[1]!.y).toBe(27);
    // Absolute positions add up through the tree.
    const b = inner.children[1]!;
    expect([b.ax, b.ay]).toEqual([100 + 8 + 26, 50 + 8]);
  });
  it("hug text: auto-width text sizes the frame", () => {
    const doc = makeDoc([
      N("frame", "F", null, { sizing: { h: "hug", v: "hug" }, layout: layout({ padding: { t: 4, r: 4, b: 4, l: 4 } }) }),
      N("text", "T", "F", { order: 1, text: { content: "Hello", fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left", resize: "auto-width" } }),
    ]);
    const f = resolveNode(doc, "F")!;
    // "Hello" = 5 chars x 5 px; line height 12
    expect([f.w, f.h]).toEqual([33, 20]);
    expect(f.children[0]!.tl!.lines.map((l) => l.text)).toEqual(["Hello"]);
  });
  it("fill-width text re-wraps at the width it gets", () => {
    const doc = makeDoc([
      N("frame", "F", null, { w: 60, h: 10, sizing: { h: "fixed", v: "hug" }, layout: layout({ mode: "vertical" }) }),
      N("text", "T", "F", {
        order: 1,
        w: 500,
        sizing: { h: "fill", v: "hug" },
        text: { content: "aaaa bbbb cccc", fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left", resize: "auto-height" },
      }),
    ]);
    const f = resolveNode(doc, "F")!;
    const t = f.children[0]!;
    expect(t.w).toBe(60);
    expect(t.tl!.lines.map((l) => l.text)).toEqual(["aaaa bbbb", "cccc"]);
    expect(t.h).toBe(24);
    expect(f.h).toBe(24);
  });
});

describe("instances", () => {
  const textProps = { fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left" as const, resize: "auto-width" as const };
  function lib(extra: DNode[] = []) {
    return makeDoc([
      N("component", "C", null, {
        w: 100,
        h: 40,
        fills: [solid("#FFFFFF")],
        props: [
          { id: "pLabel", name: "Label", kind: "text", target: "T", default: "Default" },
          { id: "pIcon", name: "Icon", kind: "boolean", target: "R", default: true },
        ],
      }),
      N("text", "T", "C", { order: 1, text: { content: "Label", ...textProps } }),
      N("rect", "R", "C", { order: 2, x: 60, w: 20, h: 20 }),
      N("rect", "R2", "C", { order: 3, x: 80, w: 10, h: 10, fills: [solid("#000000")] }),
      ...extra,
    ]);
  }
  it("expands into virtual children with property values and overrides", () => {
    const doc = lib([
      N("instance", "I", null, {
        x: 500,
        w: 100,
        h: 40,
        componentId: "C",
        propValues: { pLabel: "Hello", pIcon: false },
        overrides: { R2: { fills: [solid("#FF0000")] }, "": { opacity: 0.5 } },
      }),
    ]);
    const roots = resolvePage(doc, PAGE);
    const { byId } = indexResolved(roots);
    const i = byId.get("I")!;
    expect(i.children.map((c) => c.rid)).toEqual(["I/T", "I/R", "I/R2"]);
    expect(i.fills).toEqual([solid("#FFFFFF")]);
    expect(i.opacity).toBe(0.5);
    const t = byId.get("I/T")!;
    expect(t.text!.content).toBe("Hello");
    expect([t.src, t.okey, t.inst]).toEqual(["I", "T", "I"]);
    expect(byId.get("I/R")!.visible).toBe(false);
    expect(byId.get("I/R2")!.fills).toEqual([solid("#FF0000")]);
    expect(byId.get("I/R2")!.ax).toBe(580);
    // The component itself shows its own content (property defaults are for instances).
    expect(byId.get("T")!.text!.content).toBe("Label");
  });
  it("uses property defaults when the instance sets none", () => {
    const doc = lib([N("instance", "I", null, { w: 100, h: 40, componentId: "C" })]);
    const i = resolveNode(doc, "I")!;
    expect(i.children[0]!.text!.content).toBe("Default");
    expect(i.children[1]!.visible).toBe(true);
  });
  it("nested instances: outer overrides reach inner layers by path key", () => {
    const doc = lib([
      N("component", "C2", null, { w: 200, h: 100 }),
      N("instance", "N", "C2", { order: 1, x: 10, y: 10, w: 100, h: 40, componentId: "C" }),
      N("instance", "J", null, { w: 200, h: 100, componentId: "C2", overrides: { "N/T": { content: "Deep" } } }),
    ]);
    const j = resolveNode(doc, "J")!;
    const n = j.children[0]!;
    expect(n.rid).toBe("J/N");
    expect(n.children[0]!.rid).toBe("J/N/T");
    expect(n.children[0]!.text!.content).toBe("Deep");
  });
  it("scales content by constraints when the instance is resized (no auto layout)", () => {
    const doc = lib([N("instance", "I", null, { w: 200, h: 40, componentId: "C" })]);
    doc.nodes.R2!.constraints = { h: "right", v: "top" };
    const i = resolveNode(doc, "I")!;
    expect(i.children[2]!.x).toBe(180);
    expect(i.children[1]!.x).toBe(60);
  });
});

describe("styles and tokens", () => {
  it("applies colour styles, text styles and tokens", () => {
    const doc = makeDoc(
      [
        N("frame", "F", null, { w: 300, h: 100, radiusToken: "tR", layout: layout({ gap: 1, gapToken: "tGap", paddingToken: "tPad" }), strokes: [{ color: "#000000", width: 1, styleId: "cBlue" }] }),
        N("rect", "A", "F", { order: 1, w: 10, h: 10, fills: [solid("#000000", { styleId: "cRed" })] }),
        N("rect", "B", "F", { order: 2, w: 10, h: 10 }),
        N("text", "T", "F", { order: 3, text: { content: "x", fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left", resize: "auto-width", styleId: "ts" } }),
      ],
      {
        colors: [
          { id: "cRed", name: "Red", color: "#FF0000" },
          { id: "cBlue", name: "Blue", color: "#0000FF" },
        ],
        textStyles: [{ id: "ts", name: "H1", fontFamily: "Poppins", fontWeight: 700, fontSize: 20, lineHeight: 30 }],
        tokens: [
          { id: "tR", name: "radius/md", kind: "radius", value: 12 },
          { id: "tGap", name: "space/sm", kind: "spacing", value: 7 },
          { id: "tPad", name: "space/md", kind: "spacing", value: "16" },
        ],
      },
    );
    const f = resolveNode(doc, "F")!;
    const { A, B, T } = kids(f);
    expect(A!.fills[0]).toMatchObject({ color: "#FF0000", styleId: "cRed" });
    expect(f.strokes[0]!.color).toBe("#0000FF");
    expect(f.radius).toBe(12);
    expect(f.layout!.gap).toBe(7);
    expect(f.layout!.padding).toEqual({ t: 16, r: 16, b: 16, l: 16 });
    expect([A!.x, A!.y, B!.x]).toEqual([16, 16, 33]);
    expect(T!.text).toMatchObject({ fontFamily: "Poppins", fontWeight: 700, fontSize: 20, lineHeight: 30 });
    expect(T!.h).toBe(30);
  });
});

describe("groups", () => {
  it("take the bounds of their children", () => {
    const doc = makeDoc([
      N("group", "G", null, { x: 100, y: 100, w: 1, h: 1 }),
      N("rect", "A", "G", { x: 10, y: 20, w: 10, h: 10, order: 1 }),
      N("rect", "B", "G", { x: 40, y: 30, w: 10, h: 30, order: 2 }),
    ]);
    const g = resolveNode(doc, "G")!;
    expect([g.x, g.y, g.w, g.h]).toEqual([110, 120, 40, 40]);
    expect([g.children[0]!.ax, g.children[0]!.ay]).toEqual([110, 120]);
  });
});

describe("applyConstraints", () => {
  const go = (h: NonNullable<DNode["constraints"]>["h"], v: NonNullable<DNode["constraints"]>["v"]) =>
    applyConstraints({ x: 10, y: 10, w: 20, h: 20, constraints: { h, v } }, 100, 100, 200, 150);
  it("left / top keep position", () => expect(go("left", "top")).toMatchObject({ x: 10, y: 10, w: 20, h: 20 }));
  it("right / bottom move with the far edge", () => expect(go("right", "bottom")).toMatchObject({ x: 110, y: 60, w: 20, h: 20 }));
  it("left-right / top-bottom stretch", () => expect(go("left-right", "top-bottom")).toMatchObject({ x: 10, y: 10, w: 120, h: 70 }));
  it("center keeps the offset from the centre", () => expect(go("center", "center")).toMatchObject({ x: 60, y: 35, w: 20, h: 20 }));
  it("scale scales position and size", () => expect(go("scale", "scale")).toMatchObject({ x: 20, y: 15, w: 40, h: 30 }));
  it("defaults to left / top", () => expect(applyConstraints({ x: 1, y: 2, w: 3, h: 4 }, 10, 10, 50, 50)).toEqual({ x: 1, y: 2, w: 3, h: 4 }));
});
