import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { cachedImageUrl, imageUrl } from "@/lib/wb/api";
import type { RNode } from "@/lib/design/layout";
import { cssFont, lineHeightOf } from "@/lib/design/text";
import type { Effect, Paint, PathPoint } from "@/lib/design/types";

// -----------------------------------------------------------------------------
// Draws the resolved tree as SVG. The canvas, the exporters (static markup)
// and the prototype player all use this, so they always match.
// -----------------------------------------------------------------------------

export interface RenderCtx {
  /** Image source (storage path or data URL) to a URL the browser can load. */
  img?: (src: string) => string | null;
  /** Unique prefix for <defs> ids. */
  prefix: string;
  /** Canvas: tag layers so pointer events find them. */
  interactive?: boolean;
  /** Hide one layer (text being edited). */
  hide?: string | null;
  /** Prototype: layers with interactions get a pointer cursor. */
  hot?: (n: RNode) => boolean;
}

const Ctx = createContext<RenderCtx>({ prefix: "d" });

export function RenderProvider({ value, children }: { value: RenderCtx; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One layer and everything in it, at its own position inside the parent. */
export function NodeSvg({ n }: { n: RNode }) {
  const ctx = useContext(Ctx);
  if (n.visible === false || ctx.hide === n.rid) return null;
  const t = `translate(${r(n.x)} ${r(n.y)})${n.rotation ? ` rotate(${r(n.rotation)} ${r(n.w / 2)} ${r(n.h / 2)})` : ""}`;
  const fx = effectsFilter(n, ctx.prefix);
  const tag = ctx.interactive ? { "data-rid": n.rid } : {};
  const hot = ctx.hot?.(n);
  return (
    <g
      transform={t}
      opacity={n.opacity < 1 ? n.opacity : undefined}
      style={{ mixBlendMode: (n.blend as React.CSSProperties["mixBlendMode"]) || undefined, cursor: hot ? "pointer" : undefined }}
      {...tag}
    >
      {fx.defs}
      <g filter={fx.id ? `url(#${fx.id})` : undefined}>
        <Body n={n} />
      </g>
    </g>
  );
}

function Body({ n }: { n: RNode }) {
  const ctx = useContext(Ctx);
  const id = safeId(ctx.prefix, n.rid);
  switch (n.type) {
    case "group":
      return (
        <>
          {n.children.map((c) => (
            <NodeSvg key={c.rid} n={c} />
          ))}
        </>
      );
    case "frame":
    case "component":
    case "instance": {
      const d = rectPath(n.w, n.h, n.radius);
      return (
        <>
          <Fills d={d} n={n} id={id} />
          {n.clip ? (
            <>
              <defs>
                <clipPath id={`${id}-clip`}>
                  <path d={d} />
                </clipPath>
              </defs>
              <g clipPath={`url(#${id}-clip)`}>
                {n.children.map((c) => (
                  <NodeSvg key={c.rid} n={c} />
                ))}
              </g>
            </>
          ) : (
            n.children.map((c) => <NodeSvg key={c.rid} n={c} />)
          )}
          <Strokes d={d} n={n} id={id} closed />
        </>
      );
    }
    case "rect": {
      const d = rectPath(n.w, n.h, n.radius);
      return (
        <>
          <Fills d={d} n={n} id={id} />
          <Strokes d={d} n={n} id={id} closed />
        </>
      );
    }
    case "ellipse": {
      const d = ellipsePath(n.w, n.h);
      return (
        <>
          <Fills d={d} n={n} id={id} />
          <Strokes d={d} n={n} id={id} closed />
        </>
      );
    }
    case "polygon":
    case "star": {
      const d = polyPath(n.w, n.h, n.sides ?? (n.type === "star" ? 5 : 3), n.type === "star" ? (n.innerRatio ?? 0.38) : null);
      return (
        <>
          <Fills d={d} n={n} id={id} />
          <Strokes d={d} n={n} id={id} closed />
        </>
      );
    }
    case "path": {
      const d = pointsPath(n.points ?? [], !!n.closed);
      return (
        <>
          {n.closed && <Fills d={d} n={n} id={id} />}
          <Strokes d={d} n={n} id={id} closed={!!n.closed} />
        </>
      );
    }
    case "line":
    case "arrow":
      return <Line n={n} id={id} />;
    case "text":
      return <TextBody n={n} />;
    case "image":
      return <ImageBody n={n} id={id} />;
    default:
      return null;
  }
}

// ------------------------------------------------------------------- paints --
function Fills({ d, n, id }: { d: string; n: RNode; id: string }) {
  return (
    <>
      {n.fills.map((p, i) => {
        if (p.visible === false) return null;
        const pid = `${id}-f${i}`;
        return (
          <g key={i}>
            <PaintDef p={p} id={pid} />
            <path d={d} fill={paintRef(p, pid)} fillOpacity={p.opacity ?? 1} />
          </g>
        );
      })}
    </>
  );
}

function PaintDef({ p, id }: { p: Paint; id: string }) {
  if (p.type === "linear") {
    // angle: 0 = left to right, 90 = top to bottom.
    const a = (p.angle * Math.PI) / 180;
    const x = Math.cos(a) / 2;
    const y = Math.sin(a) / 2;
    return (
      <defs>
        <linearGradient id={id} x1={0.5 - x} y1={0.5 - y} x2={0.5 + x} y2={0.5 + y}>
          {p.stops.map((s, i) => (
            <stop key={i} offset={s.pos} stopColor={s.color} />
          ))}
        </linearGradient>
      </defs>
    );
  }
  if (p.type === "radial")
    return (
      <defs>
        <radialGradient id={id}>
          {p.stops.map((s, i) => (
            <stop key={i} offset={s.pos} stopColor={s.color} />
          ))}
        </radialGradient>
      </defs>
    );
  return null;
}

function paintRef(p: Paint, id: string) {
  return p.type === "solid" ? p.color : `url(#${id})`;
}

function Strokes({ d, n, id, closed }: { d: string; n: RNode; id: string; closed: boolean }) {
  return (
    <>
      {n.strokes.map((s, i) => {
        if (s.visible === false || !s.width) return null;
        const align = closed ? (s.align ?? "inside") : "center";
        const common = {
          d,
          fill: "none",
          stroke: s.color,
          strokeDasharray: s.dash?.length ? s.dash.join(" ") : undefined,
          strokeLinejoin: "round" as const,
          strokeLinecap: closed ? undefined : ("round" as const),
        };
        if (align === "center") return <path key={i} {...common} strokeWidth={s.width} />;
        // Inside / outside: twice the width, clipped to (or masked out of) the shape.
        const cid = `${id}-s${i}`;
        return (
          <g key={i}>
            <defs>
              {align === "inside" ? (
                <clipPath id={cid}>
                  <path d={d} />
                </clipPath>
              ) : (
                <mask id={cid} maskUnits="userSpaceOnUse" x={-1e5} y={-1e5} width={2e5} height={2e5}>
                  <rect x={-1e5} y={-1e5} width={2e5} height={2e5} fill="white" />
                  <path d={d} fill="black" />
                </mask>
              )}
            </defs>
            <path
              {...common}
              strokeWidth={s.width * 2}
              clipPath={align === "inside" ? `url(#${cid})` : undefined}
              mask={align === "outside" ? `url(#${cid})` : undefined}
            />
          </g>
        );
      })}
    </>
  );
}

function effectsFilter(n: RNode, prefix: string): { id: string | null; defs: ReactNode } {
  const fx = (n.effects ?? []).filter((e) => e.visible !== false);
  if (!fx.length) return { id: null, defs: null };
  const id = `${safeId(prefix, n.rid)}-fx`;
  const parts: ReactNode[] = [];
  let last = "SourceGraphic";
  const drops: string[] = [];
  fx.forEach((e: Effect, i) => {
    if (e.type === "drop-shadow") {
      parts.push(
        <feDropShadow key={i} in="SourceGraphic" dx={e.x} dy={e.y} stdDeviation={e.blur / 2} floodColor={e.color} result={`d${i}`} />,
      );
      drops.push(`d${i}`);
    } else if (e.type === "inner-shadow") {
      parts.push(
        <g key={i}>
          <feOffset in="SourceAlpha" dx={e.x} dy={e.y} result={`o${i}`} />
          <feGaussianBlur in={`o${i}`} stdDeviation={e.blur / 2} result={`b${i}`} />
          <feComposite in={`b${i}`} in2="SourceAlpha" operator="arithmetic" k2={-1} k3={1} result={`c${i}`} />
          <feFlood floodColor={e.color} result={`f${i}`} />
          <feComposite in={`f${i}`} in2={`c${i}`} operator="in" result={`i${i}`} />
        </g>,
      );
      drops.push(`__inner${i}`);
    } else if (e.type === "layer-blur") {
      parts.push(<feGaussianBlur key={i} in={last} stdDeviation={e.blur / 2} result={`l${i}`} />);
      last = `l${i}`;
    }
  });
  const shadows = drops.filter((x) => !x.startsWith("__"));
  const inners = drops.filter((x) => x.startsWith("__")).map((x) => `i${x.slice(7)}`);
  return {
    id,
    defs: (
      <defs>
        <filter id={id} x="-50%" y="-50%" width="200%" height="200%" colorInterpolationFilters="sRGB">
          {parts}
          <feMerge>
            {shadows.map((s) => (
              <feMergeNode key={s} in={s} />
            ))}
            <feMergeNode in={last} />
            {inners.map((s) => (
              <feMergeNode key={s} in={s} />
            ))}
          </feMerge>
        </filter>
      </defs>
    ),
  };
}

// --------------------------------------------------------------------- text --
export function textLines(n: RNode) {
  const t = n.text!;
  const lh = lineHeightOf(t);
  const lines = n.tl?.lines ?? t.content.split("\n").map((text) => ({ text, width: 0 }));
  const blockH = lines.length * lh;
  const top = t.valign === "middle" ? (n.h - blockH) / 2 : t.valign === "bottom" ? n.h - blockH : 0;
  return { lh, lines, top };
}

function TextBody({ n }: { n: RNode }) {
  const t = n.text;
  if (!t) return null;
  const { lh, lines, top } = textLines(n);
  const fill = n.fills.find((f) => f.visible !== false);
  const color = fill?.type === "solid" ? fill.color : fill?.type ? fill.stops[0]?.color : "#000";
  const anchor = t.align === "center" ? "middle" : t.align === "right" ? "end" : "start";
  const x = t.align === "center" ? n.w / 2 : t.align === "right" ? n.w : 0;
  // Baseline: centre the glyphs in the line box (ascent ≈ 0.8 em).
  const base = (lh - t.fontSize) / 2 + t.fontSize * 0.8;
  return (
    <text
      style={{ font: cssFont(t), letterSpacing: t.letterSpacing ? `${t.letterSpacing}px` : undefined, whiteSpace: "pre" }}
      fill={color}
      fillOpacity={fill?.opacity ?? 1}
      textAnchor={anchor}
      textDecoration={t.decoration === "underline" ? "underline" : t.decoration === "strike" ? "line-through" : undefined}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={r(x)} y={r(top + i * lh + base)}>
          {l.text || " "}
        </tspan>
      ))}
    </text>
  );
}

