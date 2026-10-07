import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { Calendar, Check, CheckCircle2, FileText, ImageOff } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import { useWb, geomOf, patchItem, commit, mergeItem, type Live } from "@/lib/wb/store";
import {
  cssColor,
  textOn,
  str,
  num,
  bool,
  FONT_STACK,
  type ConnectorData,
  type FontFamily,
  type Geom,
  type ShapeKind,
  type TextStyle,
  type WbItem,
} from "@/lib/wb/types";
import { capPath, connectorGeometry } from "@/lib/wb/geometry";
import { shapePath, shapeTextBox } from "@/lib/wb/shapes";
import { fitFontSize, linkify, measureTextHeight, measureTextWidth, LINE_HEIGHT } from "@/lib/wb/text";
import { cachedImageUrl, imageUrl } from "@/lib/wb/api";
import { useWbPeople } from "@/lib/wb/people";
import { docBlocks, docTitle } from "@/lib/wb/docBlocks";

// -----------------------------------------------------------------------------
// One canvas item. Each subscribes to its own row (and live drag geometry), so
// a change re-renders only the items it touches.
// -----------------------------------------------------------------------------

export const ItemView = memo(function ItemView({ id }: { id: string }) {
  const it = useWb((s) => s.items[id]);
  const live = useWb((s) => s.live[id] ?? s.remoteLive[id]);
  const editing = useWb((s) => (s.editing?.id === id ? s.editing.field : null));
  if (!it) return null;
  return <ItemRender it={it} live={live} editing={editing} />;
});

/**
 * Renders an item object (also used for the ghost of an item being drawn, and
 * `still` for slide thumbnails: no hit areas, no controls).
 */
export function ItemRender({ it, live, editing = null, ghost, still }: { it: WbItem; live?: Live; editing?: string | null; ghost?: boolean; still?: boolean }) {
  const passive = ghost || still;
  if (it.type === "connector") return <ConnectorView it={it} editing={editing === "label"} ghost={passive} />;
  const g: Geom = live
    ? { x: live.x ?? it.x, y: live.y ?? it.y, w: live.w ?? it.w, h: live.h ?? it.h, rotation: live.rotation ?? it.rotation }
    : it;
  const data = live?.data ? { ...it.data, ...live.data } : it.data;
  const style: CSSProperties = {
    left: g.x,
    top: g.y,
    width: g.w,
    height: g.h,
    transform: g.rotation ? `rotate(${g.rotation}deg)` : undefined,
    opacity: ghost ? 0.7 : undefined,
  };
  const view = { ...it, ...g, data };
  const hitBox = !passive && it.type !== "frame" && it.type !== "pen";
  return (
    <div
      data-wb-id={hitBox ? it.id : undefined}
      data-wb-frame={it.type === "frame" && !passive ? it.id : undefined}
      className={cn("absolute", (passive || it.type === "pen") && "pointer-events-none")}
      style={style}
    >
      {it.type === "sticky" && <StickyView it={view} editing={!!editing} />}
      {it.type === "shape" && <ShapeView it={view} editing={!!editing} />}
      {it.type === "text" && <TextView it={view} editing={!!editing} />}
      {it.type === "frame" && <FrameView it={view} editing={editing === "title"} />}
      {it.type === "image" && <ImageView it={view} />}
      {it.type === "pen" && <PenView it={view} />}
      {it.type === "card" && <CardView it={view} editing={!!editing} />}
      {it.type === "emoji" && <EmojiView it={view} />}
      {it.type === "doc" && <DocView it={view} ghost={passive} />}
    </div>
  );
}

// ------------------------------------------------------------------- text --
function textCss(st: TextStyle, size: number, color: string): CSSProperties {
  return {
    fontSize: size,
    lineHeight: LINE_HEIGHT,
    color,
    fontFamily: FONT_STACK[(st.font as FontFamily) ?? "sans"],
    fontWeight: st.bold ? 700 : 400,
    fontStyle: st.italic ? "italic" : undefined,
    textDecoration: [st.underline && "underline", st.strike && "line-through"].filter(Boolean).join(" ") || undefined,
    textAlign: st.align ?? "center",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  };
}

