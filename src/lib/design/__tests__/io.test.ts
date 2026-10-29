import { beforeAll, describe, expect, it } from "vitest";
import { importDesignFile, parseDesignFile, parsePathData, toDesignFile } from "../io";
import { childIndex, resolveNode } from "../layout";
import type { DesignDoc, DNode } from "../types";
import { DESIGN_FORMAT, DESIGN_FORMAT_VERSION } from "../types";
import { N, PAGE, layout, makeDoc, solid, useFakeMeasure } from "./helpers";

beforeAll(useFakeMeasure);

const tp = { fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left" as const, resize: "auto-width" as const };

/** A doc that uses every kind of reference the file format has. */
function source(): DesignDoc {
  return makeDoc(
    [
      N("frame", "screen", null, {
        name: "Home",
        w: 400,
        h: 300,
        radiusToken: "tR",
        layout: layout({ gapToken: "tGap", paddingToken: "tPad" }),
        interactions: [{ id: "i1", trigger: "click", action: { type: "navigate", target: "screen2" }, transition: { type: "instant", duration: 0, easing: "linear" } }],
      }),
      N("frame", "screen2", null, { name: "Details", order: 2, x: 500 }),
      N("component", "btn", null, {
        order: 3,
        y: 400,
        props: [{ id: "pl", name: "Label", kind: "text", target: "label", default: "OK" }],
        fills: [solid("#000000", { styleId: "cBrand" })],
        strokes: [{ color: "#000000", width: 1, styleId: "cBrand" }],
      }),
      N("text", "label", "btn", { order: 1, text: { content: "OK", ...tp, styleId: "tsBody" } }),
      N("component", "card", null, { order: 4, y: 600 }),
      N("instance", "nested", "card", { order: 1, componentId: "btn" }),
      N("instance", "inst", "screen", {
        order: 1,
        componentId: "card",
        propValues: { pl: "Go" },
        overrides: { "nested/label": { content: "Deep", fills: [solid("#000000", { styleId: "cBrand" })] }, "": { opacity: 0.5 } },
      }),
    ],
    {
      pages: [{ id: PAGE, name: "Page 1", start: "screen" }],
      colors: [{ id: "cBrand", name: "Brand", color: "#6633FF" }],
      textStyles: [{ id: "tsBody", name: "Body", fontFamily: "Inter", fontWeight: 400, fontSize: 14 }],
      tokens: [
        { id: "tR", name: "radius", kind: "radius", value: 8 },
        { id: "tGap", name: "gap", kind: "spacing", value: 4 },
        { id: "tPad", name: "pad", kind: "spacing", value: 12 },
      ],
      library: ["btn"],
    },
  );
}

describe("native file round trip", () => {
  it("toDesignFile → JSON → parseDesignFile keeps everything", () => {
    const doc = source();
    const file = toDesignFile(doc, "My design");
    expect(file).toMatchObject({ format: DESIGN_FORMAT, version: DESIGN_FORMAT_VERSION, name: "My design" });
    const back = parseDesignFile(JSON.stringify(file));
    expect(back.data).toEqual(doc.data);
    expect(back.nodes).toEqual(Object.values(doc.nodes));
  });

  it("importing into the same doc remaps every id and reference", () => {
    const doc = source();
    const { pages, nodes, data } = importDesignFile(parseDesignFile(JSON.stringify(toDesignFile(doc, "x"))), doc);
    const oldIds = new Set([...Object.keys(doc.nodes), PAGE, "cBrand", "tsBody", "tR", "tGap", "tPad"]);
    const byOld = (name: string) => nodes.find((n) => n.name === doc.nodes[name]!.name && n.type === doc.nodes[name]!.type)!;
    for (const n of nodes) expect(oldIds.has(n.id)).toBe(false);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);

    // Pages: appended, renamed when the name is taken, start frame remapped.
    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.id).not.toBe(PAGE);
    expect(page.name).toBe("Page 1 (imported)");
    expect(data.pages.map((p) => p.id)).toEqual([PAGE, page.id]);
    const screen = byOld("screen");
    expect(page.start).toBe(screen.id);
    for (const n of nodes) expect(n.page).toBe(page.id);

    // Styles and tokens: fresh ids, appended.
    const color = data.colors[1]!;
    const ts = data.textStyles[1]!;
    expect(data.colors).toHaveLength(2);
    expect(color.id).not.toBe("cBrand");
    expect(data.tokens).toHaveLength(6);
    const tok = (name: string) => data.tokens.slice(3).find((t) => t.name === name)!.id;
    expect(screen.radiusToken).toBe(tok("radius"));
    expect(screen.layout).toMatchObject({ gapToken: tok("gap"), paddingToken: tok("pad") });

    // Layers: parents, components, overrides (path keys), props, interactions, styles.
    const btn = nodes.find((n) => n.type === "component" && n.props)!;
    const label = nodes.find((n) => n.type === "text")!;
    const card = nodes.find((n) => n.type === "component" && !n.props)!;
    const nested = nodes.find((n) => n.type === "instance" && n.parent === card.id)!;
    const inst = nodes.find((n) => n.type === "instance" && n.parent === screen.id)!;
    expect(label.parent).toBe(btn.id);
    expect(nested.componentId).toBe(btn.id);
    expect(inst.componentId).toBe(card.id);
    expect(btn.props![0]!.target).toBe(label.id);
    expect(Object.keys(inst.overrides!).sort()).toEqual(["", `${nested.id}/${label.id}`].sort());
    expect(inst.overrides![`${nested.id}/${label.id}`]!.fills![0]).toMatchObject({ styleId: color.id });
    expect(btn.fills[0]).toMatchObject({ styleId: color.id });
    expect(btn.strokes[0]!.styleId).toBe(color.id);
    expect(label.text!.styleId).toBe(ts.id);
    const it0 = screen.interactions![0]!;
    expect(it0.action).toEqual({ type: "navigate", target: byOld("screen2").id });
    expect(it0.id).not.toBe("i1");
    expect(data.library).toEqual(["btn", btn.id]);
    // Prop ids are the component's own keys: they stay.
    expect(inst.propValues).toEqual({ pl: "Go" });

    // The merged doc resolves the imported copy like the original.
    const merged: DesignDoc = { data, nodes: { ...doc.nodes, ...Object.fromEntries(nodes.map((n) => [n.id, n])) } };
    const idx = childIndex(merged);
    const orig = resolveNode(merged, "inst", idx)!;
    const copy = resolveNode(merged, inst.id, idx)!;
    expect(copy.opacity).toBe(0.5);
    expect(copy.children[0]!.children[0]!.text!.content).toBe(orig.children[0]!.children[0]!.text!.content);
    expect(copy.children[0]!.children[0]!.text!.content).toBe("Deep");
    expect(copy.children[0]!.children[0]!.fills[0]).toMatchObject({ color: "#6633FF" });
    // Originals untouched.
    expect(doc.nodes.inst!.overrides!["nested/label"]).toBeDefined();
  });

  it("keeps page names that don't clash", () => {
    const doc = source();
    const file = toDesignFile(doc, "x");
    file.data.pages[0]!.name = "Mobile";
    expect(importDesignFile(file, doc).pages[0]!.name).toBe("Mobile");
  });
});

