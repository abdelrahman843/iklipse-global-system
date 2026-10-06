import { useEffect, useRef } from "react";
import { useWb, setViewport, animateViewport, stopViewportAnimation, viewCenter } from "@/lib/wb/store";
import { geomBounds, inflate, unionRects, type Pt, type Rect } from "@/lib/wb/geometry";
import { num, str, type WbItem } from "@/lib/wb/types";
import { createPalette, type Palette } from "@/lib/wb/paint";

// -----------------------------------------------------------------------------
// Overview map, bottom right. Draws every item as a small box plus the visible
// area; pressing or dragging on it moves the main view there.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

// Canvas size inside the 220 x 150 panel (1px border each side).
const W = 218;
const H = 148;

interface Box {
  r: Rect;
  type: WbItem["type"];
  fill: string | null;
  alpha: number;
}

/** World -> map: m = o + w * k. */
interface Mapping {
  k: number;
  ox: number;
  oy: number;
}

export function Minimap() {
  const show = useWb((s) => s.showMinimap);
  if (!show) return null;
  return <MinimapPanel />;
}

function viewRect(): Rect {
  const s = S();
  const z = s.viewport.zoom;
  return { x: -s.viewport.x / z, y: -s.viewport.y / z, w: s.screen.w / z, h: s.screen.h / z };
}

function itemBox(it: WbItem): Omit<Box, "r" | "type"> {
  const d = it.data;
  switch (it.type) {
    case "frame":
      return { fill: str(d.fill, "surface"), alpha: 1 };
    case "sticky":
      return { fill: str(d.fill, "#f5cd47"), alpha: 1 };
    case "shape": {
      const f = str(d.fill, "surface");
      return f === "none" ? { fill: str(d.stroke, "ink"), alpha: 0.5 } : { fill: f, alpha: Math.max(0.35, num(d.opacity, 1)) };
    }
    case "text":
      return { fill: str(d.color, "ink"), alpha: 0.45 };
    case "pen":
      return { fill: str(d.color, "ink"), alpha: 0.5 };
    case "card":
      return { fill: "surface", alpha: 1 };
    default:
      return { fill: null, alpha: 0.5 };
  }
}

function MinimapPanel() {
  const ref = useRef<HTMLCanvasElement>(null);
  const map = useRef<Mapping>({ k: 1, ox: 0, oy: 0 });
  const drag = useRef<{ id: number; off: Pt; sx: number; sy: number; moved: boolean } | null>(null);
  const redraw = useRef<() => void>(() => undefined);

  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    let boxes: Box[] = [];
    let content: Rect | null = null;
    let seen: Record<string, WbItem> | null = null;
    const rebuild = (items: Record<string, WbItem>) => {
      const list = Object.values(items)
        .filter((it) => it.type !== "connector")
        .sort((a, b) => (a.type === "frame" ? 0 : 1) - (b.type === "frame" ? 0 : 1) || a.z - b.z);
      boxes = list.map((it) => ({ r: geomBounds(it), type: it.type, ...itemBox(it) }));
      content = unionRects(boxes.map((b) => b.r));
    };

    const draw = () => {
      raf = 0;
      last = performance.now();
      const s = S();
      if (s.items !== seen) {
        seen = s.items;
        rebuild(s.items);
      }
      const view = viewRect();
      // The mapping holds still while dragging, so the map doesn't slide under the finger.
      if (!drag.current) {
        const all = unionRects(content ? [content, view] : [view])!;
        const region = inflate(all, Math.max(all.w, all.h) * 0.06);
        const k = Math.min(W / Math.max(region.w, 1), H / Math.max(region.h, 1));
        map.current = { k, ox: (W - region.w * k) / 2 - region.x * k, oy: (H - region.h * k) / 2 - region.y * k };
      }
      const { k, ox, oy } = map.current;
      const P: Palette = createPalette();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = P.theme("--c-bg");
      ctx.fillRect(0, 0, W, H);
      const outline = P.theme("--c-rule");
      for (const b of boxes) {
        const x = ox + b.r.x * k;
        const y = oy + b.r.y * k;
        const w = Math.max(1.5, b.r.w * k);
        const h = Math.max(1.5, b.r.h * k);
        if (x > W || y > H || x + w < 0 || y + h < 0) continue;
        const fill = b.fill ? P.token(b.fill) : P.theme("--c-subtle");
        if (fill) {
          ctx.globalAlpha = b.alpha;
          ctx.fillStyle = fill;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
        }
        if (b.type === "frame" || b.type === "card") {
          ctx.strokeStyle = outline;
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.max(1, Math.round(w) - 1), Math.max(1, Math.round(h) - 1));
        }
      }
      // Visible area.
      const vx = ox + view.x * k;
      const vy = oy + view.y * k;
      const vw = view.w * k;
      const vh = view.h * k;
      ctx.fillStyle = P.theme("--c-accent", 0.08);
      ctx.fillRect(vx, vy, vw, vh);
      ctx.strokeStyle = P.theme("--c-accent");
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx, vy, vw, vh);
    };

    // At most ~30 redraws a second, with a trailing one so the last change shows.
    let raf = 0;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (raf || timer) return;
      const wait = 33 - (performance.now() - last);
      if (wait > 0) {
        timer = setTimeout(() => {
          timer = null;
          raf = requestAnimationFrame(draw);
        }, wait);
      } else raf = requestAnimationFrame(draw);
    };
    redraw.current = schedule;
    draw();
    const unsub = useWb.subscribe((s, p) => {
      if (s.items !== p.items || s.viewport !== p.viewport || s.screen !== p.screen) schedule();
    });
    // Theme switch changes the colours.
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      unsub();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      redraw.current = () => undefined;
    };
  }, []);

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    const m = map.current;
    return { x: (e.clientX - r.left - m.ox) / m.k, y: (e.clientY - r.top - m.oy) / m.k };
  };

  const centerOn = (p: Pt, animate = false) => {
    const s = S();
    const z = s.viewport.zoom;
    const vp = { zoom: z, x: s.screen.w / 2 - p.x * z, y: s.screen.h / 2 - p.y * z };
    if (animate) animateViewport(vp, 200);
    else {
      stopViewportAnimation();
      setViewport(vp);
    }
  };

  return (
    <div
      data-wb-ui
      className="absolute z-20 right-3 bottom-[60px] max-md:bottom-[7.5rem] w-[220px] h-[150px] bg-surface border border-border rounded-lg shadow-pop overflow-hidden animate-fade-in"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <canvas
        ref={ref}
        role="img"
        aria-label="Board map. Press or drag to move the view."
        title="Press or drag to move the view"
        className="block touch-none cursor-pointer"
        style={{ width: W, height: H }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          if (S().following) set({ following: null });
          const p = toWorld(e);
          const v = viewRect();
          const inside = p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h;
          const c = viewCenter();
          // Grabbing the view box keeps the grab point; elsewhere the view jumps there.
          drag.current = { id: e.pointerId, off: inside ? { x: p.x - c.x, y: p.y - c.y } : { x: 0, y: 0 }, sx: e.clientX, sy: e.clientY, moved: false };
          if (!inside) centerOn(p, true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          // A plain click glides there; only a real drag follows the pointer.
          if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
          d.moved = true;
          const p = toWorld(e);
          centerOn({ x: p.x - d.off.x, y: p.y - d.off.y });
        }}
        onPointerUp={(e) => {
          if (drag.current?.id !== e.pointerId) return;
          drag.current = null;
          redraw.current();
        }}
        onPointerCancel={() => {
          drag.current = null;
          redraw.current();
        }}
      />
    </div>
  );
}
