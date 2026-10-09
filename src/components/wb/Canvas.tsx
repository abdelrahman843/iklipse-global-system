import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  useWb,
  commit,
  geomOf,
  select,
  setTool,
  setViewport,
  zoomAt,
  screenToWorld,
  withGroups,
  mergeItem,
  stopViewportAnimation,
  patchItem,
  boundsOf,
  selectionBounds,
  type Live,
} from "@/lib/wb/store";
import {
  CONNECTABLE,
  ROTATABLE,
  TEXT_TYPES,
  num,
  type ConnectorData,
  type ConnectorEnd,
  type Side,
  type Viewport,
  type WbItem,
} from "@/lib/wb/types";
import {
  center,
  connectorGeometry,
  distToPolyline,
  geomBounds,
  inflate,
  intersects,
  contains,
  nearestSide,
  normRect,
  pointInGeom,
  rotatePoint,
  sidePoint,
  snapBox,
  unionRects,
  type Pt,
  type Rect,
} from "@/lib/wb/geometry";
import { makeCard, makeConnector, makeDoc, makeEmoji, makeFrame, makePen, makeShape, makeSticky, makeText } from "@/lib/wb/factory";
import { cloneConnected, frameAt, itemsInside, moveConnectorFreeEnds, placeCopies, pointer, withFrameMembership } from "@/lib/wb/actions";
import { measureTextHeight } from "@/lib/wb/text";
import { broadcast } from "@/lib/wb/sync";
import { ItemRender, ItemView } from "./ItemView";
import { insertImages } from "./useWbKeys";
import { useToast } from "@/components/ui/Toast";
import { SelectionLayer } from "./SelectionLayer";

// -----------------------------------------------------------------------------
// The infinite canvas: pan / zoom, every pointer gesture (select, move, resize,
// rotate, draw, connect), and the culled, z-ordered item list.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Gesture =
  | { kind: "pan"; start: Pt; vp0: Viewport }
  | { kind: "marquee"; start: Pt; base: string[] }
  | { kind: "move"; start: Pt; downId: string; wasSelected: boolean; started: boolean; dup: boolean; ids: string[]; orig: Record<string, WbItem>; box: Rect | null; others: Rect[] }
  | { kind: "resize"; handle: Handle; orig: Record<string, WbItem>; box0: Rect; single: boolean }
  | { kind: "rotate"; c: Pt; a0: number; orig: Record<string, WbItem> }
  | { kind: "endpoint"; id: string; which: "start" | "end" }
  | { kind: "create"; start: Pt; what: "shape" | "frame" | "text" | "sticky" | "card" | "doc" | "emoji" }
  | { kind: "connect"; from: ConnectorEnd; start: Pt; source?: string; dir?: Side; moved: boolean }
  | { kind: "pen"; pts: Pt[]; highlighter: boolean }
  | { kind: "erase" }
  | { kind: "click"; start: Pt; tool: "sticky" | "comment" | "emoji" | "card" | "doc" }
  | { kind: "pinch"; d0: number; m0: Pt; vp0: Viewport };

/**
 * A sticky / card / doc / stamp drawn by dragging from `a` to `b`. Stickies and
 * stamps stay square; every kind keeps a sensible minimum size.
 */
