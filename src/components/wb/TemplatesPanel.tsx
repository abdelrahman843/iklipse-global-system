import { memo, useMemo } from "react";
import { LayoutTemplate } from "lucide-react";
import { useWb, commit, zoomToFit, viewCenter, boundsOf, contentBounds } from "@/lib/wb/store";
import { withFrameMembership } from "@/lib/wb/actions";
import { TEMPLATES, instantiate, type WbTemplate } from "@/lib/wb/templates";
import { connectorGeometry, geomBounds, inflate, intersects, unionRects } from "@/lib/wb/geometry";
import { shapePath, shapeTextBox } from "@/lib/wb/shapes";
import { cssColor, num, str, textOn, type ConnectorData, type ShapeKind, type WbItem } from "@/lib/wb/types";
import { PanelHeader } from "./PanelHeader";

// -----------------------------------------------------------------------------
// Template picker. A click drops the template in the middle of the view (or
// beside the existing work when that spot is taken) as one undo step, selects
// it and zooms to it.
// -----------------------------------------------------------------------------

function insert(t: WbTemplate) {
  const c = viewCenter();
  let items = instantiate(t, c.x, c.y);
  // Like Miro: never drop it on top of existing work. If the middle of the
  // view is taken, place it to the right of everything on the board.
  const box = unionRects(items.filter((i) => i.type !== "connector").map((i) => geomBounds(i)));
  const s = useWb.getState();
  const taken = Object.keys(s.items).some((id) => {
    const b = boundsOf(s, id);
    return b && box && intersects(inflate(box, 40), b);
  });
  const all = contentBounds(s);
  if (taken && box && all) items = instantiate(t, all.x + all.w + 240 + box.w / 2, all.y + box.h / 2);
  const changes: Record<string, WbItem> = {};
  for (const it of items) changes[it.id] = it;
  // Connectors have no box of their own: keep them out of the selection and the fit.
  const ids = items.filter((i) => i.type !== "connector").map((i) => i.id);
  commit(withFrameMembership(changes), { select: ids });
  zoomToFit(ids);
}

