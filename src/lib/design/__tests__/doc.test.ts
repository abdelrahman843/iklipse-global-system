import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { absPos, cloneTrees, detach, makeComponent, makeInstance, removeTrees, reparent, resizeWithConstraints, unwrap, wrap, type Draft } from "../doc";
import { resolveNode, resolvePage, indexResolved } from "../layout";
import {
  ackFlush,
  applyRemote,
  beginGesture,
  cancelGesture,
  endGesture,
  gesture,
  loadDesign,
  redo,
  resetDesign,
  resolvedAll,
  takeFlush,
  tx,
  undo,
  useDesign,
} from "../store";
import type { DNode } from "../types";
import { N, PAGE, data, solid, useFakeMeasure } from "./helpers";

beforeAll(useFakeMeasure);

const S = () => useDesign.getState();
const nodes = () => S().doc.nodes;

function load(list: DNode[], canEdit = true) {
  resetDesign("board", canEdit, true, true);
  loadDesign(data(), list);
}

const byIdOf = () => indexResolved(resolvePage(S().doc, PAGE)).byId;
const abs = (id: string) => absPos(S().doc, id, byIdOf());

describe("transactions", () => {
  beforeEach(() =>
    load([N("frame", "F", null, { x: 100, y: 100, w: 400, h: 300 }), N("rect", "A", "F", { x: 10, y: 10, w: 20, h: 20, order: 1 }), N("rect", "B", "F", { x: 50, y: 60, w: 20, h: 20, order: 2 })]),
  );

  it("undo / redo restore the exact layers (same objects)", () => {
    const a0 = nodes().A!;
    const b0 = nodes().B!;
    tx("Edit", (d) => {
      d.patch("A", { x: 99, name: "Moved" });
      d.remove("B");
      d.put(N("rect", "C", "F", { order: 3 }));
    });
    expect(nodes().A).toMatchObject({ x: 99, name: "Moved" });
    expect(nodes().B).toBeUndefined();
    expect(nodes().C).toBeDefined();
    const a1 = nodes().A!;
    const c1 = nodes().C!;
    expect(S().past).toHaveLength(1);

    undo();
    expect(nodes().A).toBe(a0);
    expect(nodes().B).toBe(b0);
    expect(nodes().C).toBeUndefined();
    expect(S().future).toHaveLength(1);

    redo();
    expect(nodes().A).toBe(a1);
    expect(nodes().B).toBeUndefined();
    expect(nodes().C).toBe(c1);
    expect(S().past).toHaveLength(1);
    expect(S().future).toHaveLength(0);
  });

  it("patch with undefined removes the key", () => {
    tx("Set", (d) => d.patch("A", { absolute: true }));
    tx("Unset", (d) => d.patch("A", { absolute: undefined }));
    expect("absolute" in nodes().A!).toBe(false);
  });

  it("no-op transactions leave no history; a new tx clears redo", () => {
    tx("Nothing", () => {});
    expect(S().past).toHaveLength(0);
    tx("One", (d) => d.patch("A", { x: 1 }));
    undo();
    tx("Two", (d) => d.patch("A", { x: 2 }));
    expect(S().future).toHaveLength(0);
  });

  it("document data changes undo too", () => {
    const before = S().doc.data;
    tx("Add colour", (d) => d.setData((x) => ({ ...x, colors: [...x.colors, { id: "c", name: "Red", color: "#FF0000" }] })));
    expect(S().doc.data.colors).toHaveLength(1);
    expect(S().dirtyData).toBe(true);
    undo();
    expect(S().doc.data).toBe(before);
    redo();
    expect(S().doc.data.colors).toHaveLength(1);
  });

  it("does nothing without edit rights", () => {
    load([N("rect", "A", null)], false);
    expect(tx("Edit", (d) => d.patch("A", { x: 5 }))).toBeUndefined();
    expect(nodes().A!.x).toBe(0);
  });

  it("a gesture lands as one undo step", () => {
    const a0 = nodes().A!;
    beginGesture();
    for (let i = 1; i <= 5; i++) gesture((d) => d.patch("A", { x: 10 + i }));
    expect(S().past).toHaveLength(0);
    endGesture("Move");
    expect(nodes().A!.x).toBe(15);
    expect(S().past).toHaveLength(1);
    expect(S().dirty.A).toBe(true);
    undo();
    expect(nodes().A).toBe(a0);
    redo();
    expect(nodes().A!.x).toBe(15);
  });

  it("a cancelled gesture puts everything back", () => {
    const doc0 = S().doc;
    beginGesture();
    gesture((d) => d.patch("A", { x: 300 }));
    cancelGesture();
    expect(S().doc).toBe(doc0);
    expect(S().past).toHaveLength(0);
  });
});