function drawnItem(what: "sticky" | "card" | "doc" | "emoji", a: Pt, b: Pt, o: { stickyColor: string; emoji: string }): WbItem {
  if (what === "sticky" || what === "emoji") {
    const size = Math.max(what === "sticky" ? 60 : 24, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const cx = a.x + (b.x < a.x ? -size : size) / 2;
    const cy = a.y + (b.y < a.y ? -size : size) / 2;
    return what === "sticky" ? makeSticky(cx, cy, o.stickyColor, "", undefined, size) : makeEmoji(cx, cy, o.emoji, size);
  }
  const min = what === "doc" ? { w: 320, h: 300 } : { w: 160, h: 80 };
  const w = Math.max(min.w, Math.abs(b.x - a.x));
  const h = Math.max(min.h, Math.abs(b.y - a.y));
  const x = b.x < a.x ? a.x - w : a.x;
  const y = b.y < a.y ? a.y - h : a.y;
  const it = what === "doc" ? makeDoc(x, y) : makeCard(x, y);
  return { ...it, w, h };
}

const HANDLE_FIXED: Record<Handle, [number, number]> = {
  nw: [1, 1],
  n: [0.5, 1],
  ne: [0, 1],
  e: [0, 0.5],
  se: [0, 0],
  s: [0.5, 0],
  sw: [1, 0],
  w: [1, 0.5],
};

function localPoint(e: { clientX: number; clientY: number }, root: HTMLElement): Pt {
  const r = root.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Topmost connectable item under a world point. */
function connectTarget(p: Pt, skip: Set<string>): WbItem | null {
  const s = S();
  const zoom = s.viewport.zoom;
  const list = Object.values(s.items)
    .filter((it) => CONNECTABLE.includes(it.type) && !skip.has(it.id))
    .sort((a, b) => (a.type === "frame" ? 0 : 1) - (b.type === "frame" ? 0 : 1) || a.z - b.z);
  for (let i = list.length - 1; i >= 0; i--) {
    const it = list[i]!;
    const g = geomOf(s, it.id)!;
    if (it.type === "frame") {
      // Frames only catch a connector near their edge.
      if (pointInGeom(g, p, 8 / zoom) && !pointInGeom({ ...g, x: g.x + 16 / zoom, y: g.y + 16 / zoom, w: g.w - 32 / zoom, h: g.h - 32 / zoom }, p)) return it;
      continue;
    }
    if (pointInGeom(g, p, 6 / zoom)) return it;
  }
  return null;
}

/** Connector end for a world point: stuck to the item under it, else free. */
function endAt(p: Pt, skip: Set<string>): ConnectorEnd {
  const t = connectTarget(p, skip);
  if (!t) return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
  const g = geomOf(S(), t.id)!;
  const side = nearestSide(g, p);
  const sp = sidePoint(g, side);
  // Near a side's midpoint: stick to that side; elsewhere let it pick the facing side.
  const near = Math.hypot(sp.x - p.x, sp.y - p.y) < 24 / S().viewport.zoom;
  return { id: t.id, side: near ? side : "auto" };
}

export function Canvas({ children, onContextMenu }: { children?: ReactNode; onContextMenu?: (at: { x: number; y: number; world: Pt; id: string | null }) => void }) {
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, Pt>());
  const space = useRef(false);
  const [ghost, setGhost] = useState<WbItem | null>(null);
  const [panning, setPanning] = useState(false);
  const tool = useWb((s) => s.tool);
  const showGrid = useWb((s) => s.showGrid);
  const order = useVisibleOrder();

  // Viewport -> CSS transform, without re-rendering React.
  useLayoutEffect(() => {
    const apply = (vp: Viewport) => {
      const w = worldRef.current;
      const r = rootRef.current;
      if (!w || !r) return;
      w.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
      r.style.setProperty("--wb-zoom", String(vp.zoom));
      // Dot grid: 20px cells that double / halve so dots never crowd.
      let cell = 20 * vp.zoom;
      while (cell < 12) cell *= 4;
      while (cell > 80) cell /= 4;
      r.style.backgroundSize = `${cell}px ${cell}px`;
      r.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
    };
    apply(S().viewport);
    return useWb.subscribe((s, p) => {
      if (s.viewport !== p.viewport) apply(s.viewport);
    });
  }, []);

  // Screen size.
  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => set({ screen: { w: el.clientWidth, h: el.clientHeight } }));
    ro.observe(el);
    set({ screen: { w: el.clientWidth, h: el.clientHeight } });
    return () => ro.disconnect();
  }, []);

  // Wheel: mouse wheel zooms (like Miro), trackpads pan, pinch / ctrl zooms.
  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("[data-wb-scroll]")) return;
      e.preventDefault();
      stopViewportAnimation();
      set({ following: null });
      const p = localPoint(e, el);
      const vp = S().viewport;
      const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey || e.metaKey) {
        zoomAt(p, vp.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01)));
      } else if (mouseWheel && !e.shiftKey) {
        zoomAt(p, vp.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        setViewport({ ...vp, x: vp.x - dx, y: vp.y - dy });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // Safari trackpad pinch.
    const gs = (e: Event) => e.preventDefault();
    el.addEventListener("gesturestart", gs);
    el.addEventListener("gesturechange", gs);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", gs);
      el.removeEventListener("gesturechange", gs);
    };
  }, []);

  // Space held = temporary hand tool.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.("input, textarea, [contenteditable]:not([contenteditable='false'])");
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target) && !e.repeat) {
        space.current = true;
        setPanning(true);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        space.current = false;
        setPanning(false);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const world = (e: { clientX: number; clientY: number }) => screenToWorld(localPoint(e, rootRef.current!));

  // ---------------------------------------------------------------- down --
  const onPointerDown = (e: React.PointerEvent) => {
    const root = rootRef.current!;
    const target = e.target as HTMLElement;
    if (target.closest("[data-wb-ui]")) return; // pins, badges, toolbars handle themselves
    if (e.button === 2) return;
    pointers.current.set(e.pointerId, localPoint(e, root));
    stopViewportAnimation();
    if (S().following) set({ following: null });

    // Two fingers: pinch-zoom (abandons whatever one finger started).
    if (pointers.current.size === 2) {
      cancelGesture();
      const [a, b] = [...pointers.current.values()] as [Pt, Pt];
      gesture.current = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, vp0: S().viewport };
      return;
    }
    if (pointers.current.size > 2) return;

    const s = S();
    if (s.editing && !target.closest("[data-wb-editor]")) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      set({ editing: null });
    }
    root.setPointerCapture(e.pointerId);
    const p = world(e);
    const screen = localPoint(e, root);

    if (e.button === 1 || space.current || s.tool === "hand") {
      gesture.current = { kind: "pan", start: screen, vp0: s.viewport };
      setPanning(true);
      return;
    }

    const handleEl = target.closest<HTMLElement>("[data-wb-handle]");
    const hitEl = target.closest<HTMLElement>("[data-wb-id]");
    const frameEl = target.closest<HTMLElement>("[data-wb-frame]");
    const touch = e.pointerType === "touch";

    // ---- handles (resize / rotate / connector ends / quick connect)
    if (handleEl && s.canEdit) {
      const h = handleEl.dataset.wbHandle!;
      const targetId = handleEl.dataset.wbTarget;
      if (h.startsWith("qc:") && targetId) {
        const dir = h.slice(3) as Side;
        gesture.current = { kind: "connect", from: { id: targetId, side: dir }, start: p, source: targetId, dir, moved: false };
        return;
      }
      if (h === "start" || h === "end") {
        gesture.current = { kind: "endpoint", id: s.selection[0]!, which: h };
        return;
      }
      const ids = withGroups(s.selection).filter((id) => s.items[id] && !s.items[id]!.locked);
      const orig = Object.fromEntries(ids.map((id) => [id, s.items[id]!]));
      if (h === "rot") {
        const b = selectionBounds(s, ids)!;
        const c = ids.length === 1 ? center(s.items[ids[0]!]!) : center(b);
        gesture.current = { kind: "rotate", c, a0: Math.atan2(p.y - c.y, p.x - c.x), orig };
        return;
      }
      const box0 = ids.length === 1 ? { x: s.items[ids[0]!]!.x, y: s.items[ids[0]!]!.y, w: s.items[ids[0]!]!.w, h: s.items[ids[0]!]!.h } : selectionBounds(s, ids)!;
      gesture.current = { kind: "resize", handle: h as Handle, orig, box0, single: ids.length === 1 };
      return;
    }

    switch (s.tool) {
      case "select": {
        let id = hitEl?.dataset.wbId ?? null;
        // A press inside the current selection box grabs the selection.
        if (!id && s.selection.length) {
          const inside = s.selection.find((sid) => {
            const g = geomOf(s, sid);
            return g && s.items[sid]?.type !== "frame" && pointInGeom(g, p, 4 / s.viewport.zoom);
          });
          if (inside) id = inside;
        }
        if (id && s.items[id]) {
          const wasSelected = s.selection.includes(id);
          if (e.shiftKey) {
            const g = withGroups([id]);
            select(wasSelected ? s.selection.filter((x) => !g.includes(x)) : [...s.selection, ...g]);
            return;
          }
          if (!wasSelected) select([id]);
          gesture.current = { kind: "move", start: p, downId: id, wasSelected, started: false, dup: e.altKey, ids: [], orig: {}, box: null, others: [] };
          return;
        }
        if (touch) {
          gesture.current = { kind: "pan", start: screen, vp0: s.viewport };
          setPanning(true);
          if (!frameEl) set({ selection: [] });
          return;
        }
        gesture.current = { kind: "marquee", start: p, base: e.shiftKey ? s.selection : [] };
        if (!e.shiftKey) set({ selection: [] });
        return;
      }
      case "comment":
        gesture.current = { kind: "click", start: screen, tool: s.tool };
        return;
      // Click drops one at the default size; drag draws it at the size you want (Miro).
      case "sticky":
      case "emoji":
      case "card":
      case "doc":
        if (!s.canEdit) return;
        gesture.current = { kind: "create", start: p, what: s.tool };
        return;
      case "shape":
      case "frame":
      case "text":
        if (!s.canEdit) return;
        gesture.current = { kind: "create", start: p, what: s.tool };
        return;
      case "connector":
        if (!s.canEdit) return;
        gesture.current = { kind: "connect", from: endAt(p, new Set()), start: p, moved: false };
        return;
      case "pen":
      case "highlighter":
        if (!s.canEdit) return;
        gesture.current = { kind: "pen", pts: [p], highlighter: s.tool === "highlighter" };
        return;
      case "eraser":
        if (!s.canEdit) return;
        gesture.current = { kind: "erase" };
        eraseAt(p);
        return;
    }
  };

  // ---------------------------------------------------------------- move --
  const onPointerMove = (e: React.PointerEvent) => {
    const root = rootRef.current!;
    const screen = localPoint(e, root);
    pointer.screen = screen;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, screen);
    const p = screenToWorld(screen);
    broadcast({ c: { x: Math.round(p.x), y: Math.round(p.y) } });
    const g = gesture.current;
    const s = S();
    if (!g) {
      // Hover (quick-connect dots follow the hovered item).
      if (s.tool === "select" && e.pointerType === "mouse") {
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-wb-id]")?.dataset.wbId ?? null;
        const keep = (e.target as HTMLElement).closest("[data-wb-handle]") ? s.hover : id;
        if (keep !== s.hover) set({ hover: keep });
      }
      return;
    }
    switch (g.kind) {
      case "pinch": {
        const pts = [...pointers.current.values()];
        if (pts.length < 2) return;
        const [a, b] = pts as [Pt, Pt];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const zoom = Math.min(8, Math.max(0.02, (g.vp0.zoom * d) / Math.max(g.d0, 1)));
        const wpt = screenToWorld(g.m0, g.vp0);
        setViewport({ zoom, x: m.x - wpt.x * zoom, y: m.y - wpt.y * zoom });
        return;
      }
      case "pan":
        setViewport({ ...g.vp0, x: g.vp0.x + screen.x - g.start.x, y: g.vp0.y + screen.y - g.start.y });
        return;
      case "marquee": {
        const r = normRect(g.start, p);
        const hits = Object.values(s.items)
          .filter((it) => {
            const b = boundsOf(s, it.id);
            if (!b || (!r.w && !r.h)) return false;
            // Frames and lines only when fully inside, like Miro.
            return it.type === "frame" || it.type === "connector" ? contains(r, b) : intersects(r, b);
          })
          .map((it) => it.id);
        set({ marquee: r, selection: withGroups([...new Set([...g.base, ...hits])]) });
        return;
      }
      case "move": {
        if (!s.canEdit) return;
        const dx0 = p.x - g.start.x;
        const dy0 = p.y - g.start.y;
        if (!g.started) {
          if (Math.hypot(dx0, dy0) * s.viewport.zoom < 4) return;
          startMove(g);
          if (!g.ids.length) {
            gesture.current = null;
            return;
          }
        }
        let dx = dx0;
        let dy = dy0;
        let guides: ReturnType<typeof snapBox>["guides"] = [];
        if (g.box && !e.ctrlKey && !e.metaKey) {
          const snap = snapBox({ ...g.box, x: g.box.x + dx, y: g.box.y + dy }, g.others, 6 / s.viewport.zoom);
          dx += snap.dx;
          dy += snap.dy;
          guides = snap.guides;
        }
        const live: Record<string, Live> = {};
        for (const id of g.ids) {
          const o = g.orig[id]!;
          if (o.type === "connector") {
            const moved = moveConnectorFreeEnds(o, dx, dy);
            live[id] = { data: { start: moved.data.start, end: moved.data.end } };
          } else live[id] = { x: o.x + dx, y: o.y + dy };
        }
        set({ live, guides });
        return;
      }
      case "resize":
        doResize(g, p, e.shiftKey);
        return;
      case "rotate": {
        const a = Math.atan2(p.y - g.c.y, p.x - g.c.x);
        let deg = ((a - g.a0) * 180) / Math.PI;
        const live: Record<string, Live> = {};
        const ids = Object.keys(g.orig);
        for (const id of ids) {
          const o = g.orig[id]!;
          if (!ROTATABLE.includes(o.type) && ids.length === 1) continue;
          let r = o.rotation + deg;
          if (ids.length === 1) {
            if (e.shiftKey) r = Math.round(r / 15) * 15;
            else for (const snap of [0, 90, 180, 270, 360, -90, -180, -270]) if (Math.abs(r - snap) < 3) r = snap;
            deg = r - o.rotation;
          }
          r = ((((r + 180) % 360) + 360) % 360) - 180;
          if (ids.length === 1) {
            live[id] = { rotation: Math.round(r * 10) / 10 };
          } else {
            const c = rotatePoint(center(o), g.c, deg);
            live[id] = ROTATABLE.includes(o.type) ? { x: c.x - o.w / 2, y: c.y - o.h / 2, rotation: Math.round(r * 10) / 10 } : { x: c.x - o.w / 2, y: c.y - o.h / 2 };
          }
        }
        set({ live });
        return;
      }
      case "endpoint": {
        const it = s.items[g.id];
        if (!it) return;
        const d = it.data as ConnectorData;
        const other = g.which === "start" ? d.end : d.start;
        const skip = new Set([g.id]);
        if (other?.id) skip.add(other.id);
        const end = endAt(p, skip);
        set({ live: { [g.id]: { data: { [g.which]: end } } }, hover: end.id ?? null });
        return;
      }
      case "connect": {
        if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) * s.viewport.zoom < 6) return;
        g.moved = true;
        const skip = new Set<string>(g.source ? [g.source] : g.from.id ? [g.from.id] : []);
        const to = endAt(p, skip);
        const c = makeConnector(g.from, to, s.toolOpts.connectorKind, s.toolOpts.endCap);
        setGhost(c);
        set({ hover: to.id ?? null });
        return;
      }
      case "create": {
        const r = normRect(g.start, p);
        if (e.shiftKey) r.w = r.h = Math.max(r.w, r.h);
        if (r.w * s.viewport.zoom < 4 && r.h * s.viewport.zoom < 4) return;
        if (g.what === "shape") setGhost(makeShape(s.toolOpts.shape, r.x, r.y, r.w, r.h));
        else if (g.what === "frame") setGhost(makeFrame(r.x, r.y, r.w, r.h));
        else if (g.what === "text") setGhost(makeText(r.x, r.y, ""));
        else setGhost(drawnItem(g.what, g.start, p, s.toolOpts));
        return;
      }
      case "pen": {
        const last = g.pts[g.pts.length - 1]!;
        if (Math.hypot(p.x - last.x, p.y - last.y) * s.viewport.zoom < 1.5) return;
        g.pts.push(p);
        const b = unionRects([{ ...g.pts[0]!, w: 0, h: 0 }, ...g.pts.map((q) => ({ x: q.x, y: q.y, w: 0, h: 0 }))])!;
        const rel = g.pts.flatMap((q) => [q.x - b.x, q.y - b.y]);
        const color = g.highlighter ? s.toolOpts.highlighterColor : s.toolOpts.penColor;
        const width = g.highlighter ? 16 : s.toolOpts.penWidth;
        setGhost(makePen(rel, b.x, b.y, b.w, b.h, color, width, g.highlighter));
        return;
      }
      case "erase":
        eraseAt(p);
        return;
      case "click":
        return;
    }
  };

  // ------------------------------------------------------------------ up --
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pinch") {
      if (pointers.current.size < 2) gesture.current = null;
      return;
    }
    gesture.current = null;
    setPanning(false);
    const root = rootRef.current!;
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    const s = S();
    const p = world(e);
    switch (g.kind) {
      case "marquee":
        set({ marquee: null });
        return;
      case "move": {
        if (!g.started) {
          // Click on an already-selected text item edits it (Miro).
          const it = s.items[g.downId];
          if (g.wasSelected && it && s.selection.length === 1 && TEXT_TYPES.includes(it.type) && !it.locked && s.canEdit && e.pointerType === "mouse") {
            set({ editing: { id: it.id, field: "text" } });
          } else if (g.wasSelected && s.selection.length > 1 && !e.shiftKey) select([g.downId]);
          return;
        }
        const changes: Record<string, WbItem> = {};
        for (const id of g.ids) {
          const l = s.live[id];
          const o = s.items[id];
          if (!l || !o) continue;
          changes[id] = mergeItem(o, { x: l.x ?? o.x, y: l.y ?? o.y, data: l.data });
        }
        set({ live: {}, guides: [] });
        commit(withFrameMembership(changes));
        return;
      }
      case "resize":
      case "rotate": {
        const changes: Record<string, WbItem> = {};
        for (const [id, l] of Object.entries(s.live)) {
          const o = s.items[id];
          if (!o) continue;
          const { data, ...geo } = l;
          changes[id] = mergeItem(o, { ...geo, data });
        }
        set({ live: {} });
        commit(withFrameMembership(changes));
        return;
      }
      case "endpoint": {
        const l = s.live[g.id];
        set({ live: {}, hover: null });
        if (l?.data) patchItem(g.id, { data: l.data });
        return;
      }
      case "connect": {
        setGhost(null);
        set({ hover: null });
        if (!g.moved) {
          if (g.source && g.dir) cloneConnected(g.source, g.dir);
          return;
        }
        const skip = new Set<string>(g.source ? [g.source] : g.from.id ? [g.from.id] : []);
        const to = endAt(p, skip);
        if (g.source && !to.id) {
          // Dropped on empty canvas from a "+" handle: copy the item there.
          cloneConnected(g.source, g.dir ?? "right", p);
          return;
        }
        const c = makeConnector(g.from, to, s.toolOpts.connectorKind, s.toolOpts.endCap);
        commit({ [c.id]: c }, { select: [c.id] });
        if (s.tool === "connector") setTool("select");
        return;
      }
      case "create": {
        setGhost(null);
        let r = normRect(g.start, p);
        if (e.shiftKey) r.w = r.h = Math.max(r.w, r.h);
        const click = r.w * s.viewport.zoom < 4 && r.h * s.viewport.zoom < 4;
        let it: WbItem;
        if (g.what === "sticky" || g.what === "card" || g.what === "doc" || g.what === "emoji") {
          const q = g.start;
          it = click
            ? g.what === "sticky"
              ? makeSticky(q.x, q.y, s.toolOpts.stickyColor)
              : g.what === "emoji"
                ? makeEmoji(q.x, q.y, s.toolOpts.emoji)
                : g.what === "doc"
                  ? makeDoc(q.x - 320, q.y - 120)
                  : makeCard(q.x - 160, q.y - 70)
            : drawnItem(g.what, q, p, s.toolOpts);
          it.frame_id = frameAt(center(it));
          commit({ [it.id]: it }, { select: [it.id] });
          if (g.what === "emoji") return; // stamps keep stamping
          setTool("select");
          if (g.what === "doc") set({ openDoc: it.id });
          else set({ editing: { id: it.id, field: "text" } });
          return;
        }
        if (g.what === "shape") {
          if (click) r = { x: g.start.x - 80, y: g.start.y - 80, w: 160, h: 160 };
          it = makeShape(s.toolOpts.shape, r.x, r.y, Math.max(r.w, 8), Math.max(r.h, 8));
        } else if (g.what === "frame") {
          if (click) r = { x: g.start.x - s.toolOpts.frame.w / 2, y: g.start.y - s.toolOpts.frame.h / 2, ...s.toolOpts.frame };
          it = makeFrame(r.x, r.y, Math.max(r.w, 40), Math.max(r.h, 40));
        } else {
          it = makeText(g.start.x, g.start.y - 13, "");
          if (!click) it = { ...it, w: Math.max(r.w, 40), data: { ...it.data, autoWidth: false } };
        }
        const changes: Record<string, WbItem> = { [it.id]: it };
        if (it.type === "frame") for (const id of itemsInside(it)) changes[id] = { ...s.items[id]!, frame_id: it.id };
        else it.frame_id = frameAt(center(it));
        commit(changes, { select: [it.id] });
        setTool("select");
        if (it.type === "text") set({ editing: { id: it.id, field: "text" } });
        return;
      }
      case "pen": {
        setGhost(null);
        if (g.pts.length < 2) g.pts.push({ x: g.pts[0]!.x + 0.5, y: g.pts[0]!.y + 0.5 });
        const b = unionRects(g.pts.map((q) => ({ x: q.x, y: q.y, w: 0, h: 0 })))!;
        const rel = g.pts.flatMap((q) => [Math.round((q.x - b.x) * 10) / 10, Math.round((q.y - b.y) * 10) / 10]);
        const color = g.highlighter ? s.toolOpts.highlighterColor : s.toolOpts.penColor;
        const width = g.highlighter ? 16 : s.toolOpts.penWidth;
        const it = makePen(rel, b.x, b.y, b.w, b.h, color, width, g.highlighter);
        it.frame_id = frameAt(center(it));
        commit({ [it.id]: it });
        return;
      }
      case "click": {
        const screen = localPoint(e, root);
        if (Math.hypot(screen.x - g.start.x, screen.y - g.start.y) > 6) return;
        if (g.tool === "comment") {
          if (!s.canComment) return;
          const hitId = (e.target as HTMLElement).closest<HTMLElement>("[data-wb-id]")?.dataset.wbId ?? null;
          const host = hitId ? s.items[hitId] : null;
          set({
            draftComment: host ? { x: p.x - host.x, y: p.y - host.y, item_id: host.id } : { x: p.x, y: p.y, item_id: null },
            openThread: null,
          });
          return;
        }
        if (!s.canEdit) return;
        let it: WbItem;
        if (g.tool === "sticky") it = makeSticky(p.x, p.y, s.toolOpts.stickyColor);
        else if (g.tool === "emoji") it = makeEmoji(p.x, p.y, s.toolOpts.emoji);
        else if (g.tool === "doc") it = makeDoc(p.x - 320, p.y - 120);
        else it = makeCard(p.x - 160, p.y - 70);
        it.frame_id = frameAt(p);
        commit({ [it.id]: it }, { select: [it.id] });
        if (g.tool === "doc") {
          // A new doc opens straight away, ready to type.
          setTool("select");
          set({ openDoc: it.id });
          return;
        }
        if (g.tool !== "emoji") {
          setTool("select");
          set({ editing: { id: it.id, field: "text" } });
        }
        return;
      }
      default:
        return;
    }
  };

  const cancelGesture = () => {
    const g = gesture.current;
    gesture.current = null;
    setGhost(null);
    setPanning(false);
    if (g) set({ live: {}, guides: [], marquee: null });
  };

  // Esc while dragging puts things back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gesture.current) {
        e.stopPropagation();
        cancelGesture();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  function startMove(g: Extract<Gesture, { kind: "move" }>) {
    const s = S();
    let ids = withGroups(s.selection).filter((id) => s.items[id] && !s.items[id]!.locked);
    if (g.dup && ids.length) {
      const copies = placeCopies(
        ids.map((id) => s.items[id]!),
        center(selectionBounds(s, ids)!),
        true,
      );
      ids = copies;
    }
    const st = S();
    const all = new Set(ids);
    for (const id of ids) if (st.items[id]?.type === "frame") for (const it of Object.values(st.items)) if (it.frame_id === id && !it.locked) all.add(it.id);
    // Connectors move only their free ends (stuck ends follow their items).
    g.ids = [...all];
    g.orig = Object.fromEntries(g.ids.map((id) => [id, st.items[id]!]));
    const boxes = g.ids.filter((id) => st.items[id]!.type !== "connector").map((id) => geomBounds(st.items[id]!));
    g.box = unionRects(boxes);
    const vp = st.viewport;
    const view = inflate({ x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: st.screen.w / vp.zoom, h: st.screen.h / vp.zoom }, 200 / vp.zoom);
    g.others = Object.values(st.items)
      .filter((it) => !all.has(it.id) && it.type !== "connector" && it.type !== "pen")
      .map((it) => geomBounds(it))
      .filter((b) => intersects(b, view))
      .slice(0, 400);
    g.started = true;
  }

  function doResize(g: Extract<Gesture, { kind: "resize" }>, p: Pt, shift: boolean) {
    const s = S();
    const [fx, fy] = HANDLE_FIXED[g.handle];
    const corner = g.handle.length === 2;
    const live: Record<string, Live> = {};
    if (g.single) {
      const o = Object.values(g.orig)[0]!;
      const c0 = center(o);
      // Work in the item's own (unrotated) frame.
      const q = rotatePoint(p, c0, -o.rotation);
      const ax = o.x + fx * o.w;
      const ay = o.y + fy * o.h;
      let w = g.handle === "n" || g.handle === "s" ? o.w : Math.abs(q.x - ax);
      let h = g.handle === "e" || g.handle === "w" ? o.h : Math.abs(q.y - ay);
      const ratio = o.w / Math.max(o.h, 0.01);
      const keep = shift || (corner && ["sticky", "image", "emoji", "text"].includes(o.type)) || o.type === "sticky" || o.type === "emoji";
      if (keep) {
        if (g.handle === "n" || g.handle === "s") w = h * ratio;
        else if (g.handle === "e" || g.handle === "w") h = w / ratio;
        else if (w / ratio > h) h = w / ratio;
        else w = h * ratio;
      }
      w = Math.max(w, 8);
      h = Math.max(h, 8);
      // Which way the box grows from the fixed point.
      const sx = g.handle.includes("w") ? -1 : 1;
      const sy = g.handle.includes("n") ? -1 : 1;
      const nx = fx === 0.5 ? o.x + (o.w - w) / 2 : sx > 0 ? ax : ax - w;
      const ny = fy === 0.5 ? o.y + (o.h - h) / 2 : sy > 0 ? ay : ay - h;
      // Keep the fixed corner still in world space after rotation.
      const anchorWorld = rotatePoint({ x: ax, y: ay }, c0, o.rotation);
      const nc = { x: nx + w / 2, y: ny + h / 2 };
      const anchorLocalNew = { x: nx + fx * w, y: ny + fy * h };
      const anchorWorldNew = rotatePoint(anchorLocalNew, nc, o.rotation);
      const x = nx + (anchorWorld.x - anchorWorldNew.x);
      const y = ny + (anchorWorld.y - anchorWorldNew.y);
      const l: Live = { x, y, w, h };
      if (o.type === "text") {
        const size = num(o.data.fontSize, 20);
        if (corner) l.data = { fontSize: Math.max(4, Math.round(size * (w / o.w) * 10) / 10), autoWidth: o.data.autoWidth };
        else {
          const th = Math.ceil(measureTextHeight(String(o.data.text ?? ""), w, size));
          l.h = Math.max(th, size * 1.3);
          l.data = { autoWidth: false };
        }
      }
      live[o.id] = l;
    } else {
      const b = g.box0;
      const ax = b.x + fx * b.w;
      const ay = b.y + fy * b.h;
      let w = g.handle === "n" || g.handle === "s" ? b.w : Math.abs(p.x - ax);
      let h = g.handle === "e" || g.handle === "w" ? b.h : Math.abs(p.y - ay);
      const keep = corner || shift;
      if (keep) {
        const k = Math.max(w / b.w, h / b.h);
        w = b.w * k;
        h = b.h * k;
      }
      w = Math.max(w, 8);
      h = Math.max(h, 8);
      const kx = w / b.w;
      const ky = h / b.h;
      const nx = fx === 0.5 ? b.x + (b.w - w) / 2 : g.handle.includes("w") ? ax - w : ax;
      const ny = fy === 0.5 ? b.y + (b.h - h) / 2 : g.handle.includes("n") ? ay - h : ay;
      for (const o of Object.values(g.orig)) {
        if (o.type === "connector") {
          const d = o.data as ConnectorData;
          const sc = (e2?: ConnectorEnd) => (e2 && !e2.id ? { ...e2, x: nx + ((e2.x ?? 0) - b.x) * kx, y: ny + ((e2.y ?? 0) - b.y) * ky } : e2);
          live[o.id] = { data: { start: sc(d.start), end: sc(d.end) } };
          continue;
        }
        let ow = o.w * kx;
        let oh = o.h * ky;
        if (o.type === "sticky" || o.type === "emoji") ow = oh = Math.min(ow, oh);
        const cx = nx + (o.x + o.w / 2 - b.x) * kx;
        const cy = ny + (o.y + o.h / 2 - b.y) * ky;
        const l: Live = { x: cx - ow / 2, y: cy - oh / 2, w: ow, h: oh };
        if (o.type === "text") l.data = { fontSize: Math.max(4, Math.round(num(o.data.fontSize, 20) * Math.min(kx, ky) * 10) / 10) };
        live[o.id] = l;
      }
    }
    set({ live });
    void s;
  }

  function eraseAt(p: Pt) {
    const s = S();
    const r = 8 / s.viewport.zoom;
    const hit: Record<string, null> = {};
    for (const it of Object.values(s.items)) {
      if (it.type !== "pen" || it.locked) continue;
      const g = geomOf(s, it.id)!;
      if (!pointInGeom(g, p, r + num(it.data.width, 3))) continue;
      const pts = (it.data.points as number[]) ?? [];
      const kx = g.w / Math.max(1, num(it.data.bw, g.w));
      const ky = g.h / Math.max(1, num(it.data.bh, g.h));
      const poly: Pt[] = [];
      for (let i = 0; i < pts.length; i += 2) poly.push({ x: g.x + pts[i]! * kx, y: g.y + pts[i + 1]! * ky });
      if (distToPolyline(p, poly.length > 1 ? poly : [poly[0]!, poly[0]!]) <= r + num(it.data.width, 3) / 2) hit[it.id] = null;
    }
    if (Object.keys(hit).length) commit(hit, { key: "erase" });
  }

  const cursor =
    panning || tool === "hand"
      ? gesture.current?.kind === "pan"
        ? "grabbing"
        : "grab"
      : tool === "select"
        ? "default"
        : tool === "text"
          ? "text"
          : "crosshair";

  return (
    <div
      ref={rootRef}
      data-wb-canvas
      className={cn("absolute inset-0 overflow-hidden touch-none select-none bg-bg outline-none", showGrid && "wb-grid")}
      style={{ cursor }}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // Images and videos dragged in from the computer land where they're dropped.
      onDragOver={(e) => {
        if (S().canEdit && e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = [...e.dataTransfer.files];
        if (!files.length || !S().canEdit) return;
        e.preventDefault();
        const at = screenToWorld(localPoint(e, rootRef.current!));
        void insertImages(files, at, (msg) => toast.push({ kind: "error", title: "Couldn't add that", description: msg }));
      }}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        cancelGesture();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse" && !gesture.current) {
          pointer.screen = null;
          broadcast({ c: null });
          if (S().hover) set({ hover: null });
        }
      }}
      onDoubleClick={(e) => {
        const s = S();
        if (s.tool !== "select" && s.tool !== "hand") return;
        // The canvas holds pointer capture, so the event's target is the canvas itself: hit-test the point.
        const el = (document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element)).closest<HTMLElement>("[data-wb-id]");
        const id = el?.dataset.wbId;
        const it = id ? s.items[id] : null;
        // Docs open for everyone who can see the board (read-only for viewers).
        if (it?.type === "doc") {
          set({ openDoc: it.id, selection: [it.id] });
          return;
        }
        if (!s.canEdit || s.tool !== "select") return;
        if (!it || it.locked) return;
        if (it.type === "frame") set({ editing: { id: it.id, field: "title" }, selection: [it.id] });
        else if (it.type === "connector") set({ editing: { id: it.id, field: "label" }, selection: [it.id] });
        else if (TEXT_TYPES.includes(it.type)) set({ editing: { id: it.id, field: "text" }, selection: [it.id] });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if ((e.target as HTMLElement).closest("[data-wb-ui]")) return;
        const s = S();
        const id = (e.target as HTMLElement).closest<HTMLElement>("[data-wb-id]")?.dataset.wbId ?? null;
        if (id && !s.selection.includes(id)) select([id]);
        const sp = localPoint(e, rootRef.current!);
        onContextMenu?.({ x: e.clientX, y: e.clientY, world: screenToWorld(sp), id });
      }}
    >
      <div ref={worldRef} className="absolute left-0 top-0 origin-top-left" style={{ width: 0, height: 0 }}>
        {order.map((id) => (
          <ItemView key={id} id={id} />
        ))}
        {ghost && <ItemRender it={ghost} ghost />}
      </div>
      <SelectionLayer />
      {children}
    </div>
  );
}

