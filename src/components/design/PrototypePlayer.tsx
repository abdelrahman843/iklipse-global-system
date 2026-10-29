import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ArrowLeft, Maximize, Play, RotateCcw, Scan, X } from "lucide-react";
import { RenderProvider, NodeSvg, type RenderCtx } from "@/components/design/Render";
import { cn } from "@/lib/cn";
import { childIndex, indexResolved, resolveNode, resolvePage, sortedChildren, walk, type RNode } from "@/lib/design/layout";
import { FRAME_PRESETS, type DesignDoc, type Easing, type Interaction, type Trigger } from "@/lib/design/types";

// -----------------------------------------------------------------------------
// Prototype player: plays a design page's frames with their interactions,
// like Figma's presentation view. Used inside the editor (Play) and on the
// stand-alone /wb/:boardId/play route.
//
// What it does:
//  - Shows one frame at a time (the "screen"), scaled to fit the window or at
//    100%. Frames stack in a history: navigate pushes, back pops.
//  - Overlays stack on top of the screen (center / top / bottom), with a dim
//    backdrop that closes them on click when closeOnOutside isn't false.
//    Overlays opened by hover have no backdrop and close when the pointer
//    leaves both the trigger layer and the overlay.
//  - Triggers: click (pointer up without a drag), press (pointer down),
//    hover (pointer enters the layer), delay (N ms after the frame or
//    overlay appears; any layer in it). A hit is the nearest [data-rid]
//    ancestor of the event target with an interaction for that trigger;
//    when there is none (transparent frames, gaps between glyphs), the
//    topmost layer whose box contains the point (rotation ignored).
//  - Transitions: instant, dissolve, slide-*, push-* with the configured
//    duration and easing (Web Animations API). "smart" (smart animate) is
//    played as dissolve. Back plays the arriving transition in reverse.
//  - Scrolling: a frame with overflow vertical / horizontal / both is shown
//    through a device-sized window when it's taller / wider than a device of
//    its width / height (the nearest FRAME_PRESET, scaled), and scrolls with
//    the wheel, touch, or a mouse drag. Content placed outside a frame's own
//    box is not scrollable (the frame box is the whole scroll area), and
//    there are no fixed (sticky) layers.
//  - Clicking where nothing reacts flashes the hotspots of the screen.
// -----------------------------------------------------------------------------

type Transition = Interaction["transition"];

interface Entry {
  key: number;
  id: string;
  /** How we got here (played in reverse on back). */
  t: Transition | null;
}

interface Scene {
  stack: Entry[];
  /** The screen leaving, while a transition plays. */
  prev: Entry | null;
  anim: { t: Transition; back: boolean } | null;
  seq: number;
}

interface Ov {
  key: number;
  id: string;
  position: "center" | "top" | "bottom";
  closeOnOutside: boolean;
  t: Transition;
  hover: boolean;
  closing: boolean;
}

const EASING: Record<Easing, string> = {
  linear: "linear",
  "ease-in": "cubic-bezier(0.42, 0, 1, 1)",
  "ease-out": "cubic-bezier(0, 0, 0.58, 1)",
  "ease-in-out": "cubic-bezier(0.42, 0, 0.58, 1)",
  spring: "cubic-bezier(.34, 1.56, .64, 1)",
};

const PAD = 24;
const BAR = 64;

function animates(t: Transition | null | undefined): t is Transition {
  return !!t && t.type !== "instant" && t.duration > 0;
}

function timing(t: Transition, back: boolean): KeyframeAnimationOptions {
  return {
    duration: Math.min(10_000, Math.max(0, t.duration)),
    easing: EASING[t.easing] ?? "ease-out",
    fill: "both",
    direction: back ? "reverse" : "normal",
  };
}