describe("parseDesignFile validation", () => {
  const file = (p: Record<string, unknown>) => JSON.stringify({ format: DESIGN_FORMAT, version: 1, name: "f", data: { pages: [{ id: "p", name: "P" }] }, nodes: [], ...p });

  it("rejects non-JSON, other formats and newer versions with clear messages", () => {
    expect(() => parseDesignFile("{nope")).toThrow(/isn't valid JSON/);
    expect(() => parseDesignFile("[]")).toThrow(/expected a JSON object/);
    expect(() => parseDesignFile(file({ format: "figma" }))).toThrow(/isn't an iklipse design file/);
    expect(() => parseDesignFile(file({ version: "1" }))).toThrow(/no valid version/);
    expect(() => parseDesignFile(file({ version: DESIGN_FORMAT_VERSION + 1 }))).toThrow(/newer version/);
    expect(() => parseDesignFile(file({ nodes: {} }))).toThrow(/layer list/);
    expect(() => parseDesignFile(file({ nodes: [{ id: "a", type: "blob" }] }))).toThrow(/unknown type "blob"/);
    expect(() => parseDesignFile(file({ nodes: [{ type: "rect" }] }))).toThrow(/has no id/);
  });

  it("tolerates missing optional fields", () => {
    const f = parseDesignFile(file({ data: { pages: [{ id: "p", name: "P" }] }, nodes: [{ id: "a", type: "rect", page: "p" }, { id: "b", type: "text", parent: "a" }] }));
    expect(f.data).toMatchObject({ colors: [], textStyles: [], tokens: [], library: [] });
    expect(f.data.pages[0]).toEqual({ id: "p", name: "P", start: null });
    const a = f.nodes[0] as DNode;
    expect(a).toMatchObject({ id: "a", type: "rect", page: "p", parent: null, x: 0, y: 0, w: 100, h: 100, rotation: 0, visible: true, locked: false, opacity: 1, fills: [], strokes: [] });
    // A layer without a page gets one.
    const b = f.nodes[1] as DNode;
    expect(b.parent).toBe("a");
    expect(f.data.pages.some((p) => p.id === b.page)).toBe(true);
  });

  it("makes a page when the file has none", () => {
    const f = parseDesignFile(JSON.stringify({ format: DESIGN_FORMAT, version: 1 }));
    expect(f.data.pages).toHaveLength(1);
    expect(f.nodes).toEqual([]);
    expect(f.name).toBe("Untitled");
  });
});

describe("parsePathData", () => {
  it("absolute and relative lines, H / V, close", () => {
    const [s] = parsePathData("M10 10 h20 v10 H10 z");
    expect(s!.closed).toBe(true);
    expect(s!.points.map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [30, 10],
      [30, 20],
      [10, 20],
    ]);
  });
  it("implicit line-tos after M, several subpaths", () => {
    const subs = parsePathData("M0 0 10 0 10 10 M20 20 l5 5");
    expect(subs).toHaveLength(2);
    expect(subs[0]!.points).toHaveLength(3);
    expect(subs[0]!.closed).toBe(false);
    expect(subs[1]!.points.map((p) => [p.x, p.y])).toEqual([
      [20, 20],
      [25, 25],
    ]);
  });
  it("cubic and smooth cubic: handles relative to their points", () => {
    const [s] = parsePathData("M0 0 C10 0 20 10 20 20 S30 40 40 40");
    const [a, b, c] = s!.points;
    expect(a!.out).toEqual({ x: 10, y: 0 });
    expect(b!.in).toEqual({ x: 0, y: -10 });
    // S reflects the previous second control point (20,10) about (20,20) → (20,30).
    expect(b!.out).toEqual({ x: 0, y: 10 });
    expect(c!.in).toEqual({ x: -10, y: 0 });
  });
  it("quadratic curves become cubic; T reflects", () => {
    const [s] = parsePathData("M0 0 Q 15 30 30 0 T 60 0");
    const [a, b, c] = s!.points;
    expect(a!.out!.x).toBeCloseTo(10);
    expect(a!.out!.y).toBeCloseTo(20);
    expect(b!.in!.x).toBeCloseTo(-10);
    expect(b!.in!.y).toBeCloseTo(20);
    expect(b!.out!.y).toBeCloseTo(-20);
    expect([c!.x, c!.y]).toEqual([60, 0]);
  });
  it("arcs become cubic curves ending on the arc's end point", () => {
    const [s] = parsePathData("M0 10 A10 10 0 0 1 20 10");
    const end = s!.points[s!.points.length - 1]!;
    expect([end.x, end.y]).toEqual([20, 10]);
    expect(s!.points.length).toBe(3);
    // Sweep 1 from (0,10) to (20,10) around (10,10) passes over the top (y = 0).
    expect(s!.points[1]!.y).toBeCloseTo(0);
  });
  it("closing on the start point merges it", () => {
    const [s] = parsePathData("M0 0 L10 0 L10 10 L0 0 Z");
    expect(s!.points).toHaveLength(3);
    expect(s!.closed).toBe(true);
  });
  it("skips malformed numbers without eating the next command", () => {
    const [s] = parsePathData("M0 0 L5 Z");
    expect(s!.closed).toBe(true);
  });
});