describe("saving: takeFlush / ackFlush", () => {
  beforeEach(() => load([N("rect", "A", null), N("rect", "B", null)]));

  it("hands out dirty layers once, and retries put them back", () => {
    tx("Edit", (d) => {
      d.patch("A", { x: 5 });
      d.remove("B");
    });
    const f = takeFlush()!;
    expect(f.put.map((n) => n.id)).toEqual(["A"]);
    expect(f.del).toEqual(["B"]);
    expect(f.data).toBeNull();
    expect(S().dirty).toEqual({});
    expect(S().inflight).toEqual({ A: true, B: true });
    expect(takeFlush()).toBeNull();

    // While in flight, remote echoes of the layer don't clobber it.
    applyRemote({ ...nodes().A!, x: -1 });
    expect(nodes().A!.x).toBe(5);

    ackFlush(f, "retry");
    expect(S().inflight).toEqual({});
    expect(S().dirty).toEqual({ A: true, B: true });

    const g = takeFlush()!;
    expect(g.put[0]!.x).toBe(5);
    ackFlush(g, "ok");
    expect(S().dirty).toEqual({});
    expect(S().inflight).toEqual({});
    expect(takeFlush()).toBeNull();
  });

  it("drop forgets the change; data retries keep data dirty", () => {
    tx("Edit", (d) => d.patch("A", { x: 5 }));
    ackFlush(takeFlush()!, "drop");
    expect(S().dirty).toEqual({});
    tx("Data", (d) => d.setData((x) => ({ ...x, tokens: [{ id: "t", name: "s", kind: "spacing", value: 4 }] })));
    const f = takeFlush()!;
    expect(f.data?.tokens).toHaveLength(1);
    expect(S().dirtyData).toBe(false);
    ackFlush(f, "retry");
    expect(S().dirtyData).toBe(true);
    // Edits made while a save was in flight stay dirty after it lands.
    const h = takeFlush()!;
    tx("More", (d) => d.patch("B", { x: 1 }));
    ackFlush(h, "ok");
    expect(S().dirty).toEqual({ B: true });
  });
});

describe("wrap / unwrap", () => {
  beforeEach(() =>
    load([
      N("frame", "F", null, { x: 100, y: 100, w: 400, h: 300 }),
      N("rect", "A", "F", { x: 10, y: 10, w: 20, h: 20, order: 1 }),
      N("rect", "B", "F", { x: 50, y: 60, w: 20, h: 20, order: 2 }),
    ]),
  );

  it("keeps absolute positions both ways", () => {
    const before = { A: abs("A"), B: abs("B") };
    const g = tx("Group", (d) => wrap(d, ["A", "B"], "group", byIdOf()))!;
    const gn = nodes()[g]!;
    expect(gn).toMatchObject({ type: "group", parent: "F", x: 10, y: 10, w: 60, h: 70 });
    expect(nodes().A).toMatchObject({ parent: g, x: 0, y: 0 });
    expect(nodes().B).toMatchObject({ parent: g, x: 40, y: 50 });
    expect({ A: abs("A"), B: abs("B") }).toEqual(before);

    tx("Ungroup", (d) => unwrap(d, g, byIdOf()));
    expect(nodes()[g]).toBeUndefined();
    expect(nodes().A).toMatchObject({ parent: "F", x: 10, y: 10 });
    expect(nodes().B).toMatchObject({ parent: "F", x: 50, y: 60 });
    expect(nodes().A!.order).toBeLessThan(nodes().B!.order);
  });

  it("wraps in a frame without fill or clip", () => {
    const f = tx("Frame", (d) => wrap(d, ["A", "B"], "frame", byIdOf()))!;
    expect(nodes()[f]).toMatchObject({ type: "frame", fills: [], clip: false });
    expect(abs("B")).toEqual({ x: 150, y: 160 });
  });

  it("reparent keeps the page position", () => {
    tx("Out", (d) => reparent(d, ["A"], null, PAGE, byIdOf()));
    expect(nodes().A).toMatchObject({ parent: null, x: 110, y: 110 });
  });
});

describe("cloneTrees", () => {
  it("copies subtrees with fresh ids, remapped parents and component props", () => {
    load([
      N("component", "C", null, { x: 5, y: 5, props: [{ id: "p", name: "Label", kind: "text", target: "T", default: "x" }] }),
      N("text", "T", "C", { order: 1 }),
      N("group", "G", "C", { order: 2 }),
      N("rect", "R", "G", { order: 1, x: 3 }),
    ]);
    const out = cloneTrees(S().doc, ["C"], null, PAGE, 10, 20);
    expect(out).toHaveLength(4);
    const ids = new Set(out.map((n) => n.id));
    for (const id of ["C", "T", "G", "R"]) expect(ids.has(id)).toBe(false);
    const [c, t, g, r] = out as [DNode, DNode, DNode, DNode];
    expect([c.x, c.y, c.parent]).toEqual([15, 25, null]);
    expect(t.parent).toBe(c.id);
    expect(g.parent).toBe(c.id);
    expect(r.parent).toBe(g.id);
    expect(r.x).toBe(3);
    expect(c.props![0]!.target).toBe(t.id);
    // The originals are untouched.
    expect(nodes().C!.props![0]!.target).toBe("T");
  });
});