function endEditing() {
  useWb.setState({ editing: null });
}

/**
 * Text that is shown, or edited in place. While editing, the DOM owns the
 * text (so the caret never jumps); every keystroke is saved, merged into one
 * undo step.
 */
function TextBlock({
  id,
  field,
  text,
  st,
  color,
  editing,
  fit,
  fixedSize,
  placeholder,
  onText,
  className,
  style,
}: {
  id: string;
  field: string;
  text: string;
  st: TextStyle;
  color: string;
  editing: boolean;
  /** Box the auto font size fits into. */
  fit?: { w: number; h: number; max: number };
  fixedSize?: number;
  placeholder?: string;
  /** Extra changes to save with the text (e.g. a text box's new size). */
  onText?: (t: string) => Partial<WbItem> & { data?: Record<string, unknown> };
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    if (!editing) setDraft(text);
  }, [text, editing]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.innerText = text;
    el.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const shown = editing ? draft : text;
  const size =
    st.fontSize === "auto" || st.fontSize == null
      ? fit
        ? fitFontSize(shown, fit.w, fit.h, { font: st.font as FontFamily, bold: st.bold, italic: st.italic, max: fit.max })
        : (fixedSize ?? 16)
      : num(st.fontSize, 16);

  const css = textCss(st, size, color);
  if (editing) {
    return (
      // Own key: React must not reuse this node for the read-only view, or the
      // text typed into it would stay alongside the rendered spans.
      <div
        key="edit"
        ref={ref}
        contentEditable="plaintext-only"
        suppressContentEditableWarning
        spellCheck
        data-wb-editor
        className={cn("outline-none cursor-text min-w-[2px]", className)}
        style={{ ...css, ...style }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
            e.preventDefault();
            (e.currentTarget as HTMLDivElement).blur();
          }
        }}
        onInput={(e) => {
          const t = (e.currentTarget as HTMLDivElement).innerText.replace(/ /g, " ").replace(/\n$/, "");
          setDraft(t);
          const it = useWb.getState().items[id];
          if (!it) return;
          const extra = onText?.(t) ?? {};
          commit({ [id]: mergeItem(it, { ...extra, data: { ...(extra.data ?? {}), [field]: t } }) }, { key: `text:${id}` });
        }}
        onBlur={endEditing}
      />
    );
  }
  return (
    <div key="view" className={cn("pointer-events-none", className)} style={{ ...css, ...style }}>
      {shown ? (
        linkify(shown).map((p, i) =>
          p.href ? (
            <a
              key={i}
              href={p.href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline pointer-events-auto"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {p.text}
            </a>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )
      ) : placeholder ? (
        <span className="opacity-40">{placeholder}</span>
      ) : null}
    </div>
  );
}

/** Far out, text is unreadable anyway: skip laying it out (big boards stay smooth). */
const useFarOut = () => useWb((s) => s.viewport.zoom < 0.12);

const justify = (v?: string) => (v === "top" ? "flex-start" : v === "bottom" ? "flex-end" : "center");

// ----------------------------------------------------------------- sticky --
function StickyView({ it, editing }: { it: WbItem; editing: boolean }) {
  const d = it.data as TextStyle & { fill?: string; showAuthor?: boolean };
  const fill = cssColor(str(d.fill, "#f5cd47"));
  const color = d.color ? cssColor(d.color) : textOn(str(d.fill, "#f5cd47"));
  const pad = Math.max(8, it.w * 0.07);
  const people = useWbPeople();
  const author = d.showAuthor && it.created_by ? people.data?.byId.get(it.created_by)?.display_name : null;
  const far = useFarOut() && !editing;
  return (
    <div
      className="w-full h-full flex flex-col"
      style={{
        background: fill,
        padding: pad,
        justifyContent: justify(d.valign),
        boxShadow: "0 1px 2px rgb(0 0 0 / 0.12), 0 6px 12px -4px rgb(0 0 0 / 0.18)",
      }}
    >
      {!far && (
        <TextBlock
          id={it.id}
          field="text"
          text={str(d.text)}
          st={d}
          color={color}
          editing={editing}
          fit={{ w: it.w - pad * 2, h: it.h - pad * 2 - (author ? 14 : 0), max: Math.min(96, it.w * 0.28) }}
        />
      )}
      {author && (
        <div className="absolute left-0 right-0 bottom-1 px-2 truncate text-[10px] opacity-70" style={{ color }}>
          {author}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ shape --
function ShapeView({ it, editing }: { it: WbItem; editing: boolean }) {
  const d = it.data as TextStyle & { shape?: ShapeKind; fill?: string; stroke?: string; strokeWidth?: number; dash?: string; opacity?: number };
  const kind = (d.shape ?? "rect") as ShapeKind;
  const sw = num(d.strokeWidth, 2);
  const fill = str(d.fill, "surface");
  const tb = shapeTextBox(kind, it.w, it.h);
  const color = d.color ? cssColor(d.color) : textOn(fill === "none" ? null : fill);
  const dash = d.dash === "dashed" ? `${sw * 4} ${sw * 3}` : d.dash === "dotted" ? `${sw} ${sw * 2}` : undefined;
  const far = useFarOut() && !editing;
  return (
    <>
      <svg className="absolute inset-0 overflow-visible" width={it.w} height={it.h}>
        <path
          d={shapePath(kind, it.w, it.h)}
          fill={cssColor(fill)}
          fillOpacity={num(d.opacity, 1)}
          stroke={sw > 0 ? cssColor(str(d.stroke, "ink")) : "none"}
          strokeWidth={sw}
          strokeDasharray={dash}
          strokeLinejoin="round"
        />
      </svg>
      {!far && (
        <div
          className="absolute flex flex-col"
          style={{ left: tb.x, top: tb.y, width: tb.w, height: tb.h, justifyContent: justify(d.valign) }}
        >
          <TextBlock
            id={it.id}
            field="text"
            text={str(d.text)}
            st={d}
            color={color}
            editing={editing}
            fit={{ w: tb.w, h: tb.h, max: 64 }}
          />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------- text --
function TextView({ it, editing }: { it: WbItem; editing: boolean }) {
  const d = it.data as TextStyle & { fill?: string; autoWidth?: boolean };
  const size = num(d.fontSize, 20);
  return (
    <div className="w-full h-full" style={{ background: cssColor(str(d.fill, "none")) }}>
      <TextBlock
        id={it.id}
        field="text"
        text={str(d.text)}
        st={{ ...d, align: d.align ?? "left" }}
        color={cssColor(str(d.color, "ink"))}
        editing={editing}
        fixedSize={size}
        placeholder={editing ? undefined : "Text"}
        style={{ minHeight: "100%" }}
        onText={(t) => {
          const font = (d.font as FontFamily) ?? "sans";
          if (d.autoWidth) {
            const w = Math.max(20, measureTextWidth(t, size, font, d.bold, d.italic) + 4);
            return { w, h: Math.ceil(measureTextHeight(t, w, size, font, d.bold, d.italic)) };
          }
          return { h: Math.max(Math.ceil(size * LINE_HEIGHT), Math.ceil(measureTextHeight(t, it.w, size, font, d.bold, d.italic))) };
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ frame --
function FrameView({ it, editing }: { it: WbItem; editing: boolean }) {
  const title = str(it.data.title, "Frame");
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  return (
    <div className="w-full h-full" style={{ background: cssColor(str(it.data.fill, "surface")), boxShadow: "0 0 0 1px rgb(var(--c-border))" }}>
      {/* Title floats above the frame at a constant on-screen size. */}
      <div
        data-wb-id={it.id}
        data-wb-frame-title
        className="absolute left-0 bottom-full origin-bottom-left whitespace-nowrap"
        style={{ transform: "scale(calc(1 / var(--wb-zoom, 1)))", paddingBottom: 4 }}
      >
        {editing ? (
          <input
            autoFocus
            value={draft}
            maxLength={120}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
            }}
            onBlur={() => {
              if (draft.trim() && draft !== title) patchItem(it.id, { data: { title: draft.trim() } });
              endEditing();
            }}
            className="h-6 px-1 rounded-sm text-sm bg-surface text-ink border border-accent outline-none w-56"
          />
        ) : (
          <span className="text-sm text-subtle hover:text-ink cursor-default select-none max-w-[320px] truncate inline-block align-bottom">{title}</span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ image --
function ImageView({ it }: { it: WbItem }) {
  const path = str(it.data.path);
  const [src, setSrc] = useState<string | null>(() => (path ? cachedImageUrl(path) : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    if (!path) return;
    const c = cachedImageUrl(path);
    if (c) setSrc(c);
    else void imageUrl(path).then((u) => live && (u ? setSrc(u) : setFailed(true)));
    return () => {
      live = false;
    };
  }, [path]);
  if (failed || !path)
    return (
      <div className="w-full h-full grid place-items-center bg-inset text-subtle border border-border">
        <ImageOff size={Math.min(48, it.w / 4)} />
      </div>
    );
  if (!src) return <div className="w-full h-full bg-inset animate-pulse" />;
  return <img src={src} alt={str(it.data.name)} draggable={false} className="w-full h-full object-fill select-none pointer-events-none" onError={() => setFailed(true)} />;
}

// -------------------------------------------------------------------- pen --
export function penPath(points: number[], sx = 1, sy = 1): string {
  if (points.length < 2) return "";
  const P = (i: number) => ({ x: points[i]! * sx, y: points[i + 1]! * sy });
  if (points.length <= 4) {
    const a = P(0);
    const b = points.length === 4 ? P(2) : a;
    return `M${a.x},${a.y} L${b.x + 0.01},${b.y}`;
  }
  let d = `M${P(0).x},${P(0).y}`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const a = P(i);
    const b = P(i + 2);
    d += ` Q${a.x},${a.y} ${(a.x + b.x) / 2},${(a.y + b.y) / 2}`;
  }
  const last = P(points.length - 2);
  return `${d} L${last.x},${last.y}`;
}

function PenView({ it }: { it: WbItem }) {
  const pts = (it.data.points as number[]) ?? [];
  const sx = it.w / Math.max(1, num(it.data.bw, it.w));
  const sy = it.h / Math.max(1, num(it.data.bh, it.h));
  const hl = bool(it.data.highlighter);
  const width = num(it.data.width, 3);
  return (
    <svg className="absolute inset-0 overflow-visible pointer-events-none" width={it.w} height={it.h}>
      <path
        data-wb-id={it.id}
        d={penPath(pts, sx, sy)}
        fill="none"
        stroke={cssColor(str(it.data.color, "ink"))}
        strokeOpacity={hl ? 0.45 : 1}
        strokeWidth={width}
        strokeLinecap={hl ? "square" : "round"}
        strokeLinejoin="round"
        className="pointer-events-auto"
        style={{ pointerEvents: "stroke" }}
      />
      {/* Wider invisible stroke so thin lines are easy to grab. */}
      <path data-wb-id={it.id} d={penPath(pts, sx, sy)} fill="none" stroke="transparent" strokeWidth={Math.max(width, 12)} style={{ pointerEvents: "stroke" }} />
    </svg>
  );
}

// ------------------------------------------------------------------- card --
function CardView({ it, editing }: { it: WbItem; editing: boolean }) {
  const d = it.data as { title?: string; description?: string; fill?: string; assignee?: string | null; due?: string | null; done?: boolean };
  const people = useWbPeople();
  const who = d.assignee ? people.data?.byId.get(d.assignee) : null;
  const overdue = d.due && !d.done && new Date(`${d.due}T23:59:59`) < new Date();
  return (
    <div className="w-full h-full bg-surface text-ink rounded-lg shadow-card border border-border overflow-hidden flex">
      <div className="w-1.5 shrink-0" style={{ background: cssColor(str(d.fill, "#579dff")) }} />
      <div className="flex-1 min-w-0 p-3 flex flex-col gap-1.5">
        <TextBlock
          id={it.id}
          field="title"
          text={str(d.title)}
          st={{ fontSize: 16, bold: true, align: "left" }}
          color="rgb(var(--c-ink))"
          editing={editing}
          placeholder="Card title"
          className={cn(d.done && !editing && "line-through opacity-60")}
        />
        {d.description && <div className="text-sm text-muted line-clamp-3 whitespace-pre-wrap pointer-events-none">{d.description}</div>}
        <div className="mt-auto flex items-center gap-2 text-xs text-subtle pointer-events-none">
          {d.done && <CheckCircle2 size={14} className="text-success" />}
          {d.due && (
            <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5", overdue ? "bg-danger/15 text-danger" : "bg-inset")}>
              <Calendar size={12} />
              {new Date(`${d.due}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
            </span>
          )}
          <span className="flex-1" />
          {who && <Avatar name={who.display_name} src={who.avatar_url} size={22} />}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- doc --
/** A doc page: title and the start of its text (the full text opens in the doc editor). */
function DocView({ it, ghost }: { it: WbItem; ghost?: boolean }) {
  const far = useFarOut();
  const active = useWb((s) => !ghost && (s.hover === it.id || (s.selection.length === 1 && s.selection[0] === it.id)));
  const blocks = far ? [] : docBlocks(it);
  let num = 0;
  return (
    <div className="w-full h-full bg-surface text-ink border border-border rounded-md shadow-card overflow-hidden flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-8 pt-6 pb-1 text-subtle">
        <FileText size={20} className="text-accent" />
        <span className="text-sm font-medium">Doc</span>
      </div>
      <div className="shrink-0 px-8 pt-1 pb-2 text-[30px] leading-tight font-bold break-words line-clamp-3">{docTitle(it)}</div>
      {!far && (
        <div className="relative flex-1 min-h-0 overflow-hidden px-8 pt-2 pb-8 text-[15px] leading-relaxed">
          {blocks.length === 0 && <p className="text-subtle">Double-click to start writing.</p>}
          {blocks.map((b, i) => {
            num = b.t === "ol" ? num + 1 : 0;
            const pad = { paddingLeft: (b.n ?? 0) * 20 };
            switch (b.t) {
              case "h1":
                return <div key={i} className="text-[24px] font-bold mt-3 mb-1 leading-snug">{b.x}</div>;
              case "h2":
                return <div key={i} className="text-[20px] font-semibold mt-3 mb-1 leading-snug">{b.x}</div>;
              case "h3":
                return <div key={i} className="text-[17px] font-semibold mt-2 leading-snug">{b.x}</div>;
              case "ul":
                return <div key={i} className="flex gap-2" style={pad}><span>•</span><span className="min-w-0">{b.x}</span></div>;
              case "ol":
                return <div key={i} className="flex gap-2" style={pad}><span className="tabular-nums">{num}.</span><span className="min-w-0">{b.x}</span></div>;
              case "task":
                return (
                  <div key={i} className="flex items-start gap-2" style={pad}>
                    <span className={cn("mt-[5px] h-[14px] w-[14px] shrink-0 rounded-[3px] border grid place-items-center", b.d ? "bg-accent border-accent text-white" : "border-rule")}>
                      {b.d && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className={cn("min-w-0", b.d && "line-through text-subtle")}>{b.x}</span>
                  </div>
                );
              case "quote":
                return <div key={i} className="border-l-[3px] border-rule pl-3 text-muted my-1">{b.x}</div>;
              case "code":
                return <div key={i} className="font-mono text-[13px] bg-inset rounded px-2 py-1 my-1 whitespace-pre-wrap break-all">{b.x}</div>;
              case "hr":
                return <div key={i} className="border-t border-line my-3" />;
              case "table":
                return <div key={i} className="text-[13px] border-b border-line py-1 truncate">{b.x}</div>;
              case "img":
                return <DocImage key={i} path={b.p!} />;
              default:
                return <p key={i} className="min-h-[1em] mb-1 break-words">{b.x}</p>;
            }
          })}
          <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-surface to-transparent pointer-events-none" />
        </div>
      )}
      {active && (
        // Constant on-screen size, top right, like Miro's "Open".
        <div className="absolute right-2 top-2 origin-top-right" style={{ transform: "scale(calc(1 / var(--wb-zoom, 1)))" }}>
          <button
            type="button"
            className="pointer-events-auto h-8 px-3 rounded-md bg-accent text-white text-sm font-medium shadow-pop hover:bg-accent-hover"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => useWb.setState({ openDoc: it.id })}
          >
            Open
          </button>
        </div>
      )}
    </div>
  );
}

/** An image inside a doc preview (signed URL, like image items). */
function DocImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(() => cachedImageUrl(path));
  useEffect(() => {
    let live = true;
    if (!cachedImageUrl(path)) void imageUrl(path).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [path]);
  return src ? (
    <img src={src} alt="" draggable={false} className="block max-w-full max-h-[260px] rounded-md my-2 select-none" />
  ) : (
    <div className="h-24 my-2 rounded-md bg-inset" />
  );
}

// ------------------------------------------------------------------ emoji --
function EmojiView({ it }: { it: WbItem }) {
  return (
    <div className="w-full h-full grid place-items-center select-none pointer-events-none" style={{ fontSize: Math.min(it.w, it.h) * 0.82, lineHeight: 1 }}>
      {str(it.data.emoji, "👍")}
    </div>
  );
}

// -------------------------------------------------------------- connector --
function ConnectorView({ it, editing, ghost }: { it: WbItem; editing: boolean; ghost?: boolean }) {
  const d = it.data as ConnectorData;
  const sId = d.start?.id ?? "";
  const eId = d.end?.id ?? "";
  // Re-render when either attached item (or its live drag) moves.
  const [sg, eg, live] = useWb(useShallow((s) => [sId ? geomOf(s, sId) : null, eId ? geomOf(s, eId) : null, s.live[it.id]]));
  const data = (live?.data ? { ...d, ...live.data } : d) as ConnectorData;
  const geo = connectorGeometry(data, (id) => (id === sId ? sg : id === eId ? eg : null));
  const width = num(data.width, 2);
  const color = cssColor(str(data.color, "ink"));
  const dash = data.dash === "dashed" ? `${width * 4} ${width * 3}` : data.dash === "dotted" ? `${width} ${width * 2}` : undefined;
  const pad = 24 + width * 3;
  const b = geo.bounds;
  const ox = b.x - pad;
  const oy = b.y - pad;
  const sc = capPath(str(data.startCap, "none"), geo.start, geo.startAngle, width);
  const ec = capPath(str(data.endCap, "arrow"), geo.end, geo.endAngle, width);
  const label = str(data.label);
  const [draft, setDraft] = useState(label);
  useEffect(() => setDraft(label), [label]);
  return (
    <div className="absolute pointer-events-none" style={{ left: ox, top: oy, width: b.w + pad * 2, height: b.h + pad * 2 }}>
      <svg className="absolute inset-0 overflow-visible" width={b.w + pad * 2} height={b.h + pad * 2}>
        <g transform={`translate(${-ox} ${-oy})`}>
          {!ghost && <path d={geo.d} fill="none" stroke="transparent" strokeWidth={Math.max(16, width + 12)} data-wb-id={it.id} style={{ pointerEvents: "stroke" }} />}
          <path d={geo.d} fill="none" stroke={color} strokeWidth={width} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" />
          {sc && <path d={sc.d} fill={sc.filled ? color : "none"} stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" />}
          {ec && <path d={ec.d} fill={ec.filled ? color : "none"} stroke={color} strokeWidth={width} strokeLinejoin="round" strokeLinecap="round" />}
        </g>
      </svg>
      {(label || editing) && (
        <div
          data-wb-id={it.id}
          className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto"
          style={{ left: geo.mid.x - ox, top: geo.mid.y - oy }}
        >
          {editing ? (
            <input
              autoFocus
              value={draft}
              maxLength={200}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
              }}
              onBlur={() => {
                if (draft !== label) patchItem(it.id, { data: { label: draft.trim() || undefined } });
                endEditing();
              }}
              className="h-7 px-2 rounded-sm text-sm bg-surface text-ink border border-accent outline-none w-40 text-center"
            />
          ) : (
            <div className="px-1.5 py-0.5 rounded-sm bg-bg text-ink text-sm whitespace-pre max-w-[280px] truncate">{label}</div>
          )}
        </div>
      )}
    </div>
  );
}
