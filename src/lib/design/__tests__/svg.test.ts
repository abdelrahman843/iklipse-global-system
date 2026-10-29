// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import { importSvg } from "../io";
import { resolveNode } from "../layout";
import type { DNode } from "../types";
import { PAGE, makeDoc, useFakeMeasure } from "./helpers";

beforeAll(useFakeMeasure);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50">
  <title>Logo</title>
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff0000"/><stop offset="100%" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>
  <rect id="bg" x="5" y="5" width="20" height="10" rx="2" fill="#00ff00" stroke="#000" stroke-width="1"/>
  <circle cx="50" cy="25" r="10" style="fill: rgba(255, 0, 0, 0.5); opacity: 0.8"/>
  <g transform="translate(60 5)" fill="#123456">
    <ellipse cx="10" cy="10" rx="10" ry="5"/>
    <path d="M0 20 L10 20 L10 30 Z M 15 20 h5 v5 z"/>
  </g>
  <line x1="0" y1="45" x2="40" y2="45" stroke="red" stroke-width="2"/>
  <polyline points="0,0 10,10 20,0" fill="none" stroke="#000"/>
  <rect x="0" y="30" width="10" height="10" fill="url(#g)"/>
  <text x="10" y="40" font-size="8" fill="#333">Hi there</text>
  <image x="80" y="40" width="10" height="5" href="data:image/png;base64,AAAA"/>
  <image x="80" y="40" width="10" height="5" href="https://example.com/a.png"/>
  <foo/>
