import { beforeAll, describe, expect, it } from "vitest";
import { detach } from "../doc";
import { resolveNode } from "../layout";
import { loadDesign, resetDesign, tx, useDesign } from "../store";
import type { DNode } from "../types";
import { N, data, makeDoc, solid, useFakeMeasure } from "./helpers";

// Regressions: instances inside components (nested instances).

beforeAll(useFakeMeasure);

const tp = { fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left" as const, resize: "auto-width" as const };
/** C: a button with a label T. C2: a card with an instance N of C. */
const base = (n: Partial<DNode> = {}) => [
  N("component", "C", null, { w: 100, h: 40, fills: [solid("#FFFFFF")] }),
  N("text", "T", "C", { order: 1, text: { content: "Label", ...tp } }),
  N("component", "C2", null, { w: 200, h: 100 }),
  N("instance", "N", "C2", { order: 1, w: 100, h: 40, componentId: "C", ...n }),
];

describe("nested instances", () => {
  it("keep the overrides they have inside their component", () => {
    const doc = makeDoc([...base({ overrides: { T: { content: "Buy" } } }), N("instance", "J", null, { w: 200, h: 100, componentId: "C2" })]);
    expect(resolveNode(doc, "C2")!.children[0]!.children[0]!.text!.content).toBe("Buy");
    expect(resolveNode(doc, "J")!.children[0]!.children[0]!.text!.content).toBe("Buy");
  });

  it("outer overrides win over the nested instance's own, per property", () => {
    const doc = makeDoc([
      ...base({ overrides: { T: { content: "Buy", fills: [solid("#00FF00")] } } }),
      N("instance", "J", null, { w: 200, h: 100, componentId: "C2", overrides: { "N/T": { content: "Sell" } } }),
    ]);
    const t = resolveNode(doc, "J")!.children[0]!.children[0]!;
    expect(t.text!.content).toBe("Sell");
    expect(t.fills).toEqual([solid("#00FF00")]);
  });

  it("show outer overrides on their own box (fills)", () => {
    const doc = makeDoc([...base(), N("instance", "J", null, { w: 200, h: 100, componentId: "C2", overrides: { N: { fills: [solid("#FF0000")] } } })]);
    expect(resolveNode(doc, "J")!.children[0]!.fills).toEqual([solid("#FF0000")]);
  });

  it("detach keeps them as instances, without child rows, carrying the outer overrides", () => {
    resetDesign("b", true, true, true);
    loadDesign(data(), [
      ...base({ overrides: { T: { fills: [solid("#00FF00")] } } }),
      N("instance", "J", null, { w: 200, h: 100, componentId: "C2", overrides: { "N/T": { content: "Deep" } } }),
    ]);
    const r = resolveNode(useDesign.getState().doc, "J")!;
    tx("Detach", (d) => detach(d, "J", r));
    const nodes = useDesign.getState().doc.nodes;
    const copy = Object.values(nodes).find((n) => n.parent === "J")!;
    expect(copy.type).toBe("instance");
    expect(copy.overrides).toEqual({ T: { fills: [solid("#00FF00")], content: "Deep" } });
    expect(Object.values(nodes).filter((n) => n.parent === copy.id)).toHaveLength(0);
    const t = resolveNode(useDesign.getState().doc, "J")!.children[0]!.children[0]!;
    expect(t.text!.content).toBe("Deep");
    expect(t.fills).toEqual([solid("#00FF00")]);
  });

  it("overridden paints that use a colour style follow the style (layers and the instance box)", () => {
    const styled = [solid("#000000", { styleId: "brand" })];
    const doc = makeDoc([...base(), N("instance", "I", null, { w: 100, h: 40, componentId: "C", overrides: { T: { fills: styled }, "": { fills: styled } } })], {
      colors: [{ id: "brand", name: "Brand", color: "#6633FF" }],
    });
    const i = resolveNode(doc, "I")!;
    expect(i.fills[0]).toMatchObject({ color: "#6633FF" });
    expect(i.children[0]!.fills[0]).toMatchObject({ color: "#6633FF" });
  });
});
