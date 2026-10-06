import type { ShapeKind } from "./types";
import type { Rect } from "./geometry";

// SVG outlines for the shape library, drawn in the item's own box (0,0)-(w,h).

export const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: "rect", label: "Rectangle" },
  { kind: "round", label: "Rounded rectangle" },
  { kind: "ellipse", label: "Circle" },
  { kind: "triangle", label: "Triangle" },
  { kind: "diamond", label: "Rhombus" },
  { kind: "pentagon", label: "Pentagon" },
  { kind: "hexagon", label: "Hexagon" },
  { kind: "octagon", label: "Octagon" },
  { kind: "star", label: "Star" },
  { kind: "parallelogram", label: "Parallelogram" },
  { kind: "trapezoid", label: "Trapezoid" },
  { kind: "arrow_right", label: "Right arrow" },
  { kind: "arrow_left", label: "Left arrow" },
  { kind: "chevron", label: "Chevron" },
  { kind: "cross", label: "Cross" },
  { kind: "callout", label: "Speech bubble" },
  { kind: "cylinder", label: "Cylinder" },
  { kind: "cloud", label: "Cloud" },
  { kind: "heart", label: "Heart" },
  { kind: "document", label: "Document" },
];

function poly(pts: [number, number][]) {
  return `M${pts.map(([x, y]) => `${x},${y}`).join(" L")} Z`;
}

function regular(n: number, w: number, h: number, rot = -Math.PI / 2) {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return poly(pts);
}

export function shapePath(kind: ShapeKind, w: number, h: number): string {
  switch (kind) {
    case "rect":
      return poly([[0, 0], [w, 0], [w, h], [0, h]]);
    case "round": {
      const r = Math.min(16, w / 4, h / 4);
      return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`;
    }
    case "ellipse":
      return `M0,${h / 2} A${w / 2},${h / 2} 0 1,0 ${w},${h / 2} A${w / 2},${h / 2} 0 1,0 0,${h / 2} Z`;
    case "triangle":
      return poly([[w / 2, 0], [w, h], [0, h]]);
    case "diamond":
      return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
    case "pentagon":
      return regular(5, w, h);
    case "hexagon":
      return poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]);
    case "octagon": {
      const a = 0.29;
      return poly([[w * a, 0], [w * (1 - a), 0], [w, h * a], [w, h * (1 - a)], [w * (1 - a), h], [w * a, h], [0, h * (1 - a)], [0, h * a]]);
    }
    case "star": {
      const pts: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.4 : 1;
        pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a) + h * 0.05]);
      }
      return poly(pts);
    }
    case "parallelogram":
      return poly([[w * 0.2, 0], [w, 0], [w * 0.8, h], [0, h]]);
    case "trapezoid":
      return poly([[w * 0.2, 0], [w * 0.8, 0], [w, h], [0, h]]);
    case "arrow_right":
      return poly([[0, h * 0.25], [w * 0.6, h * 0.25], [w * 0.6, 0], [w, h / 2], [w * 0.6, h], [w * 0.6, h * 0.75], [0, h * 0.75]]);
    case "arrow_left":
      return poly([[w, h * 0.25], [w * 0.4, h * 0.25], [w * 0.4, 0], [0, h / 2], [w * 0.4, h], [w * 0.4, h * 0.75], [w, h * 0.75]]);
    case "chevron":
      return poly([[0, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [0, h], [w * 0.25, h / 2]]);
    case "cross": {
      const a = 0.33;
      return poly([[w * a, 0], [w * (1 - a), 0], [w * (1 - a), h * a], [w, h * a], [w, h * (1 - a)], [w * (1 - a), h * (1 - a)], [w * (1 - a), h], [w * a, h], [w * a, h * (1 - a)], [0, h * (1 - a)], [0, h * a], [w * a, h * a]]);
    }
    case "callout": {
      const r = Math.min(12, w / 6, h / 6);
      const b = h * 0.78;
      return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${b - r} Q${w},${b} ${w - r},${b} H${w * 0.42} L${w * 0.22},${h} L${w * 0.26},${b} H${r} Q0,${b} 0,${b - r} V${r} Q0,0 ${r},0 Z`;
    }
    case "cylinder": {
      const ry = Math.min(h * 0.12, 24);
      return `M0,${ry} A${w / 2},${ry} 0 0,1 ${w},${ry} V${h - ry} A${w / 2},${ry} 0 0,1 0,${h - ry} Z M0,${ry} A${w / 2},${ry} 0 0,0 ${w},${ry}`;
    }
    case "cloud":
      return `M${w * 0.25},${h * 0.85} C${w * 0.05},${h * 0.85} ${w * 0},${h * 0.55} ${w * 0.18},${h * 0.48} C${w * 0.1},${h * 0.2} ${w * 0.42},${h * 0.08} ${w * 0.5},${h * 0.25} C${w * 0.6},${h * 0.05} ${w * 0.9},${h * 0.15} ${w * 0.84},${h * 0.42} C${w * 1.02},${h * 0.48} ${w * 0.98},${h * 0.85} ${w * 0.76},${h * 0.85} Z`;
    case "heart":
      return `M${w / 2},${h * 0.95} C${w * 0.1},${h * 0.65} ${-w * 0.05},${h * 0.3} ${w * 0.22},${h * 0.1} C${w * 0.38},${-h * 0.02} ${w / 2},${h * 0.12} ${w / 2},${h * 0.25} C${w / 2},${h * 0.12} ${w * 0.62},${-h * 0.02} ${w * 0.78},${h * 0.1} C${w * 1.05},${h * 0.3} ${w * 0.9},${h * 0.65} ${w / 2},${h * 0.95} Z`;
    case "document":
      return `M0,0 H${w} V${h * 0.85} C${w * 0.75},${h * 0.7} ${w * 0.5},${h * 1.05} ${w * 0.25},${h * 0.92} C${w * 0.12},${h * 0.86} ${w * 0.05},${h * 0.85} 0,${h * 0.88} Z`;
    default:
      return poly([[0, 0], [w, 0], [w, h], [0, h]]);
  }
}