</svg>`;

function load(svg = SVG) {
  const nodes = importSvg(svg, PAGE, null, { x: 1000, y: 2000 });
  const byName = (name: string) => nodes.find((n) => n.name === name)!;
  const kids = (id: string) => nodes.filter((n) => n.parent === id).sort((a, b) => a.order - b.order);
  return { nodes, byName, kids, root: nodes[0]! };
}

describe("importSvg", () => {
  it("wraps everything in a frame named after the SVG, at the drop point, sized by width / height", () => {
    const { root, nodes } = load();
    expect(root).toMatchObject({ type: "frame", name: "Logo", parent: null, page: PAGE, x: 1000, y: 2000, w: 200, h: 100, fills: [], clip: true });
    for (const n of nodes.slice(1)) {
      expect(n.page).toBe(PAGE);
      expect(nodes.some((p) => p.id === n.parent)).toBe(true);
    }
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
  });

  it("rect: viewBox scale (x2), rx, fill and stroke", () => {
    const { byName } = load();
    const r = byName("bg");
    expect(r).toMatchObject({ type: "rect", x: 10, y: 10, w: 40, h: 20, radius: 4, fills: [{ type: "solid", color: "#00FF00" }] });
    expect(r.strokes).toEqual([{ color: "#000000", width: 2, align: "center" }]);
  });

  it("circle: ellipse box, rgba fill opacity, element opacity from style", () => {
    const { nodes } = load();
    const c = nodes.find((n) => n.type === "ellipse" && n.opacity === 0.8)!;
    expect(c).toMatchObject({ x: 80, y: 30, w: 40, h: 40 });
    expect(c.fills).toEqual([{ type: "solid", color: "#FF0000", opacity: 0.5 }]);
  });

  it("g: translate transform, inherited fill, path subpaths each a layer", () => {
    const { nodes, kids, root } = load();
    const g = kids(root.id).find((n) => n.type === "group")!;
    const inside = kids(g.id);
    expect(inside.map((n) => n.type)).toEqual(["ellipse", "group"]);
    const e = inside[0]!;
    // ellipse (0..20, 5..15) + translate(60, 5), x2 → abs (120, 20) 40 x 20; the group starts there.
    expect([g.x, g.y]).toEqual([120, 20]);
    expect([e.x, e.y, e.w, e.h]).toEqual([0, 0, 40, 20]);
    expect(e.fills).toEqual([{ type: "solid", color: "#123456" }]);
    const paths = kids(inside[1]!.id);
    expect(paths).toHaveLength(2);
    expect(paths.every((p) => p.type === "path" && p.closed)).toBe(true);
    // First subpath: triangle (0,20)-(10,20)-(10,30) → abs (120, 50) 20 x 20, points in its own box.
    const p0 = paths[0]!;
    expect([p0.w, p0.h]).toEqual([20, 20]);
    expect(p0.points!.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [20, 0],
      [20, 20],
    ]);
    expect(p0.fills).toEqual([{ type: "solid", color: "#123456" }]);
    expect(nodes.filter((n) => n.type === "path")).toHaveLength(3);
  });

  it("line, polyline, gradient fill, text and data: images", () => {
    const { nodes, root } = load();
    const line = nodes.find((n) => n.type === "line")!;
    expect(line).toMatchObject({ x: 0, y: 90, w: 80, h: 0, strokes: [{ color: "#FF0000", width: 4, align: "center" }] });
    expect(line.points).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);
    const poly = nodes.find((n) => n.type === "path" && !n.closed)!;
    expect(poly.fills).toEqual([]);
    expect(poly.points).toHaveLength(3);
    const grad = nodes.find((n) => n.type === "rect" && n.fills[0]?.type === "linear")!;
    expect(grad.fills[0]).toEqual({
      type: "linear",
      angle: 90,
      stops: [
        { pos: 0, color: "#FF0000" },
        { pos: 1, color: "rgba(0, 0, 255, 0.5)" },
      ],
    });
    const t = nodes.find((n) => n.type === "text")!;
    expect(t.text).toMatchObject({ content: "Hi there", fontSize: 16, resize: "auto-width", align: "left" });
    expect(t.fills).toEqual([{ type: "solid", color: "#333333" }]);
    // Baseline at y = 80 (x2), top = 80 - 0.9 em
    expect([t.x, t.y]).toEqual([20, 80 - 16 * 0.9]);
    const imgs = nodes.filter((n) => n.type === "image");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.image).toMatchObject({ src: "data:image/png;base64,AAAA", nw: 10, nh: 5 });
    // bg, circle, g, line, polyline, gradient rect, text, data image (the linked image and <foo> are skipped)
    expect(nodes.filter((n) => n.parent === root.id)).toHaveLength(8);
  });

  it("the imported layers resolve and keep their page positions", () => {
    const { nodes, byName } = load();
    const doc = makeDoc(nodes as DNode[]);
    const r = resolveNode(doc, nodes[0]!.id)!;
    const bg = r.children.find((c) => c.id === byName("bg").id)!;
    expect([bg.ax, bg.ay]).toEqual([1010, 2010]);
  });

  it("without a size: a group at the drop point around the content", () => {
    const { root, kids } = load(`<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="5" height="5"/><rect x="30" y="20" width="5" height="10"/></svg>`);
    expect(root).toMatchObject({ type: "group", name: "SVG", x: 1000, y: 2000, w: 25, h: 10 });
    expect(kids(root.id).map((n) => [n.x, n.y])).toEqual([
      [0, 0],
      [20, 0],
    ]);
    // Default fill is black.
    expect(kids(root.id)[0]!.fills).toEqual([{ type: "solid", color: "#000000" }]);
  });

  it("rotations keep shapes, skews turn them into paths", () => {
    const { kids, root } = load(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="0" width="20" height="10" transform="rotate(90 10 5)"/><rect width="10" height="10" transform="skewX(30)"/></svg>`,
    );
    const [rot, skew] = kids(root.id);
    expect(rot!.type).toBe("rect");
    expect(rot!.rotation).toBe(90);
    expect([rot!.x, rot!.y, rot!.w, rot!.h]).toEqual([0, 0, 20, 10]);
    expect(skew!.type).toBe("path");
    expect(skew!.closed).toBe(true);
    expect(skew!.points).toHaveLength(4);
  });

  it("rejects markup that isn't SVG", () => {
    expect(() => importSvg("<html></html>", PAGE, null, { x: 0, y: 0 })).toThrow(/doesn't look like an SVG/);
    expect(() => importSvg("<svg", PAGE, null, { x: 0, y: 0 })).toThrow(/doesn't look like an SVG/);
  });
});