describe("components and instances", () => {
  const textProps = { fontFamily: "Inter", fontWeight: 400, fontSize: 10, align: "left" as const, resize: "auto-width" as const };

  it("makeComponent turns a lone frame into a component, wraps anything else", () => {
    load([N("frame", "F", null), N("rect", "A", null, { x: 0, y: 0, w: 10, h: 10, order: 1 }), N("rect", "B", null, { x: 20, y: 0, w: 10, h: 10, order: 2 })]);
    expect(tx("C", (d) => makeComponent(d, ["F"], byIdOf()))).toBe("F");
    expect(nodes().F).toMatchObject({ type: "component", props: [] });
    const c = tx("C2", (d) => makeComponent(d, ["A", "B"], byIdOf()))!;
    expect(nodes()[c]).toMatchObject({ type: "component", w: 30, h: 10, props: [] });
    expect(nodes().A!.parent).toBe(c);
  });

  it("makeInstance copies size and sizing; detach makes real layers of what it showed", () => {
    load([
      N("component", "C", null, { w: 100, h: 40, sizing: { h: "fixed", v: "hug" }, fills: [solid("#123456")], props: [{ id: "p", name: "Label", kind: "text", target: "T", default: "Def" }] }),
      N("text", "T", "C", { order: 1, text: { content: "Label", ...textProps } }),
      N("rect", "R", "C", { order: 2, x: 50, w: 10, h: 10 }),
    ]);
    expect(makeInstance(S().doc, "R", PAGE, null, 0, 0)).toBeNull();
    const inst = makeInstance(S().doc, "C", PAGE, null, 300, 0)!;
    expect(inst).toMatchObject({ type: "instance", componentId: "C", w: 100, h: 40, x: 300, sizing: { h: "fixed", v: "hug" }, overrides: {}, propValues: {} });
    inst.propValues = { p: "Hi" };
    inst.overrides = { R: { fills: [solid("#FF0000")] } };
    tx("Add", (d) => d.put(inst));

    const r = resolveNode(S().doc, inst.id)!;
    tx("Detach", (d) => detach(d, inst.id, r));
    const n = nodes()[inst.id]!;
    expect(n.type).toBe("frame");
    expect(n.componentId).toBeUndefined();
    expect(n.overrides).toBeUndefined();
    expect(n.fills).toEqual([solid("#123456")]);
    const kids = Object.values(nodes()).filter((x) => x.parent === inst.id);
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.id !== "T" && k.id !== "R" && !k.id.includes("/"))).toBe(true);
    const t = kids.find((k) => k.type === "text")!;
    const rect = kids.find((k) => k.type === "rect")!;
    expect(t.text!.content).toBe("Hi");
    expect(rect.fills).toEqual([solid("#FF0000")]);
    expect(rect.x).toBe(50);
    // The detached copy no longer changes with the component.
    tx("Edit comp", (d) => d.patch("R", { x: 0 }));
    expect(resolveNode(S().doc, inst.id)!.children.find((c) => c.type === "rect")!.x).toBe(50);
  });

  it("removeTrees deletes descendants and detaches instances of a deleted component", () => {
    load([
      N("component", "C", null, { w: 100, h: 40 }),
      N("rect", "R", "C", { order: 1, fills: [solid("#00FF00")] }),
      N("instance", "I", null, { x: 300, w: 100, h: 40, componentId: "C" }),
    ]);
    tx("Delete", (d) => removeTrees(d, ["C"], resolvedAll(S().doc)));
    expect(nodes().C).toBeUndefined();
    expect(nodes().R).toBeUndefined();
    expect(nodes().I!.type).toBe("frame");
    const kids = Object.values(nodes()).filter((x) => x.parent === "I");
    expect(kids).toHaveLength(1);
    expect(kids[0]!.fills).toEqual([solid("#00FF00")]);
    // One undo brings it all back.
    undo();
    expect(nodes().C).toBeDefined();
    expect(nodes().R).toBeDefined();
    expect(nodes().I!.type).toBe("instance");
    expect(Object.values(nodes()).filter((x) => x.parent === "I")).toHaveLength(0);
  });
});

describe("resizeWithConstraints", () => {
  it("moves / stretches children of a frame by their constraints", () => {
    load([
      N("frame", "F", null, { w: 100, h: 100 }),
      N("rect", "A", "F", { x: 10, y: 10, w: 20, h: 20, order: 1, constraints: { h: "right", v: "top-bottom" } }),
      N("rect", "B", "F", { x: 10, y: 10, w: 20, h: 20, order: 2 }),
    ]);
    tx("Resize", (d) => resizeWithConstraints(d, "F", { x: 0, y: 0, w: 200, h: 150 }));
    expect(nodes().F).toMatchObject({ w: 200, h: 150 });
    expect(nodes().A).toMatchObject({ x: 110, y: 10, w: 20, h: 70 });
    expect(nodes().B).toMatchObject({ x: 10, y: 10, w: 20, h: 20 });
  });
  it("scales children of a group", () => {
    load([N("group", "G", null, { w: 100, h: 100 }), N("rect", "A", "G", { x: 50, y: 50, w: 50, h: 50, order: 1 })]);
    tx("Resize", (d: Draft) => resizeWithConstraints(d, "G", { x: 0, y: 0, w: 200, h: 50 }));
    expect(nodes().A).toMatchObject({ x: 100, y: 25, w: 100, h: 25 });
  });
});
