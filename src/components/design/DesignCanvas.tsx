import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { addImages, addNode, duplicateSelection, insertInstance, selectedReal } from "@/lib/design/actions";
import { descendants, isVirtual, makeNode, reparent, resizeWithConstraints, topOrder } from "@/lib/design/doc";
import { containerAt, enterTarget, flowIndex, marqueeHits, normRect, pathTo, pickTarget, resizeBox, snapBox, snapPoint, tickStep, type Guide } from "@/lib/design/interact";
import { unionRect, type RNode } from "@/lib/design/layout";
import {
  beginGesture,
  cancelGesture,
  endGesture,
  gesture,
  patchSelection,
  resolved,
  select,
  setViewport,
  toWorld,
  toggleSelect,

  useDesign,
  zoomAt,
} from "@/lib/design/store";
import { broadcast } from "@/lib/design/sync";
import { cssFont, lineHeightOf } from "@/lib/design/text";
import type { NodeType, PathPoint, Rect } from "@/lib/design/types";
import { NodeSvg, RenderProvider, pointsPath, textLines } from "./Render";

// -----------------------------------------------------------------------------
// The design canvas: page content drawn by Render.tsx under a pan / zoom
// transform, with selection, handles, guides, rulers and live cursors on top.
// One pointer gesture at a time (a ref, not state, so moves don't re-render).
// -----------------------------------------------------------------------------

const S = useDesign.getState;
const set = useDesign.setState;

const RULER = 20;
const CREATE_TOOLS: NodeType[] = ["frame", "rect", "ellipse", "line", "arrow", "polygon", "star", "text"];

type Drag =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number; scope: RNode[]; base: string[] }
  | {
      kind: "move";
      sx: number;
      sy: number;
      nodes: { id: string; x: number; y: number }[];
      box: Rect;
      others: Rect[];
      flowParent: RNode | null;
      moved: boolean;
    }
  | { kind: "resize"; handle: string; sx: number; sy: number; items: { id: string; abs: Rect; parentAbs: { x: number; y: number } }[]; box: Rect; others: Rect[] }
  | { kind: "rotate"; cx: number; cy: number; a0: number; id: string; r0: number }
  | { kind: "create"; type: NodeType; id: string; sx: number; sy: number; parentAbs: { x: number; y: number }; moved: boolean }
  | { kind: "point"; id: string; index: number; part: "anchor" | "in" | "out"; sx: number; sy: number; start: PathPoint[] };