/** Keyframes for the newer screen (on top) and the older one, going forward. */
function keyframes(t: Transition, w: number, h: number): { newer: Keyframe[] | null; older: Keyframe[] | null } {
  const tx = (v: number) => `translate3d(${v}px, 0, 0)`;
  const ty = (v: number) => `translate3d(0, ${v}px, 0)`;
  switch (t.type) {
    case "slide-left":
      return { newer: [{ transform: tx(w) }, { transform: tx(0) }], older: null };
    case "slide-right":
      return { newer: [{ transform: tx(-w) }, { transform: tx(0) }], older: null };
    case "slide-up":
      return { newer: [{ transform: ty(h) }, { transform: ty(0) }], older: null };
    case "slide-down":
      return { newer: [{ transform: ty(-h) }, { transform: ty(0) }], older: null };
    case "push-left":
      return { newer: [{ transform: tx(w) }, { transform: tx(0) }], older: [{ transform: tx(0) }, { transform: tx(-w) }] };
    case "push-right":
      return { newer: [{ transform: tx(-w) }, { transform: tx(0) }], older: [{ transform: tx(0) }, { transform: tx(w) }] };
    case "instant":
      return { newer: null, older: null };
    // dissolve, and smart animate (not supported: dissolves).
    default:
      return { newer: [{ opacity: 0 }, { opacity: 1 }], older: null };
  }
}