/** Where the text sits inside a shape (local box coordinates). */
export function shapeTextBox(kind: ShapeKind, w: number, h: number): Rect {
  const pad = 8;
  const inset = (fx: number, fy: number, fw: number, fh: number): Rect => ({
    x: w * fx + pad,
    y: h * fy + pad,
    w: Math.max(4, w * fw - pad * 2),
    h: Math.max(4, h * fh - pad * 2),
  });
  switch (kind) {
    case "ellipse":
    case "cloud":
      return inset(0.15, 0.2, 0.7, 0.6);
    case "triangle":
      return inset(0.25, 0.45, 0.5, 0.5);
    case "diamond":
      return inset(0.25, 0.25, 0.5, 0.5);
    case "star":
      return inset(0.3, 0.35, 0.4, 0.38);
    case "pentagon":
    case "hexagon":
    case "octagon":
      return inset(0.12, 0.12, 0.76, 0.76);
    case "parallelogram":
    case "trapezoid":
      return inset(0.2, 0, 0.6, 1);
    case "arrow_right":
      return inset(0, 0.25, 0.75, 0.5);
    case "arrow_left":
      return inset(0.25, 0.25, 0.75, 0.5);
    case "chevron":
      return inset(0.25, 0, 0.5, 1);
    case "cross":
      return inset(0.33, 0.33, 0.34, 0.34);
    case "callout":
      return inset(0, 0, 1, 0.78);
    case "cylinder":
      return inset(0, 0.2, 1, 0.75);
    case "heart":
      return inset(0.2, 0.2, 0.6, 0.5);
    case "document":
      return inset(0, 0, 1, 0.8);
    default:
      return inset(0, 0, 1, 1);
  }
}