// -------------------------------------------------------------------- image --
const urlCache = new Map<string, string>();

export function useImageSrc(src: string | undefined): string | null {
  const ctx = useContext(Ctx);
  const direct = src ? (ctx.img?.(src) ?? (src.startsWith("data:") || src.startsWith("blob:") ? src : (urlCache.get(src) ?? cachedImageUrl(src)))) : null;
  const [url, setUrl] = useState<string | null>(direct);
  useEffect(() => {
    if (!src || direct) return setUrl(direct);
    let alive = true;
    void imageUrl(src).then((u) => {
      if (u) urlCache.set(src, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [src, direct]);
  return direct ?? url;
}

function ImageBody({ n, id }: { n: RNode; id: string }) {
  const img = n.image;
  const url = useImageSrc(img?.src);
  const d = rectPath(n.w, n.h, n.radius);
  if (!img) return null;
  let content: ReactNode = null;
  if (url) {
    if (img.fit === "tile") {
      content = (
        <>
          <defs>
            <pattern id={`${id}-tile`} patternUnits="userSpaceOnUse" width={img.nw} height={img.nh}>
              <image href={url} width={img.nw} height={img.nh} />
            </pattern>
          </defs>
          <path d={d} fill={`url(#${id}-tile)`} />
        </>
      );
    } else if (img.fit === "crop" && img.crop) {
      const s = img.crop.scale;
      content = <image href={url} x={img.crop.x} y={img.crop.y} width={img.nw * s} height={img.nh * s} preserveAspectRatio="none" />;
    } else content = <image href={url} width={n.w} height={n.h} preserveAspectRatio={img.fit === "fit" ? "xMidYMid meet" : "xMidYMid slice"} />;
  }
  return (
    <>
      <defs>
        <clipPath id={`${id}-clip`}>
          <path d={d} />
        </clipPath>
      </defs>
      <Fills d={d} n={n} id={id} />
      <g clipPath={`url(#${id}-clip)`}>{content ?? <rect width={n.w} height={n.h} fill="#E5E5E5" />}</g>
      <Strokes d={d} n={n} id={id} closed />
    </>
  );
}

// --------------------------------------------------------------------- line --
function Line({ n, id }: { n: RNode; id: string }) {
  const ctx = useContext(Ctx);
  const s = n.strokes.find((x) => x.visible !== false) ?? { color: "#1E1E1E", width: 2 };
  const [a, b] = linePoints(n);
  const cap = (kind: "none" | "arrow" | "circle" | undefined, mid: string) => {
    if (!kind || kind === "none") return null;
    const sz = 4;
    return (
      <marker id={mid} viewBox="0 0 10 10" refX={kind === "arrow" ? 8 : 5} refY={5} markerWidth={sz} markerHeight={sz} orient="auto-start-reverse">
        {kind === "arrow" ? <path d="M0,0 L10,5 L0,10 z" fill={s.color} /> : <circle cx={5} cy={5} r={4} fill={s.color} />}
      </marker>
    );
  };
  return (
    <>
      <defs>
        {cap(n.caps?.start, `${id}-ms`)}
        {cap(n.caps?.end, `${id}-me`)}
      </defs>
      <line
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        stroke={s.color}
        strokeWidth={s.width}
        strokeDasharray={s.dash?.length ? s.dash.join(" ") : undefined}
        strokeLinecap="round"
        markerStart={n.caps?.start && n.caps.start !== "none" ? `url(#${id}-ms)` : undefined}
        markerEnd={n.caps?.end && n.caps.end !== "none" ? `url(#${id}-me)` : undefined}
      />
      {/* Canvas: a wider invisible line so thin lines are easy to click. */}
      {ctx.interactive && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={Math.max(10, s.width + 8)} />}
    </>
  );
}

/** A line's ends in its own box: stored points, else corner to corner. */
export function linePoints(n: Pick<RNode, "points" | "w" | "h">): [PathPoint, PathPoint] {
  if (n.points && n.points.length >= 2) return [n.points[0]!, n.points[n.points.length - 1]!];
  return [
    { x: 0, y: 0 },
    { x: n.w, y: n.h },
  ];
}

// ----------------------------------------------------------------- geometry --
export function r(v: number) {
  return Math.round(v * 100) / 100;
}

export function rectPath(w: number, h: number, radius?: number | [number, number, number, number]) {
  const rr = Array.isArray(radius) ? radius : [radius ?? 0, radius ?? 0, radius ?? 0, radius ?? 0];
  const max = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = rr.map((v) => Math.max(0, Math.min(max, v))) as [number, number, number, number];
  if (!tl && !tr && !br && !bl) return `M0 0H${r(w)}V${r(h)}H0Z`;
  return [
    `M${r(tl)} 0`,
    `H${r(w - tr)}`,
    tr ? `A${r(tr)} ${r(tr)} 0 0 1 ${r(w)} ${r(tr)}` : "",
    `V${r(h - br)}`,
    br ? `A${r(br)} ${r(br)} 0 0 1 ${r(w - br)} ${r(h)}` : "",
    `H${r(bl)}`,
    bl ? `A${r(bl)} ${r(bl)} 0 0 1 0 ${r(h - bl)}` : "",
    `V${r(tl)}`,
    tl ? `A${r(tl)} ${r(tl)} 0 0 1 ${r(tl)} 0` : "",
    "Z",
  ].join("");
}

export function ellipsePath(w: number, h: number) {
  const rx = w / 2;
  const ry = h / 2;
  return `M0 ${r(ry)}A${r(rx)} ${r(ry)} 0 1 0 ${r(w)} ${r(ry)}A${r(rx)} ${r(ry)} 0 1 0 0 ${r(ry)}Z`;
}

export function polyPath(w: number, h: number, sides: number, inner: number | null) {
  const n = Math.max(3, Math.min(60, Math.round(sides)));
  const pts: string[] = [];
  const count = inner !== null ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
    const k = inner !== null && i % 2 === 1 ? inner : 1;
    pts.push(`${r(w / 2 + (Math.cos(a) * w * k) / 2)} ${r(h / 2 + (Math.sin(a) * h * k) / 2)}`);
  }
  return `M${pts.join("L")}Z`;
}

export function pointsPath(pts: PathPoint[], closed: boolean) {
  if (!pts.length) return "";
  const seg = (a: PathPoint, b: PathPoint) => {
    if (!a.out && !b.in) return `L${r(b.x)} ${r(b.y)}`;
    const c1 = a.out ? { x: a.x + a.out.x, y: a.y + a.out.y } : a;
    const c2 = b.in ? { x: b.x + b.in.x, y: b.y + b.in.y } : b;
    return `C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.x)} ${r(b.y)}`;
  };
  let d = `M${r(pts[0]!.x)} ${r(pts[0]!.y)}`;
  for (let i = 1; i < pts.length; i++) d += seg(pts[i - 1]!, pts[i]!);
  if (closed && pts.length > 2) d += `${seg(pts[pts.length - 1]!, pts[0]!)}Z`;
  return d;
}

function safeId(prefix: string, rid: string) {
  return `${prefix}-${rid.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