/** The window a frame is seen through: the frame, or a device-sized part of it when it scrolls. */
function viewportOf(n: RNode): { w: number; h: number } {
  const ov = n.overflow ?? "none";
  let w = n.w;
  let h = n.h;
  if (ov === "vertical" || ov === "both") {
    const p = nearest((x) => Math.abs(x.w - n.w));
    h = Math.min(n.h, Math.round((p.h * n.w) / p.w));
  }
  if (ov === "horizontal" || ov === "both") {
    const p = nearest((x) => Math.abs(x.h - n.h));
    w = Math.min(n.w, Math.round((p.w * n.h) / p.h));
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

function nearest(dist: (p: (typeof FRAME_PRESETS)[number]) => number) {
  let best = FRAME_PRESETS[0]!;
  for (const p of FRAME_PRESETS) if (dist(p) < dist(best)) best = p;
  return best;
}

function has(n: RNode | undefined, trig: Trigger) {
  return !!n?.interactions?.some((i) => i.trigger === trig);
}

const HOT: Trigger[] = ["click", "press", "hover"];

/** Topmost layer with an interaction for `trig` whose box holds (px, py) (frame coordinates). */
function geoHit(n: RNode, ox: number, oy: number, px: number, py: number, trig: Trigger): RNode | null {
  if (n.visible === false) return null;
  const x = n.ax - ox;
  const y = n.ay - oy;
  const inside = px >= x && px <= x + n.w && py >= y && py <= y + n.h;
  if (n.clip && !inside) return null;
  for (let i = n.children.length - 1; i >= 0; i--) {
    const r = geoHit(n.children[i]!, ox, oy, px, py, trig);
    if (r) return r;
  }
  return inside && has(n, trig) ? n : null;
}

function safeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** Link to the stand-alone player (HashRouter). */
export function prototypeUrl(boardId: string, page: string, start?: string) {
  const q = new URLSearchParams({ page });
  if (start) q.set("start", start);
  return `${location.origin}${location.pathname}#/wb/${encodeURIComponent(boardId)}/play?${q.toString()}`;
}

// ------------------------------------------------------------------ player --
export function PrototypePlayer({
  doc,
  page,
  startId,
  onClose,
  embedded,
}: {
  doc: DesignDoc;
  page: string;
  startId?: string | null;
  onClose?: () => void;
  embedded?: boolean;
}) {
  // The page laid out once per document version; frames from other pages on demand.
  const resolvedPage = useMemo(() => {
    const idx = childIndex(doc);
    return { idx, ...indexResolved(resolvePage(doc, page, idx)) };
  }, [doc, page]);
  const extra = useMemo(() => new Map<string, RNode>(), [resolvedPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const frameNode = useCallback(
    (id: string): RNode | null => {
      const hit = resolvedPage.byId.get(id) ?? extra.get(id);
      if (hit) return hit;
      if (!doc.nodes[id]) return null;
      const r = resolveNode(doc, id, resolvedPage.idx);
      if (r) walk([r], (n) => void extra.set(n.rid, n));
      return r;
    },
    [doc, resolvedPage, extra],
  );
  const lookup = useCallback((rid: string) => resolvedPage.byId.get(rid) ?? extra.get(rid), [resolvedPage, extra]);

  const startFrame = useMemo(() => {
    if (startId && doc.nodes[startId]) return startId;
    const p = doc.data.pages.find((x) => x.id === page);
    if (p?.start && doc.nodes[p.start]) return p.start;
    return sortedChildren(doc, null, page).find((n) => n.type === "frame" || n.type === "component")?.id ?? null;
    // Only where playback starts; edits while playing don't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startId, page]);

  const keyRef = useRef(1);
  const next = () => ++keyRef.current;
  const initial = (): Scene => ({ stack: startFrame ? [{ key: next(), id: startFrame, t: null }] : [], prev: null, anim: null, seq: 0 });
  const [scene, setScene] = useState<Scene>(initial);
  const [ovs, setOvs] = useState<Ov[]>([]);
  const [fit, setFit] = useState(true);
  const [flash, setFlash] = useState(0);
  const sceneRef = useRef(scene);
  const ovsRef = useRef(ovs);
  sceneRef.current = scene;
  ovsRef.current = ovs;

  const cur = scene.stack[scene.stack.length - 1] ?? null;
  const curNode = cur ? frameNode(cur.id) : null;

  // ------------------------------------------------------------ stage size --
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vp = curNode ? viewportOf(curNode) : { w: 1, h: 1 };
  const scale = fit && stage.w > 0 ? Math.max(0.02, Math.min((stage.w - PAD * 2) / vp.w, (stage.h - PAD - BAR) / vp.h)) : 1;
  const devW = Math.round(vp.w * scale);
  const devH = Math.round(vp.h * scale);

  // ----------------------------------------------------------- navigation --
  const hoverEl = useRef<Element | null>(null);
  const hoverTriggers = useRef(new Map<number, Element>());

  const navigate = useCallback(
    (target: string, t: Transition) => {
      if (!frameNode(target)) return;
      hoverEl.current = null;
      hoverTriggers.current.clear();
      setOvs([]);
      setScene((s) => {
        const top = s.stack[s.stack.length - 1] ?? null;
        const anim = animates(t) && !!top;
        return {
          stack: [...s.stack, { key: next(), id: target, t }].slice(-200),
          prev: anim ? top : null,
          anim: anim ? { t, back: false } : null,
          seq: s.seq + 1,
        };
      });
    },
    [frameNode],
  );

  const removeOverlay = useCallback((key: number) => {
    hoverTriggers.current.delete(key);
    setOvs((o) => o.filter((x) => x.key !== key));
  }, []);

  const closeOverlay = useCallback(
    (key: number) => {
      const o = ovsRef.current.find((x) => x.key === key);
      if (!o || o.closing) return;
      if (animates(o.t)) setOvs((list) => list.map((x) => (x.key === key ? { ...x, closing: true } : x)));
      else removeOverlay(key);
    },
    [removeOverlay],
  );

  const topOverlay = () => {
    const open = ovsRef.current.filter((o) => !o.closing);
    return open[open.length - 1] ?? null;
  };

  const back = useCallback(() => {
    const top = topOverlay();
    if (top) return closeOverlay(top.key);
    setScene((s) => {
      if (s.stack.length < 2) return s;
      const popped = s.stack[s.stack.length - 1]!;
      const anim = animates(popped.t);
      return { stack: s.stack.slice(0, -1), prev: anim ? popped : null, anim: anim ? { t: popped.t!, back: true } : null, seq: s.seq + 1 };
    });
  }, [closeOverlay]);

  const restart = useCallback(() => {
    hoverEl.current = null;
    hoverTriggers.current.clear();
    setOvs([]);
    setScene((s) => ({ stack: startFrame ? [{ key: next(), id: startFrame, t: null }] : [], prev: null, anim: null, seq: s.seq + 1 }));
  }, [startFrame]);

  /** Runs one interaction. `src` is the layer element it came from. */
  const run = useCallback(
    (it: Interaction, src: Element | null) => {
      const a = it.action;
      const fromOv = src?.closest("[data-ov]");
      const ovKey = fromOv ? Number(fromOv.getAttribute("data-ov")) : null;
      switch (a.type) {
        case "navigate":
          if (a.target) navigate(a.target, it.transition);
          break;
        case "overlay": {
          if (!a.target || !frameNode(a.target)) break;
          const hover = it.trigger === "hover";
          // A hover overlay that's already open from this layer stays as it is.
          if (hover && src && [...hoverTriggers.current.values()].includes(src)) break;
          const key = next();
          if (hover && src) hoverTriggers.current.set(key, src);
          setOvs((o) => [
            ...o,
            { key, id: a.target, position: a.position ?? "center", closeOnOutside: a.closeOnOutside !== false, t: it.transition, hover, closing: false },
          ]);
          break;
        }
        case "back":
          back();
          break;
        case "close-overlay": {
          const k = ovKey ?? topOverlay()?.key;
          if (k != null) closeOverlay(k);
          break;
        }
        case "url": {
          const u = safeUrl(a.url);
          if (u) window.open(u, "_blank", "noopener,noreferrer");
          break;
        }
      }
    },
    [navigate, frameNode, back, closeOverlay],
  );
  const runRef = useRef(run);
  runRef.current = run;

  // ------------------------------------------------------------ hit tests --
  const screens = useRef(new Map<string, RNode>());

  const findHit = useCallback(
    (target: Element, clientX: number, clientY: number, trig: Trigger): { n: RNode; el: Element } | null => {
      let el: Element | null = target.closest("[data-rid]");
      while (el) {
        const n = lookup(el.getAttribute("data-rid") ?? "");
        if (has(n, trig)) return { n: n!, el };
        el = el.parentElement?.closest("[data-rid]") ?? null;
      }
      // Nothing under the pointer reacts: try layer boxes (transparent frames, text gaps).
      const svg = target.closest("svg[data-screen]") as SVGSVGElement | null;
      const frame = svg ? screens.current.get(svg.getAttribute("data-screen") ?? "") : undefined;
      const m = svg?.getScreenCTM();
      if (!svg || !frame || !m) return null;
      const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
      const n = geoHit(frame, frame.ax, frame.ay, p.x, p.y, trig);
      if (!n) return null;
      return { n, el: svg.querySelector(`[data-rid="${CSS.escape(n.rid)}"]`) ?? svg };
    },
    [lookup],
  );

  const fire = (hit: { n: RNode; el: Element }, trig: Trigger) => {
    for (const it of hit.n.interactions ?? []) if (it.trigger === trig) run(it, hit.el);
  };

  // Pointer: press on down, click on up (unless it was a drag-scroll).
  const down = useRef<{ x: number; y: number; scroll: HTMLElement | null; sl: number; st: number; moved: boolean; mouse: boolean } | null>(null);

  const onPointerDown = (e: RPointerEvent) => {
    const t = e.target as Element;
    if (t.closest("[data-ui]") || e.button !== 0) return;
    const scroll = t.closest("[data-scroll]") as HTMLElement | null;
    down.current = { x: e.clientX, y: e.clientY, scroll, sl: scroll?.scrollLeft ?? 0, st: scroll?.scrollTop ?? 0, moved: false, mouse: e.pointerType === "mouse" };
    if (t.closest("[data-backdrop]")) return;
    const hit = findHit(t, e.clientX, e.clientY, "press");
    if (hit) fire(hit, "press");
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = down.current;
    if (d && e.buttons & 1) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
      // Mouse drag scrolls (touch scrolls natively).
      if (d.moved && d.mouse && d.scroll) {
        d.scroll.scrollLeft = d.sl - dx;
        d.scroll.scrollTop = d.st - dy;
      }
    }
    if (e.pointerType !== "mouse") return;
    hoverAt(e.target as Element, e.clientX, e.clientY);
  };

  const hoverAt = (t: Element, x: number, y: number) => {
    // Hover overlays close once the pointer leaves both their trigger and themselves.
    for (const o of ovsRef.current) {
      if (!o.hover || o.closing) continue;
      const trig = hoverTriggers.current.get(o.key);
      const inOv = !!t.closest(`[data-ov="${o.key}"]`);
      if (!inOv && !(trig && trig.isConnected && trig.contains(t))) closeOverlay(o.key);
    }
    if (t.closest("[data-ui]")) return;
    const hit = findHit(t, x, y, "hover");
    if (!hit) {
      hoverEl.current = null;
      return;
    }
    if (hit.el === hoverEl.current) return;
    hoverEl.current = hit.el;
    fire(hit, "hover");
  };

  const onPointerUp = (e: RPointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || d.moved || e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest("[data-ui]")) return;
    const bd = t.closest("[data-backdrop]");
    if (bd) {
      const o = ovsRef.current.find((x) => String(x.key) === bd.getAttribute("data-backdrop"));
      if (o?.closeOnOutside) closeOverlay(o.key);
      return;
    }
    const hit = findHit(t, e.clientX, e.clientY, "click");
    if (hit) fire(hit, "click");
    else if (!findHit(t, e.clientX, e.clientY, "press")) setFlash((f) => f + 1);
  };

  const onPointerLeave = () => {
    hoverEl.current = null;
    for (const o of ovsRef.current) if (o.hover) closeOverlay(o.key);
  };

  // Hotspot hints fade out on their own.
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(0), 900);
    return () => clearTimeout(id);
  }, [flash]);

  // -------------------------------------------------------------- keyboard --
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Full screen: the editor behind doesn't get keys meant for the player.
      if (!embedded) e.stopPropagation();
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const top = topOverlay();
        if (top) closeOverlay(top.key);
        else onClose?.();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        e.stopPropagation();
        restart();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopPropagation();
        back();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [embedded, onClose, closeOverlay, restart, back]);

  // ------------------------------------------------------------ transition --
  const curLayer = useRef<HTMLDivElement>(null);
  const prevLayer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anim = scene.anim;
    const a = curLayer.current;
    const b = prevLayer.current;
    const seq = scene.seq;
    if (!anim || !scene.prev) return;
    if (!a || !b) {
      setScene((s) => (s.seq === seq ? { ...s, prev: null, anim: null } : s));
      return;
    }
    const newer = anim.back ? b : a;
    const older = anim.back ? a : b;
    const kf = keyframes(anim.t, newer.clientWidth, newer.clientHeight);
    const opts = timing(anim.t, anim.back);
    const running: Animation[] = [];
    if (kf.newer) running.push(newer.animate(kf.newer, opts));
    if (kf.older) running.push(older.animate(kf.older, opts));
    let alive = true;
    // Finished (or cancelled by something else): the old screen goes either way.
    const done = () => {
      if (!alive) return;
      setScene((s) => (s.seq === seq ? { ...s, prev: null, anim: null } : s));
      // The screen that stays ends where it naturally is; drop its fill.
      for (const x of running) if ((x.effect as KeyframeEffect | null)?.target === a) x.cancel();
    };
    void Promise.all(running.map((x) => x.finished)).then(done, done);
    return () => {
      alive = false;
      for (const x of running) x.cancel();
    };
  }, [scene.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- render --
  screens.current.clear();
  const prevNode = scene.prev ? frameNode(scene.prev.id) : null;
  const canBack = scene.stack.length > 1 || ovs.some((o) => !o.closing);

  const btn =
    "h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted";

  return (
    <div
      className={cn(
        "flex flex-col bg-[#1e1e1e] text-ink overflow-hidden select-none touch-manipulation",
        embedded ? "relative h-full w-full" : "fixed inset-0 z-[60]",
      )}
      role="dialog"
      aria-label="Prototype"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={() => (down.current = null)}
    >
      <div
        data-ui
        role="toolbar"
        aria-label="Prototype controls"
        className="absolute z-30 left-1/2 -translate-x-1/2 top-3 max-w-[calc(100%-24px)] flex items-center gap-1 p-1 bg-surface border border-border rounded-lg shadow-raise"
      >
        <button type="button" className={btn} onClick={back} disabled={!canBack} title="Back (Left arrow)" aria-label="Back">
          <ArrowLeft size={17} />
        </button>
        <div className="min-w-0 px-2 max-w-[260px] max-sm:max-w-[120px] truncate text-sm font-semibold text-ink" aria-live="polite">
          {curNode?.name ?? "Prototype"}
        </div>
        <button type="button" className={btn} onClick={restart} disabled={!startFrame} title="Restart (R)" aria-label="Restart">
          <RotateCcw size={16} />
        </button>
        <button
          type="button"
          className="h-9 px-2 shrink-0 flex items-center gap-1.5 rounded-md text-xs font-medium tabular-nums text-muted hover:bg-hover hover:text-ink transition-colors"
          onClick={() => setFit((f) => !f)}
          title={fit ? "Show at 100%" : "Fit to window"}
          aria-label={fit ? "Show at 100%" : "Fit to window"}
        >
          {fit ? <Scan size={15} /> : <Maximize size={15} />}
          {fit ? `${Math.round(scale * 100)}%` : "100%"}
        </button>
        {onClose && (
          <>
            <span className="w-px h-6 bg-line mx-0.5 shrink-0" />
            <button type="button" className={btn} onClick={onClose} title="Close (Esc)" aria-label="Close prototype">
              <X size={18} />
            </button>
          </>
        )}
      </div>

      <div ref={stageRef} className={cn("relative flex-1 min-h-0 flex", fit ? "overflow-hidden" : "overflow-auto")} style={{ paddingTop: BAR }}>
        {!startFrame || !cur ? (
          <div className="m-auto max-w-sm px-6 text-center">
            <div className="mx-auto mb-4 grid place-items-center h-12 w-12 rounded-full bg-white/5 border border-white/10 text-white/60">
              <Play size={20} />
            </div>
            <h3 className="text-lg font-semibold text-white">Nothing to play</h3>
            <p className="mt-2 text-sm text-white/60">Add a frame to this page, then play it from the Prototype tab.</p>
          </div>
        ) : !curNode ? (
          <div className="m-auto max-w-sm px-6 text-center">
            <h3 className="text-lg font-semibold text-white">This frame no longer exists</h3>
            <p className="mt-2 text-sm text-white/60">It was deleted while the prototype was playing. Press R to restart.</p>
          </div>
        ) : (
          <div className="relative m-auto shrink-0 overflow-hidden" style={{ width: devW, height: devH }}>
            {/* The older screen sits under the new one going forward, over it going back. */}
            {[scene.prev, cur].map((e) => {
              if (!e) return null;
              const isCur = e === cur;
              const n = isCur ? curNode : prevNode;
              if (!n) return null;
              return (
                <div
                  key={e.key}
                  ref={isCur ? curLayer : prevLayer}
                  className={cn("absolute inset-0 flex items-start justify-center", !isCur && "pointer-events-none")}
                  style={{ zIndex: isCur ? 1 : scene.anim?.back ? 2 : 0 }}
                  aria-hidden={!isCur || undefined}
                >
                  <Screen
                    node={n}
                    scale={scale}
                    skey={`s${e.key}`}
                    active={isCur}
                    flash={isCur && !ovs.some((o) => !o.closing) ? flash : 0}
                    run={runRef}
                    screens={screens.current}
                  />
                </div>
              );
            })}
            {ovs.map((o, i) => {
              const n = frameNode(o.id);
              if (!n) return null;
              const isTop = i === ovs.length - 1;
              return (
                <OverlayView
                  key={o.key}
                  ov={o}
                  node={n}
                  scale={scale}
                  onGone={removeOverlay}
                  flash={isTop ? flash : 0}
                  run={runRef}
                  screens={screens.current}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ screen --
type RunRef = React.MutableRefObject<(it: Interaction, src: Element | null) => void>;

/** One frame, drawn at `scale`, scrolling when its overflow says so. */
function Screen({
  node,
  scale,
  skey,
  active,
  flash,
  run,
  screens,
}: {
  node: RNode;
  scale: number;
  skey: string;
  /** Delay interactions only count down on the screen being looked at. */
  active: boolean;
  flash: number;
  run: RunRef;
  screens: Map<string, RNode>;
}) {
  screens.set(skey, node);
  const vp = viewportOf(node);
  const sx = vp.w < node.w;
  const sy = vp.h < node.h;
  const drawn = useMemo<RNode>(() => ({ ...node, x: 0, y: 0, rotation: 0 }), [node]);
  const ctx = useMemo<RenderCtx>(
    () => ({ prefix: `pp${skey}`, interactive: true, hot: (n) => n.interactions?.some((i) => HOT.includes(i.trigger)) ?? false }),
    [skey],
  );
  const svgRef = useRef<SVGSVGElement>(null);

  // Delay triggers: any layer in this frame, counted from when it appears.
  const delays = useMemo(() => {
    const out: { it: Interaction; rid: string }[] = [];
    walk([node], (n) => {
      if (n.visible === false) return false;
      for (const it of n.interactions ?? []) if (it.trigger === "delay") out.push({ it, rid: n.rid });
    });
    return out;
  }, [node]);
  const delayKey = delays.map((d) => `${d.rid}:${d.it.id}:${d.it.delay ?? 0}`).join("|");
  useEffect(() => {
    if (!active || !delays.length) return;
    const timers = delays.map((d) =>
      setTimeout(
        () => {
          const el = svgRef.current?.querySelector(`[data-rid="${CSS.escape(d.rid)}"]`) ?? svgRef.current;
          run.current(d.it, el ?? null);
        },
        Math.max(0, d.it.delay ?? 800),
      ),
    );
    return () => timers.forEach(clearTimeout);
    // Restart only when the frame's delay set changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, delayKey, skey]);

  return (
    <div
      data-scroll={sx || sy ? "" : undefined}
      className="relative shrink-0 overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ width: Math.round(vp.w * scale), height: Math.round(vp.h * scale), overflowX: sx ? "auto" : "hidden", overflowY: sy ? "auto" : "hidden" }}
    >
      <svg
        ref={svgRef}
        data-screen={skey}
        width={node.w * scale}
        height={node.h * scale}
        viewBox={`0 0 ${node.w} ${node.h}`}
        className="block"
        style={{ overflow: "hidden" }}
      >
        <RenderProvider value={ctx}>
          <NodeSvg n={drawn} />
        </RenderProvider>
        {flash > 0 && <Hotspots key={flash} node={node} />}
      </svg>
    </div>
  );
}

/** Briefly outlines every layer that reacts to the pointer. */
function Hotspots({ node }: { node: RNode }) {
  const ref = useRef<SVGGElement>(null);
  const rects = useMemo(() => {
    const out: RNode[] = [];
    walk([node], (n) => {
      if (n.visible === false) return false;
      if (n.interactions?.some((i) => HOT.includes(i.trigger))) out.push(n);
    });
    return out;
  }, [node]);
  useLayoutEffect(() => {
    const a = ref.current?.animate(
      [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }],
      { duration: 900, fill: "forwards", easing: "ease-out" },
    );
    return () => a?.cancel();
  }, []);
  return (
    <g ref={ref} pointerEvents="none" style={{ opacity: 0 }}>
      {rects.map((n) => (
        <rect
          key={n.rid}
          x={n.ax - node.ax}
          y={n.ay - node.ay}
          width={n.w}
          height={n.h}
          rx={2}
          fill="rgb(13 153 255 / 0.18)"
          stroke="#0d99ff"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

// ----------------------------------------------------------------- overlay --
function OverlayView({
  ov,
  node,
  scale,
  onGone,
  flash,
  run,
  screens,
}: {
  ov: Ov;
  node: RNode;
  scale: number;
  onGone: (key: number) => void;
  flash: number;
  run: RunRef;
  screens: Map<string, RNode>;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);

  // In with its transition; out with the same one reversed, then gone.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const back = ov.closing;
    if (!animates(ov.t)) {
      if (back) onGone(ov.key);
      return;
    }
    const box = el.parentElement ?? el;
    const kf = keyframes(ov.t, box.clientWidth, box.clientHeight);
    const opts = timing(ov.t, back);
    const running = [el.animate(kf.newer ?? [{ opacity: 0 }, { opacity: 1 }], opts)];
    if (dimRef.current) running.push(dimRef.current.animate([{ opacity: 0 }, { opacity: 1 }], { ...opts, easing: "linear" }));
    let alive = true;
    const done = () => {
      if (!alive) return;
      if (back) onGone(ov.key);
      else running.forEach((a) => a.cancel());
    };
    void Promise.all(running.map((a) => a.finished)).then(done, done);
    return () => {
      alive = false;
      if (!back) running.forEach((a) => a.cancel());
    };
  }, [ov.closing]); // eslint-disable-line react-hooks/exhaustive-deps

  const align = ov.position === "top" ? "items-start" : ov.position === "bottom" ? "items-end" : "items-center";
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 10 }}>
      {!ov.hover && <div ref={dimRef} data-backdrop={ov.key} className="absolute inset-0 bg-black/40 pointer-events-auto" />}
      <div className={cn("absolute inset-0 flex justify-center pointer-events-none", align)}>
        <div ref={bodyRef} data-ov={ov.key} className={cn("pointer-events-auto", ov.closing && "pointer-events-none")}>
          <Screen node={node} scale={scale} skey={`o${ov.key}`} active={!ov.closing} flash={flash} run={run} screens={screens} />
        </div>
      </div>
    </div>
  );
}