export function TemplatesPanel({ onClose }: { onClose: () => void }) {
  const canEdit = useWb((s) => s.canEdit);
  // Sample layouts for the previews (built once per open).
  const previews = useMemo(() => TEMPLATES.map((t) => ({ t, items: t.build() })), []);

  return (
    <>
      <PanelHeader title="Templates" icon={<LayoutTemplate size={16} />} onClose={onClose} />
      <div data-wb-scroll className="flex-1 overflow-auto overscroll-contain p-3">
        {!canEdit && <p className="mb-3 text-sm text-muted">Only editors can add templates to this board.</p>}
        <div className="grid grid-cols-2 gap-2.5">
          {previews.map(({ t, items }) => (
            <button
              key={t.id}
              type="button"
              disabled={!canEdit}
              onClick={() => {
                insert(t);
                onClose();
              }}
              className="group flex flex-col text-left rounded-lg border border-border bg-surface p-1.5 hover:border-accent hover:shadow-pop transition-[border-color,box-shadow] disabled:opacity-60 disabled:hover:border-border disabled:hover:shadow-none"
            >
              <span className="block aspect-[16/10] w-full rounded-md bg-inset overflow-hidden p-1.5">
                <TemplatePreview items={items} />
              </span>
              <span className="mt-1.5 px-1 text-sm font-semibold text-ink truncate group-hover:text-accent">{t.name}</span>
              <span className="px-1 pb-0.5 text-xs text-subtle line-clamp-2">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- preview --
/** Miniature of a template's items (no text, just the layout and colours). */
const TemplatePreview = memo(function TemplatePreview({ items }: { items: WbItem[] }) {
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const b = unionRects(items.filter((i) => i.type !== "connector").map((i) => geomBounds(i)));
  if (!b) return null;
  const pad = Math.max(b.w, b.h) * 0.02;
  const order = [...items].sort((a, c) => (a.type === "frame" ? 0 : 1) - (c.type === "frame" ? 0 : 1) || a.z - c.z);
  return (
    <svg
      viewBox={`${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`}
      className="block w-full h-full"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {order.map((it) => (
        <PreviewItem key={it.id} it={it} geomOf={(id) => byId.get(id) ?? null} />
      ))}
    </svg>
  );
});

const hair = { vectorEffect: "non-scaling-stroke" as const, strokeWidth: 1 };

/** A bar standing in for a line of text. */
function Bar({ x, y, w, h, color, opacity = 0.75 }: { x: number; y: number; w: number; h: number; color: string; opacity?: number }) {
  return <rect x={x} y={y} width={Math.max(w, 1)} height={h} rx={h / 2} style={{ fill: color, opacity }} />;
}

function textBars(text: string, box: { x: number; y: number; w: number; h: number }, size: number, color: string, align = "center") {
  if (!text.trim()) return null;
  const bh = Math.min(size * 0.7, box.h);
  const w = Math.min(box.w * 0.8, text.length * size * 0.5);
  const x = align === "left" ? box.x : box.x + (box.w - w) / 2;
  return <Bar x={x} y={box.y + box.h / 2 - bh / 2} w={w} h={bh} color={color} />;
}

function PreviewItem({ it, geomOf }: { it: WbItem; geomOf: (id: string) => WbItem | null }) {
  const d = it.data;
  const tf = it.rotation ? `rotate(${it.rotation} ${it.x + it.w / 2} ${it.y + it.h / 2})` : undefined;
  switch (it.type) {
    case "frame":
      return <rect x={it.x} y={it.y} width={it.w} height={it.h} style={{ fill: cssColor(str(d.fill, "surface")), stroke: "rgb(var(--c-border))", ...hair }} />;
    case "sticky": {
      const fill = str(d.fill, "#f5cd47");
      const pad = it.w * 0.15;
      return (
        <g transform={tf}>
          <rect x={it.x} y={it.y} width={it.w} height={it.h} style={{ fill: cssColor(fill) }} />
          {textBars(str(d.text), { x: it.x + pad, y: it.y + pad, w: it.w - pad * 2, h: it.h - pad * 2 }, it.w * 0.14, textOn(fill))}
        </g>
      );
    }
    case "shape": {
      const kind = (str(d.shape, "rect") || "rect") as ShapeKind;
      const fill = str(d.fill, "surface");
      const sw = num(d.strokeWidth, 2);
      const tb = shapeTextBox(kind, it.w, it.h);
      const size = d.fontSize === "auto" ? 24 : num(d.fontSize, 16);
      return (
        <g transform={`translate(${it.x} ${it.y})${it.rotation ? ` rotate(${it.rotation} ${it.w / 2} ${it.h / 2})` : ""}`}>
          <path
            d={shapePath(kind, it.w, it.h)}
            style={{
              fill: cssColor(fill),
              fillOpacity: num(d.opacity, 1),
              stroke: sw > 0 ? cssColor(str(d.stroke, "ink")) : "none",
              ...hair,
            }}
          />
          {textBars(str(d.text), tb, size, d.color ? cssColor(str(d.color)) : textOn(fill === "none" ? null : fill))}
        </g>
      );
    }
    case "text": {
      const size = num(d.fontSize, 20);
      const lines = Math.max(1, Math.round(it.h / (size * 1.3)));
      const bh = size * 0.62;
      const color = cssColor(str(d.color, "ink"));
      return (
        <g transform={tf}>
          {Array.from({ length: lines }, (_, i) => (
            <Bar
              key={i}
              x={it.x}
              y={it.y + i * size * 1.3 + (size * 1.3 - bh) / 2}
              w={it.w * (i === lines - 1 && lines > 1 ? 0.6 : 1)}
              h={bh}
              color={color}
              opacity={0.45}
            />
          ))}
        </g>
      );
    }
    case "card":
      return (
        <g>
          <rect x={it.x} y={it.y} width={it.w} height={it.h} rx={8} style={{ fill: "rgb(var(--c-surface))", stroke: "rgb(var(--c-border))", ...hair }} />
          <rect x={it.x} y={it.y} width={8} height={it.h} style={{ fill: cssColor(str(d.fill, "#579dff")) }} />
          <Bar x={it.x + 24} y={it.y + 20} w={it.w * 0.6} h={14} color="rgb(var(--c-ink))" opacity={0.55} />
        </g>
      );
    case "emoji":
      return (
        <text x={it.x + it.w / 2} y={it.y + it.h / 2} fontSize={it.h * 0.8} textAnchor="middle" dominantBaseline="central">
          {str(d.emoji, "👍")}
        </text>
      );
    case "connector": {
      const geo = connectorGeometry(d as ConnectorData, geomOf);
      return <path d={geo.d} style={{ fill: "none", stroke: cssColor(str(d.color, "ink")), ...hair }} />;
    }
    default:
      return <rect x={it.x} y={it.y} width={it.w} height={it.h} style={{ fill: "rgb(var(--c-subtle))", opacity: 0.4 }} />;
  }
}