// -------------------------------------------------------------- culling --
/** Ids to render, in paint order (frames first), limited to what's near the screen. */
function useVisibleOrder(): string[] {
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    let raf = 0;
    let last: string[] = [];
    // The area rendered last time (a screen of margin on every side). Panning
    // inside it changes nothing, so React only re-renders when the view moves
    // well past what is already on the page, or the zoom changes a lot.
    let covered: Rect | null = null;
    let coveredZoom = 0;
    const compute = () => {
      raf = 0;
      const s = S();
      const vp = s.viewport;
      const w = s.screen.w / vp.zoom;
      const h = s.screen.h / vp.zoom;
      covered = { x: -vp.x / vp.zoom - w, y: -vp.y / vp.zoom - h, w: w * 3, h: h * 3 };
      coveredZoom = vp.zoom;
      const keep = new Set([...s.selection, ...Object.keys(s.live), ...Object.keys(s.remoteLive)]);
      if (s.editing) keep.add(s.editing.id);
      const view = covered;
      const list = Object.values(s.items)
        .filter((it) => keep.has(it.id) || it.type === "connector" || intersects(geomBounds(it), view))
        .sort((a, b) => (a.type === "frame" ? 0 : 1) - (b.type === "frame" ? 0 : 1) || a.z - b.z || (a.id < b.id ? -1 : 1))
        .map((it) => it.id);
      if (list.length !== last.length || list.some((id, i) => id !== last[i])) {
        last = list;
        setOrder(list);
      }
    };
    compute();
    const unsub = useWb.subscribe((s, p) => {
      let need = s.items !== p.items || s.screen !== p.screen || s.selection !== p.selection || s.live !== p.live || s.remoteLive !== p.remoteLive;
      if (!need && s.viewport !== p.viewport && covered) {
        const vp = s.viewport;
        const inner = { x: -vp.x / vp.zoom, y: -vp.y / vp.zoom, w: s.screen.w / vp.zoom, h: s.screen.h / vp.zoom };
        const zoomJump = vp.zoom / coveredZoom;
        need = !contains(covered, inflate(inner, Math.min(inner.w, inner.h) * 0.25)) || zoomJump > 1.6 || zoomJump < 0.6;
      }
      if (need && !raf) raf = requestAnimationFrame(compute);
    });
    return () => {
      unsub();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return order;
}

export { connectorGeometry };