export function DesignCanvas({ onComment, onContextMenu }: { onComment: (at: { x: number; y: number; node: string | null }) => void; onContextMenu: (e: { x: number; y: number; world: { x: number; y: number } }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const doc = useDesign((s) => s.doc);
  const page = useDesign((s) => s.page);
  const viewport = useDesign((s) => s.viewport);
  const selection = useDesign((s) => s.selection);
  const hover = useDesign((s) => s.hover);
  const tool = useDesign((s) => s.tool);
  const editingText = useDesign((s) => s.editingText);
  const editingPath = useDesign((s) => s.editingPath);
  const guides = useDesign((s) => s.guides);
  const showRulers = useDesign((s) => s.showRulers);
  const showGrid = useDesign((s) => s.showGrid);
  const peers = useDesign((s) => s.peers);
  const canEdit = useDesign((s) => s.canEdit);
  const { roots, byId } = useMemo(() => resolved(doc, page), [doc, page]);
  const bg = doc.data.pages.find((p) => p.id === page)?.bg ?? "#f5f5f5";

  const drag = useRef<Drag | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [insertAt, setInsertAt] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [pen, setPen] = useState<{ pts: PathPoint[]; cursor: { x: number; y: number } | null } | null>(null);
  const space = useRef(false);

  // Screen size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => set({ screen: { w: el.clientWidth, h: el.clientHeight } }));
    ro.observe(el);
    set({ screen: { w: el.clientWidth, h: el.clientHeight } });
    return () => ro.disconnect();
  }, []);

  // Space bar pans.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e)) {
        space.current = true;
        if (ref.current) ref.current.style.cursor = "grab";
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        space.current = false;
        if (ref.current) ref.current.style.cursor = "";
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Wheel: pan, Ctrl / pinch zooms (non-passive so the page doesn't zoom).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), { x: e.clientX - rect.left, y: e.clientY - rect.top });
        return;
      }
      const v = S().viewport;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      setViewport({ ...v, x: v.x - dx, y: v.y - dy });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Pen: Enter / Escape finish the path.
  const finishPen = useCallback(
    (close: boolean) => {
      setPen((cur) => {
        if (cur && cur.pts.length >= 2) commitPath(cur.pts, close);
        return null;
      });
      if (!S().toolLock) set({ tool: "select" });
    },
    [],
  );
  useEffect(() => {
    if (tool !== "pen") {
      setPen(null);
      return;
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finishPen(false);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [tool, finishPen]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ------------------------------------------------------------- pointer --
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-design-ui]")) return;
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const sp = local(e);
    const w = toWorld(sp);
    const s = S();
    const rs = resolved();

    // Pan: middle button, space, hand tool.
    if (e.button === 1 || space.current || s.tool === "hand") {
      drag.current = { kind: "pan", sx: sp.x, sy: sp.y, vx: s.viewport.x, vy: s.viewport.y };
      el.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    if (s.editingText) {
      set({ editingText: null });
      return;
    }

    // Path point handles.
    const ph = (e.target as Element).closest("[data-point]") as HTMLElement | null;
    if (ph && s.editingPath) {
      const n = s.doc.nodes[s.editingPath];
      if (n?.points) {
        beginGesture();
        drag.current = { kind: "point", id: n.id, index: Number(ph.dataset.point), part: (ph.dataset.part as "anchor" | "in" | "out") ?? "anchor", sx: w.x, sy: w.y, start: n.points };
      }
      return;
    }
    if (s.editingPath && !(e.target as Element).closest(`[data-rid="${s.editingPath}"]`)) set({ editingPath: null });

    if (s.tool === "comment") {
      const hit = hitRid(e.target);
      onComment({ x: w.x, y: w.y, node: hit && !isVirtual(hit) ? hit : null });
      return;
    }

    if (s.tool === "pen" && s.canEdit) {
      setPen((cur) => {
        const pts = cur?.pts ?? [];
        const first = pts[0];
        if (first && pts.length > 2 && Math.hypot(first.x - w.x, first.y - w.y) * s.viewport.zoom < 8) {
          commitPath(pts, true);
          if (!S().toolLock) set({ tool: "select" });
          return null;
        }
        return { pts: [...pts, { x: w.x, y: w.y }], cursor: w };
      });
      drag.current = null;
      penDown.current = { x: w.x, y: w.y };
      return;
    }

    if (s.tool === "image" && s.canEdit) {
      pickImages(w);
      set({ tool: "select" });
      return;
    }

    if (CREATE_TOOLS.includes(s.tool as NodeType) && s.canEdit) {
      const type = s.tool as NodeType;
      const parent = containerAt(rs.roots, w, new Set());
      const pAbs = parent ? { x: parent.ax, y: parent.ay } : { x: 0, y: 0 };
      const snapped = s.snap ? snapPoint(w, othersFor(rs.roots, parent, new Set()), 6 / s.viewport.zoom) : { x: w.x, y: w.y, guides: [] };
      const n = makeNode(type, s.page, parent?.rid ?? null, {
        x: Math.round(snapped.x - pAbs.x),
        y: Math.round(snapped.y - pAbs.y),
        w: type === "text" ? 1 : 1,
        h: type === "text" ? 1 : 1,
        order: topOrder(s.doc, parent?.rid ?? null, s.page),
      });
      if (type === "text") n.text = { ...n.text!, content: "" };
      if (type === "frame" && !parent) n.name = `Frame ${Object.values(s.doc.nodes).filter((x) => x.page === s.page && x.type === "frame").length + 1}`;
      if (type === "line" || type === "arrow") n.points = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
      beginGesture();
      gesture((d) => d.put(n));
      drag.current = { kind: "create", type, id: n.id, sx: snapped.x, sy: snapped.y, parentAbs: pAbs, moved: false };
      return;
    }

    // Handles on the selection.
    const handle = (e.target as Element).closest("[data-handle]") as HTMLElement | null;
    if (handle && s.canEdit) {
      const h = handle.dataset.handle!;
      const real = selectedReal();
      if (h === "rotate" && real.length === 1) {
        const r = rs.byId.get(real[0]!.id)!;
        const cx = r.ax + r.w / 2;
        const cy = r.ay + r.h / 2;
        beginGesture();
        drag.current = { kind: "rotate", cx, cy, a0: Math.atan2(w.y - cy, w.x - cx), id: r.rid, r0: r.rotation };
        return;
      }
      const items = real
        .map((n) => {
          const r = rs.byId.get(n.id);
          if (!r) return null;
          const p = rs.parentOf.get(n.id);
          return { id: n.id, abs: { x: r.ax, y: r.ay, w: r.w, h: r.h }, parentAbs: p ? { x: p.ax, y: p.ay } : { x: 0, y: 0 } };
        })
        .filter(Boolean) as { id: string; abs: Rect; parentAbs: { x: number; y: number } }[];
      if (!items.length) return;
      const box = unionRect(items.map((i) => i.abs))!;
      const excl = new Set(items.map((i) => i.id));
      beginGesture();
      drag.current = { kind: "resize", handle: h, sx: w.x, sy: w.y, items, box, others: othersFor(rs.roots, rs.parentOf.get(items[0]!.id) ?? null, excl) };
      return;
    }

    // Frame name labels select the frame.
    const label = (e.target as HTMLElement).closest("[data-frame-label]") as HTMLElement | null;
    const hitId = label?.dataset.frameLabel ?? hitRid(e.target);
    if (!hitId) {
      // Empty canvas: marquee.
      if (!e.shiftKey) select([]);
      drag.current = { kind: "marquee", x0: w.x, y0: w.y, x1: w.x, y1: w.y, scope: rs.roots, base: e.shiftKey ? s.selection : [] };
      return;
    }
    const path = pathTo(hitId, rs.parentOf, rs.byId);
    const target = label ? rs.byId.get(hitId)! : pickTarget(path, s.selection, e.ctrlKey || e.metaKey, rs.parentOf);
    if (!target) {
      select([]);
      drag.current = { kind: "marquee", x0: w.x, y0: w.y, x1: w.x, y1: w.y, scope: rs.roots, base: [] };
      return;
    }
    // Starting a marquee inside a frame when clicking its background with alt.
    if (e.shiftKey) {
      toggleSelect(target.rid);
      return;
    }
    if (!s.selection.includes(target.rid)) select([target.rid]);
    if (!s.canEdit) return;
    startMove(w, e.altKey);
  };

  const penDown = useRef<{ x: number; y: number } | null>(null);

  function startMove(w: { x: number; y: number }, alt: boolean) {
    if (alt) duplicateSelection(0);
    const rs = resolved();
    const real = selectedReal();
    if (!real.length) return;
    const rects = real.map((n) => rs.byId.get(n.id)).filter(Boolean) as RNode[];
    const box = unionRect(rects.map((r) => ({ x: r.ax, y: r.ay, w: r.w, h: r.h })));
    if (!box) return;
    const parent = rs.parentOf.get(real[0]!.id) ?? null;
    const excl = new Set(real.map((n) => n.id));
    const flowParent = parent?.layout && real.every((n) => n.parent === parent.rid && !n.absolute) ? parent : null;
    beginGesture();
    drag.current = {
      kind: "move",
      sx: w.x,
      sy: w.y,
      nodes: real.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      box,
      others: othersFor(rs.roots, parent, excl),
      flowParent,
      moved: false,
    };
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const sp = local(e);
    const w = toWorld(sp);
    const s = S();
    broadcast({ c: { x: Math.round(w.x), y: Math.round(w.y), page: s.page } });
    if (pen) setPen({ ...pen, cursor: w });
    const d = drag.current;
    if (!d) {
      // Pen drag: pulling out handles of the point just placed.
      if (s.tool === "pen" && penDown.current && e.buttons === 1 && pen?.pts.length) {
        const last = pen.pts[pen.pts.length - 1]!;
        const out = { x: w.x - last.x, y: w.y - last.y };
        setPen({ pts: [...pen.pts.slice(0, -1), { ...last, out, in: { x: -out.x, y: -out.y } }], cursor: w });
        return;
      }
      if (s.tool === "select" && !(e.target as Element).closest("[data-design-ui]")) {
        const hit = hitRid(e.target);
        let h: string | null = null;
        if (hit) {
          const rs = resolved();
          h = pickTarget(pathTo(hit, rs.parentOf, rs.byId), s.selection, e.ctrlKey || e.metaKey, rs.parentOf)?.rid ?? null;
        }
        if (h !== s.hover) set({ hover: h });
      }
      return;
    }
    const z = s.viewport.zoom;
    switch (d.kind) {
      case "pan":
        setViewport({ ...s.viewport, x: d.vx + sp.x - d.sx, y: d.vy + sp.y - d.sy });
        return;
      case "marquee": {
        d.x1 = w.x;
        d.y1 = w.y;
        const r = normRect(d.x0, d.y0, d.x1, d.y1);
        setMarquee(r);
        // Inside a frame where the marquee started: its children, else top level.
        const start = containerAt(d.scope, { x: d.x0, y: d.y0 }, new Set());
        const scope = start ? start.children : d.scope;
        const hits = marqueeHits(r, scope);
        set({ selection: [...new Set([...d.base, ...hits])] });
        return;
      }
      case "move": {
        let dx = w.x - d.sx;
        let dy = w.y - d.sy;
        if (!d.moved && Math.hypot(dx, dy) * z < 3) return;
        d.moved = true;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (d.flowParent) {
          // Auto layout children reorder instead of moving.
          const idx = flowIndex(d.flowParent, w, new Set(d.nodes.map((n) => n.id)));
          const flow = d.flowParent.children.filter((c) => c.visible !== false && !c.absolute && !d.nodes.some((n) => n.id === c.rid));
          const horiz = d.flowParent.layout!.mode === "horizontal";
          const ref = flow[idx] ?? flow[flow.length - 1];
          if (ref) {
            const before = idx < flow.length;
            const pos = horiz ? (before ? ref.ax - 2 : ref.ax + ref.w + 2) : before ? ref.ay - 2 : ref.ay + ref.h + 2;
            setInsertAt(horiz ? { x0: pos, y0: d.flowParent.ay, x1: pos, y1: d.flowParent.ay + d.flowParent.h } : { x0: d.flowParent.ax, y0: pos, x1: d.flowParent.ax + d.flowParent.w, y1: pos });
          }
          return;
        }
        let g: Guide[] = [];
        if (s.snap && !e.ctrlKey) {
          const snap = snapBox({ ...d.box, x: d.box.x + dx, y: d.box.y + dy }, d.others, 6 / z);
          dx += snap.dx;
          dy += snap.dy;
          g = snap.guides;
        }
        gesture((dr) => {
          for (const n of d.nodes) dr.patch(n.id, { x: Math.round(n.x + dx), y: Math.round(n.y + dy) });
        });
        set({ guides: g });
        return;
      }
      case "resize": {
        let dx = w.x - d.sx;
        let dy = w.y - d.sy;
        let g: Guide[] = [];
        if (s.snap && !e.ctrlKey && !e.altKey) {
          const hx = d.handle.includes("e") ? d.box.x + d.box.w : d.handle.includes("w") ? d.box.x : null;
          const hy = d.handle.includes("s") ? d.box.y + d.box.h : d.handle.includes("n") ? d.box.y : null;
          const p = snapPoint({ x: (hx ?? 0) + dx, y: (hy ?? 0) + dy }, d.others, 6 / z);
          if (hx !== null) dx = p.x - hx;
          if (hy !== null) dy = p.y - hy;
          g = p.guides.filter((x) => (x.x !== undefined && hx !== null) || (x.y !== undefined && hy !== null));
        }
        const nb = resizeBox(d.box, d.handle, dx, dy, { keepRatio: e.shiftKey, fromCenter: e.altKey });
        const sx = d.box.w ? nb.w / d.box.w : 1;
        const sy = d.box.h ? nb.h / d.box.h : 1;
        gesture((dr) => {
          for (const it of d.items) {
            const abs = d.items.length === 1 ? nb : { x: nb.x + (it.abs.x - d.box.x) * sx, y: nb.y + (it.abs.y - d.box.y) * sy, w: it.abs.w * sx, h: it.abs.h * sy };
            const n = dr.get(it.id);
            if (!n) continue;
            const next = { x: Math.round(abs.x - it.parentAbs.x), y: Math.round(abs.y - it.parentAbs.y), w: Math.max(1, Math.round(abs.w)), h: Math.max(n.type === "line" || n.type === "arrow" ? 0 : 1, Math.round(abs.h)) };
            // Resizing fixes the size on that axis (no more hug / fill).
            const sizing = n.sizing && { h: d.handle.match(/[ew]/) ? ("fixed" as const) : n.sizing.h, v: d.handle.match(/[ns]/) ? ("fixed" as const) : n.sizing.v };
            if (sizing) dr.patch(it.id, { sizing });
            if (n.type === "text" && n.text && d.handle.match(/[ns]/) && n.text.resize !== "fixed") dr.patch(it.id, { text: { ...n.text, resize: "fixed" } });
            resizeWithConstraints(dr, it.id, next);
          }
        });
        set({ guides: g });
        return;
      }
      case "rotate": {
        let a = ((Math.atan2(w.y - d.cy, w.x - d.cx) - d.a0) * 180) / Math.PI + d.r0;
        if (e.shiftKey) a = Math.round(a / 15) * 15;
        a = ((((a + 180) % 360) + 360) % 360) - 180;
        gesture((dr) => dr.patch(d.id, { rotation: Math.round(a * 10) / 10 }));
        return;
      }
      case "create": {
        let ex = w.x;
        let ey = w.y;
        if (s.snap) {
          const p = snapPoint(w, othersFor(resolved().roots, null, new Set([d.id])), 6 / z);
          ex = p.x;
          ey = p.y;
          set({ guides: p.guides });
        }
        if (!d.moved && Math.hypot(ex - d.sx, ey - d.sy) * z < 3) return;
        d.moved = true;
        if (d.type === "line" || d.type === "arrow") {
          if (e.shiftKey) {
            const ang = Math.round(Math.atan2(ey - d.sy, ex - d.sx) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(ex - d.sx, ey - d.sy);
            ex = d.sx + Math.cos(ang) * len;
            ey = d.sy + Math.sin(ang) * len;
          }
          const x = Math.min(d.sx, ex);
          const y = Math.min(d.sy, ey);
          gesture((dr) =>
            dr.patch(d.id, {
              x: Math.round(x - d.parentAbs.x),
              y: Math.round(y - d.parentAbs.y),
              w: Math.max(1, Math.round(Math.abs(ex - d.sx))),
              h: Math.round(Math.abs(ey - d.sy)),
              points: [
                { x: d.sx - x, y: d.sy - y },
                { x: ex - x, y: ey - y },
              ],
            }),
          );
          return;
        }
        let r = normRect(d.sx, d.sy, ex, ey);
        if (e.shiftKey) {
          const m = Math.max(r.w, r.h);
          r = { x: ex < d.sx ? d.sx - m : d.sx, y: ey < d.sy ? d.sy - m : d.sy, w: m, h: m };
        }
        if (e.altKey) r = { x: d.sx - Math.abs(ex - d.sx), y: d.sy - Math.abs(ey - d.sy), w: Math.abs(ex - d.sx) * 2, h: Math.abs(ey - d.sy) * 2 };
        gesture((dr) => {
          const n = dr.get(d.id);
          dr.patch(d.id, {
            x: Math.round(r.x - d.parentAbs.x),
            y: Math.round(r.y - d.parentAbs.y),
            w: Math.max(1, Math.round(r.w)),
            h: Math.max(1, Math.round(r.h)),
            ...(n?.type === "text" && n.text ? { text: { ...n.text, resize: "auto-height" as const } } : {}),
          });
        });
        return;
      }
      case "point": {
        const dx = w.x - d.sx;
        const dy = w.y - d.sy;
        gesture((dr) => {
          const pts = d.start.map((p, i) => {
            if (i !== d.index) return p;
            if (d.part === "anchor") return { ...p, x: p.x + dx, y: p.y + dy };
            const h = d.part === "in" ? p.in : p.out;
            const nh = { x: (h?.x ?? 0) + dx, y: (h?.y ?? 0) + dy };
            // Smooth points keep handles mirrored (Alt breaks the pair).
            const mirror = !e.altKey ? { x: -nh.x, y: -nh.y } : undefined;
            return d.part === "in" ? { ...p, in: nh, out: mirror ?? p.out } : { ...p, out: nh, in: mirror ?? p.in };
          });
          dr.patch(d.id, { points: pts });
        });
        return;
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    penDown.current = null;
    if (ref.current) ref.current.style.cursor = "";
    set({ guides: [] });
    if (!d) return;
    const s = S();
    const w = toWorld(local(e));
    switch (d.kind) {
      case "marquee":
        setMarquee(null);
        return;
      case "move": {
        setInsertAt(null);
        if (!d.moved) {
          cancelGesture();
          return;
        }
        if (d.flowParent) {
          const ids = new Set(d.nodes.map((n) => n.id));
          const idx = flowIndex(d.flowParent, w, ids);
          const flow = d.flowParent.children.filter((c) => !c.absolute && !ids.has(c.rid));
          const prev = flow[idx - 1];
          const next = flow[idx];
          const lo = prev?.order ?? (next ? next.order - 1 : 0);
          const hi = next?.order ?? lo + 1;
          gesture((dr) => d.nodes.forEach((n, i) => dr.patch(n.id, { order: lo + ((hi - lo) * (i + 1)) / (d.nodes.length + 1) })));
          endGesture("Reorder");
          return;
        }
        // Dropped into another frame?
        const rs = resolved();
        const excl = new Set<string>(d.nodes.map((n) => n.id));
        for (const n of d.nodes) for (const c of descendants(s.doc, n.id)) excl.add(c.id);
        const into = containerAt(rs.roots, w, excl);
        const target = into && into.type !== "group" ? into.rid : null;
        const first = s.doc.nodes[d.nodes[0]!.id];
        const curParent = first?.parent ?? null;
        const curIsGroup = curParent ? s.doc.nodes[curParent]?.type === "group" : false;
        if (first && target !== curParent && !curIsGroup && !(first.type === "frame" && !curParent && !target)) {
          gesture((dr) => reparent(dr, d.nodes.map((n) => n.id), target, s.page, rs.byId));
        }
        endGesture("Move");
        return;
      }
      case "resize":
        endGesture("Resize");
        return;
      case "rotate":
        endGesture("Rotate");
        return;
      case "point":
        normalizePath(d.id);
        endGesture("Edit path");
        return;
      case "create": {
        const n = S().doc.nodes[d.id];
        if (n && !d.moved) {
          // A click: default size centred on the click.
          const def = d.type === "frame" ? { w: 400, h: 300 } : d.type === "text" ? null : d.type === "line" || d.type === "arrow" ? { w: 120, h: 0 } : { w: 100, h: 100 };
          gesture((dr) => {
            if (def) dr.patch(d.id, { w: def.w, h: def.h, ...(d.type === "line" || d.type === "arrow" ? { points: [{ x: 0, y: 0 }, { x: 120, y: 0 }] } : {}) });
            if (d.type === "text" && n.text) dr.patch(d.id, { w: 1, h: Math.ceil(lineHeightOf(n.text)), text: { ...n.text, resize: "auto-width" } });
          });
        }
        endGesture(`Add ${d.type}`);
        select([d.id]);
        if (d.type === "text") set({ editingText: d.id });
        if (!s.toolLock) set({ tool: "select" });
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-design-ui]")) return;
    const s = S();
    if (s.tool === "pen") {
      finishPen(false);
      return;
    }
    const rs = resolved();
    const hit = hitRid(e.target);
    if (!hit) return;
    const path = pathTo(hit, rs.parentOf, rs.byId);
    const sel = s.selection[0];
    if (sel) {
      const cur = rs.byId.get(sel);
      if (cur?.type === "text" && s.canEdit) {
        set({ editingText: sel });
        return;
      }
      if (cur?.type === "path" && s.canEdit && !isVirtual(sel)) {
        set({ editingPath: sel });
        return;
      }
      const next = enterTarget(path, sel);
      if (next) {
        select([next.rid]);
        if (next.type === "text" && s.canEdit && next.rid === hit) set({ editingText: next.rid });
        return;
      }
    }
    const leaf = path[path.length - 1];
    if (leaf?.type === "text" && s.canEdit) {
      select([leaf.rid]);
      set({ editingText: leaf.rid });
    }
  };

  // ------------------------------------------------------------ dropping --
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const w = toWorld(local(e));
    const comp = e.dataTransfer.getData("application/x-design-component");
    if (comp && S().canEdit) {
      const c = S().doc.nodes[comp];
      if (c) insertInstance(comp, { x: w.x, y: w.y });
      return;
    }
    const files = [...e.dataTransfer.files];
    if (!files.length || !S().canEdit) return;
    const into = containerAt(resolved().roots, w, new Set());
    try {
      const svg = files.filter((f) => f.type === "image/svg+xml" || f.name.endsWith(".svg"));
      if (svg.length) {
        const { importSvgText } = await import("./importers");
        for (const f of svg) importSvgText(await f.text(), w);
      }
      const rest = files.filter((f) => !svg.includes(f));
      if (rest.length) await addImages(rest, w, into && into.type !== "group" ? into.rid : null);
    } catch (err) {
      window.dispatchEvent(new CustomEvent("design-error", { detail: (err as Error).message }));
    }
  };

  // --------------------------------------------------------------- render --
  const selRects = selection.map((id) => byId.get(id)).filter(Boolean) as RNode[];
  const box = unionRect(selRects.map((r) => ({ x: r.ax, y: r.ay, w: r.w, h: r.h })));
  const z = viewport.zoom;
  const toS = (x: number, y: number) => ({ x: x * z + viewport.x, y: y * z + viewport.y });
  const hoverNode = hover && !selection.includes(hover) ? byId.get(hover) : null;
  const realSel = selRects.filter((r) => !isVirtual(r.rid));
  const single = selRects.length === 1 ? selRects[0]! : null;
  const editable = canEdit && realSel.length > 0 && realSel.length === selRects.length && !realSel.some((r) => r.locked);
  const editingNode = editingText ? byId.get(editingText) : null;
  const pathNode = editingPath ? byId.get(editingPath) : null;
  const ctxValue = useMemo(() => ({ prefix: "c", interactive: true, hide: editingText }), [editingText]);
  // Only the top-level layers near the view are drawn, and the drawing is
  // memoised: panning and zooming change the transform, not the layer tree.
  const el = ref.current;
  const vw = (el?.clientWidth ?? 4000) / z;
  const vh = (el?.clientHeight ?? 3000) / z;
  const vx = -viewport.x / z - vw * 0.5;
  const vy = -viewport.y / z - vh * 0.5;
  const shown = roots.filter((n) => n.ax < vx + vw * 2 && n.ax + n.w > vx && n.ay < vy + vh * 2 && n.ay + n.h > vy);
  const shownKey = shown.map((n) => n.rid).join("|");
  const layers = useMemo(
    () => (
      <RenderProvider value={ctxValue}>
        {shown.map((n) => (
          <NodeSvg key={n.rid} n={n} />
        ))}
      </RenderProvider>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roots, ctxValue, shownKey],
  );
  const cursor = tool === "hand" ? "grab" : tool === "select" ? "default" : tool === "comment" ? "copy" : "crosshair";

  return (
    <div
      ref={ref}
      className="absolute inset-0 overflow-hidden select-none touch-none"
      style={{ background: bg, cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => broadcast({ c: null })}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        const sp = local(e);
        const hit = hitRid(e.target);
        if (hit) {
          const rs = resolved();
          const t = pickTarget(pathTo(hit, rs.parentOf, rs.byId), S().selection, e.ctrlKey || e.metaKey, rs.parentOf);
          if (t && !S().selection.includes(t.rid)) select([t.rid]);
        }
        onContextMenu({ x: e.clientX, y: e.clientY, world: toWorld(sp) });
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      {showGrid && z >= 6 && <PixelGrid />}
      <svg className="absolute inset-0 w-full h-full" style={{ overflow: "visible" }}>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${z})`}>
          {layers}
          <LayoutGrids roots={shown} />
        </g>
      </svg>

      {/* Overlays (screen space). */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: "visible" }}>
        {hoverNode && <Outline n={hoverNode} toS={toS} z={z} color="#0C8CE9" width={1.5} />}
        {selRects.map((r) => (
          <Outline key={r.rid} n={r} toS={toS} z={z} color={isVirtual(r.rid) ? "#9747FF" : "#0C8CE9"} width={1} />
        ))}
        {guides.map((g, i) =>
          g.x !== undefined ? (
            <line key={i} x1={toS(g.x, 0).x} x2={toS(g.x, 0).x} y1={toS(0, g.y0 ?? 0).y} y2={toS(0, g.y1 ?? 0).y} stroke="#F24822" strokeWidth={1} />
          ) : (
            <line key={i} y1={toS(0, g.y!).y} y2={toS(0, g.y!).y} x1={toS(g.x0 ?? 0, 0).x} x2={toS(g.x1 ?? 0, 0).x} stroke="#F24822" strokeWidth={1} />
          ),
        )}
        {insertAt && <line x1={toS(insertAt.x0, 0).x} y1={toS(0, insertAt.y0).y} x2={toS(insertAt.x1, 0).x} y2={toS(0, insertAt.y1).y} stroke="#0C8CE9" strokeWidth={3} />}
        {marquee && (
          <rect x={toS(marquee.x, 0).x} y={toS(0, marquee.y).y} width={marquee.w * z} height={marquee.h * z} fill="rgba(12,140,233,0.08)" stroke="#0C8CE9" strokeWidth={1} />
        )}
        {pen && <PenPreview pts={pen.pts} cursor={pen.cursor} toS={toS} />}
        {Object.values(peers)
          .filter((p) => p.page === page || p.cursor?.page === page)
          .flatMap((p) =>
            (p.sel ?? [])
              .map((id) => byId.get(id))
              .filter(Boolean)
              .map((r) => <Outline key={`${p.sid}-${r!.rid}`} n={r!} toS={toS} z={z} color={p.color} width={1.5} />),
          )}
      </svg>

      {/* Frame names above top-level frames. */}
      {roots
        .filter((r) => (r.type === "frame" || r.type === "component" || r.type === "instance") && r.visible !== false)
        .map((r) => {
          const p = toS(r.ax, r.ay);
          if (r.w * z < 24) return null;
          return (
            <div
              key={r.rid}
              data-frame-label={r.rid}
              className={cn("absolute text-[11px] leading-4 truncate cursor-default whitespace-nowrap", r.type === "component" || r.type === "instance" ? "text-[#9747FF]" : selection.includes(r.rid) ? "text-[#0C8CE9]" : "text-[#7a7a7a]")}
              style={{ left: p.x, top: p.y - 18, maxWidth: Math.max(24, r.w * z) }}
              title={r.name}
            >
              {r.type === "component" ? "◇ " : r.type === "instance" ? "◆ " : ""}
              {r.name}
            </div>
          );
        })}

      {box && !editingText && !editingPath && (
        <SelectionBox box={box} toS={toS} z={z} single={single} editable={editable} />
      )}
      {pathNode && <PathPoints n={pathNode} toS={toS} />}
      {editingNode?.text && <TextEditor n={editingNode} toS={toS} z={z} />}

      {/* Live cursors. */}
      {Object.values(peers)
        .filter((p) => p.cursor && p.cursor.page === page)
        .map((p) => {
          const c = toS(p.cursor!.x, p.cursor!.y);
          return (
            <div key={p.sid} className="absolute pointer-events-none" style={{ left: c.x, top: c.y, transition: "left 120ms linear, top 120ms linear" }}>
              <svg width="18" height="18" viewBox="0 0 18 18">
                <path d="M2 2 L16 8 L9 10 L7 16 Z" fill={p.color} stroke="white" strokeWidth="1.2" />
              </svg>
              <span className="absolute left-4 top-4 px-1.5 py-0.5 rounded text-[11px] text-white whitespace-nowrap" style={{ background: p.color }}>
                {p.name}
              </span>
            </div>
          );
        })}

      {showRulers && <Rulers box={box} />}
    </div>
  );

  function pickImages(at: { x: number; y: number }) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.multiple = true;
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      const into = containerAt(resolved().roots, at, new Set());
      addImages(files, at, into && into.type !== "group" ? into.rid : null).catch((err: Error) =>
        window.dispatchEvent(new CustomEvent("design-error", { detail: err.message })),
      );
    };
    input.click();
  }
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function hitRid(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.("[data-rid]");
  return el?.getAttribute("data-rid") ?? null;
}

/** Boxes to snap against: siblings and the parent (or other top-level layers). */
function othersFor(roots: RNode[], parent: RNode | null, exclude: Set<string>): Rect[] {
  const sib = parent ? parent.children : roots;
  const out = sib.filter((n) => !exclude.has(n.rid) && n.visible !== false).map((n) => ({ x: n.ax, y: n.ay, w: n.w, h: n.h }));
  if (parent) out.push({ x: parent.ax, y: parent.ay, w: parent.w, h: parent.h });
  return out;
}

/** Saves a finished pen path as a layer (points relative to its box). */
function commitPath(pts: PathPoint[], closed: boolean) {
  const xs = pts.flatMap((p) => [p.x, p.x + (p.in?.x ?? 0), p.x + (p.out?.x ?? 0)]);
  const ys = pts.flatMap((p) => [p.y, p.y + (p.in?.y ?? 0), p.y + (p.out?.y ?? 0)]);
  const x0 = Math.min(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  const w = Math.max(1, Math.max(...xs) - x0);
  const h = Math.max(1, Math.max(...ys) - y0);
  const parent = containerAt(resolved().roots, pts[0]!, new Set());
  const n = addNode("path", { x: x0, y: y0, w, h }, parent && parent.type !== "group" ? parent.rid : null, {
    points: pts.map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    closed,
    fills: closed ? [{ type: "solid", color: "#D9D9D9" }] : [],
    strokes: [{ color: "#1E1E1E", width: 2, align: "center" }],
  });
  return n;
}

/** After editing points, the box follows them again. */
function normalizePath(id: string) {
  gesture((d) => {
    const n = d.get(id);
    if (!n?.points?.length) return;
    const x0 = Math.min(...n.points.map((p) => p.x));
    const y0 = Math.min(...n.points.map((p) => p.y));
    const x1 = Math.max(...n.points.map((p) => p.x));
    const y1 = Math.max(...n.points.map((p) => p.y));
    d.patch(id, {
      x: n.x + x0,
      y: n.y + y0,
      w: Math.max(1, x1 - x0),
      h: Math.max(1, y1 - y0),
      points: n.points.map((p) => ({ ...p, x: p.x - x0, y: p.y - y0 })),
    });
  });
}

// ----------------------------------------------------------------- pieces --
type ToS = (x: number, y: number) => { x: number; y: number };

function Outline({ n, toS, z, color, width }: { n: RNode; toS: ToS; z: number; color: string; width: number }) {
  const p = toS(n.ax, n.ay);
  const t = n.rotation ? `rotate(${n.rotation} ${p.x + (n.w * z) / 2} ${p.y + (n.h * z) / 2})` : undefined;
  if (n.type === "line" || n.type === "arrow") {
    const a = n.points?.[0] ?? { x: 0, y: 0 };
    const b = n.points?.[1] ?? { x: n.w, y: n.h };
    return <line x1={p.x + a.x * z} y1={p.y + a.y * z} x2={p.x + b.x * z} y2={p.y + b.y * z} stroke={color} strokeWidth={width} transform={t} />;
  }
  return <rect x={p.x} y={p.y} width={Math.max(0, n.w * z)} height={Math.max(0, n.h * z)} fill="none" stroke={color} strokeWidth={width} transform={t} />;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

function SelectionBox({ box, toS, z, single, editable }: { box: Rect; toS: ToS; z: number; single: RNode | null; editable: boolean }) {
  const p = toS(box.x, box.y);
  const w = box.w * z;
  const h = box.h * z;
  const rot = single?.rotation ?? 0;
  const pos = (hd: string) => ({
    x: hd.includes("w") ? 0 : hd.includes("e") ? w : w / 2,
    y: hd.includes("n") ? 0 : hd.includes("s") ? h : h / 2,
  });
  const cursorFor: Record<string, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
  const small = w < 24 || h < 24;
  return (
    <>
      <div
        className="absolute pointer-events-none border border-[#0C8CE9]"
        style={{ left: p.x, top: p.y, width: w, height: h, transform: rot ? `rotate(${rot}deg)` : undefined }}
      >
        {editable &&
          HANDLES.filter((hd) => !small || hd.length === 2).map((hd) => {
            const q = pos(hd);
            return (
              <div key={hd} className="absolute" style={{ left: q.x - 8, top: q.y - 8, width: 16, height: 16, pointerEvents: "auto", cursor: cursorFor[hd] }} data-handle={hd}>
                <div className="absolute left-1 top-1 w-2 h-2 bg-white border border-[#0C8CE9]" style={{ pointerEvents: "none" }} />
              </div>
            );
          })}
        {editable && single && (
          // Rotation: just outside the top-right corner.
          <div className="absolute" style={{ left: w + 4, top: -20, width: 16, height: 16, pointerEvents: "auto", cursor: "alias" }} data-handle="rotate" title="Rotate" />
        )}
      </div>
      <div
        className="absolute pointer-events-none px-1.5 py-0.5 rounded bg-[#0C8CE9] text-white text-[10px] leading-3 whitespace-nowrap"
        style={{ left: p.x + w / 2, top: p.y + h + 6, transform: "translateX(-50%)" }}
      >
        {round(box.w)} × {round(box.h)}
        {rot ? ` · ${round(rot)}°` : ""}
      </div>
    </>
  );
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}

function PenPreview({ pts, cursor, toS }: { pts: PathPoint[]; cursor: { x: number; y: number } | null; toS: ToS }) {
  if (!pts.length) return null;
  const v = useDesign.getState().viewport;
  const d = pointsPath(cursor ? [...pts, { x: cursor.x, y: cursor.y }] : pts, false);
  return (
    <g>
      <path d={d} transform={`translate(${v.x} ${v.y}) scale(${v.zoom})`} fill="none" stroke="#0C8CE9" strokeWidth={1.5 / v.zoom} />
      {pts.map((p, i) => {
        const s = toS(p.x, p.y);
        return <rect key={i} x={s.x - 4} y={s.y - 4} width={8} height={8} fill={i === 0 ? "#0C8CE9" : "white"} stroke="#0C8CE9" />;
      })}
    </g>
  );
}

function PathPoints({ n, toS }: { n: RNode; toS: ToS }) {
  const pts = n.points ?? [];
  return (
    <svg className="absolute inset-0 w-full h-full" style={{ overflow: "visible", pointerEvents: "none" }}>
      {pts.map((p, i) => {
        const a = toS(n.ax + p.x, n.ay + p.y);
        const hin = p.in ? toS(n.ax + p.x + p.in.x, n.ay + p.y + p.in.y) : null;
        const hout = p.out ? toS(n.ax + p.x + p.out.x, n.ay + p.y + p.out.y) : null;
        return (
          <g key={i}>
            {hin && <line x1={a.x} y1={a.y} x2={hin.x} y2={hin.y} stroke="#0C8CE9" />}
            {hout && <line x1={a.x} y1={a.y} x2={hout.x} y2={hout.y} stroke="#0C8CE9" />}
            {hin && <circle cx={hin.x} cy={hin.y} r={4} fill="white" stroke="#0C8CE9" data-point={i} data-part="in" style={{ pointerEvents: "auto", cursor: "move" }} />}
            {hout && <circle cx={hout.x} cy={hout.y} r={4} fill="white" stroke="#0C8CE9" data-point={i} data-part="out" style={{ pointerEvents: "auto", cursor: "move" }} />}
            <rect x={a.x - 5} y={a.y - 5} width={10} height={10} fill="white" stroke="#0C8CE9" strokeWidth={1.5} data-point={i} data-part="anchor" style={{ pointerEvents: "auto", cursor: "move" }} />
          </g>
        );
      })}
    </svg>
  );
}

function TextEditor({ n, toS, z }: { n: RNode; toS: ToS; z: number }) {
  const t = n.text!;
  const [value, setValue] = useState(t.content);
  const virtual = isVirtual(n.rid);
  const ta = useRef<HTMLTextAreaElement>(null);
  const started = useRef(false);
  useEffect(() => {
    ta.current?.focus();
    ta.current?.select();
    if (!virtual) {
      beginGesture();
      started.current = true;
    }
    return () => {
      // Leaving the editor: commit (empty new text layers are removed).
      const cur = S().doc.nodes[n.rid];
      if (started.current) {
        if (cur && !cur.text?.content.trim()) gesture((d) => d.remove(n.rid));
        endGesture("Edit text");
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n.rid]);
  const p = toS(n.ax, n.ay);
  const { lh, top } = textLines(n);
  const fill = n.fills[0];
  const color = fill?.type === "solid" ? fill.color : "#000";
  const commitVirtual = () => {
    if (virtual && value !== t.content) patchSelection("Edit text", { text: { ...t, content: value } }, [n.rid]);
  };
  return (
    <textarea
      ref={ta}
      data-design-ui
      value={value}
      spellCheck={false}
      onChange={(e) => {
        setValue(e.target.value);
        if (!virtual) gesture((d) => d.patch(n.rid, { text: { ...d.get(n.rid)!.text!, content: e.target.value } }));
      }}
      onBlur={() => {
        commitVirtual();
        set({ editingText: null });
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          commitVirtual();
          set({ editingText: null });
        }
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute bg-transparent outline-none resize-none overflow-hidden p-0 m-0 border-0"
      style={{
        left: p.x,
        top: p.y + top * z,
        width: Math.max(40, (t.resize === "auto-width" ? n.w + 40 : n.w) * z),
        height: Math.max(lh * z, n.h * z + lh * z),
        font: cssFont({ ...t, fontSize: t.fontSize * z }),
        lineHeight: `${lh * z}px`,
        letterSpacing: t.letterSpacing ? `${t.letterSpacing * z}px` : undefined,
        textAlign: t.align === "justify" ? "left" : t.align,
        color,
        caretColor: "#0C8CE9",
        transform: n.rotation ? `rotate(${n.rotation}deg)` : undefined,
        transformOrigin: "top left",
        whiteSpace: t.resize === "auto-width" ? "pre" : "pre-wrap",
      }}
    />
  );
}

function LayoutGrids({ roots }: { roots: RNode[] }) {
  const frames: RNode[] = [];
  const visit = (ns: RNode[]) => {
    for (const n of ns) {
      if (n.grid && n.grid.visible !== false && n.grid.columns > 0) frames.push(n);
      if (n.type === "frame" || n.type === "component") visit(n.children);
    }
  };
  visit(roots);
  return (
    <g pointerEvents="none">
      {frames.map((f) => {
        const g = f.grid!;
        const inner = f.w - g.margin * 2 - g.gutter * (g.columns - 1);
        const cw = inner / g.columns;
        return Array.from({ length: g.columns }, (_, i) => (
          <rect key={`${f.rid}-${i}`} x={f.ax + g.margin + i * (cw + g.gutter)} y={f.ay} width={Math.max(0, cw)} height={f.h} fill={g.color ?? "rgba(255,0,0,0.1)"} />
        ));
      })}
    </g>
  );
}

function PixelGrid() {
  const v = useDesign((s) => s.viewport);
  const z = v.zoom;
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage: "linear-gradient(to right, rgba(0,0,0,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.08) 1px, transparent 1px)",
        backgroundSize: `${z}px ${z}px`,
        backgroundPosition: `${v.x % z}px ${v.y % z}px`,
      }}
    />
  );
}

function Rulers({ box }: { box: Rect | null }) {
  const v = useDesign((s) => s.viewport);
  const screen = useDesign((s) => s.screen);
  const step = tickStep(v.zoom);
  const ticks = (len: number, offset: number) => {
    const start = Math.floor(-offset / v.zoom / step) * step;
    const end = (len - offset) / v.zoom;
    const out: number[] = [];
    for (let t = start; t <= end && out.length < 400; t += step) out.push(t);
    return out;
  };
  const hl = box ? { x0: box.x * v.zoom + v.x, x1: (box.x + box.w) * v.zoom + v.x, y0: box.y * v.zoom + v.y, y1: (box.y + box.h) * v.zoom + v.y } : null;
  return (
    <>
      <svg data-design-ui className="absolute left-0 top-0 bg-surface border-b border-border" style={{ width: screen.w, height: RULER }}>
        {hl && <rect x={hl.x0} y={0} width={Math.max(1, hl.x1 - hl.x0)} height={RULER} fill="rgba(12,140,233,0.15)" />}
        {ticks(screen.w, v.x).map((t) => {
          const x = t * v.zoom + v.x;
          return (
            <g key={t}>
              <line x1={x} x2={x} y1={RULER - 6} y2={RULER} stroke="currentColor" className="text-subtle" />
              <text x={x + 3} y={11} fontSize={9} className="fill-current text-subtle">
                {t}
              </text>
            </g>
          );
        })}
      </svg>
      <svg data-design-ui className="absolute left-0 top-0 bg-surface border-r border-border" style={{ width: RULER, height: screen.h }}>
        {hl && <rect x={0} y={hl.y0} width={RULER} height={Math.max(1, hl.y1 - hl.y0)} fill="rgba(12,140,233,0.15)" />}
        {ticks(screen.h, v.y).map((t) => {
          const y = t * v.zoom + v.y;
          return (
            <g key={t}>
              <line y1={y} y2={y} x1={RULER - 6} x2={RULER} stroke="currentColor" className="text-subtle" />
              <text x={10} y={y + 3} fontSize={9} transform={`rotate(-90 10 ${y + 3})`} className="fill-current text-subtle">
                {t}
              </text>
            </g>
          );
        })}
      </svg>
      <div data-design-ui className="absolute left-0 top-0 bg-surface border-r border-b border-border" style={{ width: RULER, height: RULER }} />
    </>
  );
}
