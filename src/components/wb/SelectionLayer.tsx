import { Lock } from "lucide-react";
import { useWb, geomOf, worldToScreen, selectionBounds } from "@/lib/wb/store";
import { CONNECTABLE, ROTATABLE, type ConnectorData, type Geom, type Viewport, type WbItem } from "@/lib/wb/types";
import { center, connectorGeometry, geomBounds, rotatePoint, type Pt } from "@/lib/wb/geometry";

// -----------------------------------------------------------------------------
// Screen-space overlay above the items: selection outlines and handles, the
// "+" quick-connect dots, hover and connect-target outlines, marquee, snap
// guides, and other people's cursors and selections. Handles carry
// data-wb-handle so the canvas knows which gesture to start.
// -----------------------------------------------------------------------------

const toScreen = (g: Geom, vp: Viewport) => ({
  x: g.x * vp.zoom + vp.x,
  y: g.y * vp.zoom + vp.y,
  w: g.w * vp.zoom,
  h: g.h * vp.zoom,
  r: g.rotation,
});

function Outline({ g, vp, color, width = 1.5, dashed, label }: { g: Geom; vp: Viewport; color: string; width?: number; dashed?: boolean; label?: string }) {
  const r = toScreen(g, vp);
  return (
    <div
      className="absolute left-0 top-0 origin-center pointer-events-none"
      style={{
        width: r.w,
        height: r.h,
        transform: `translate(${r.x}px, ${r.y}px) rotate(${r.r}deg)`,
        boxShadow: dashed ? undefined : `0 0 0 ${width}px ${color}`,
        outline: dashed ? `${width}px dashed ${color}` : undefined,
      }}
    >
      {label && (
        <span className="absolute -top-5 left-0 px-1.5 rounded-sm text-[10px] font-medium text-white whitespace-nowrap" style={{ background: color }}>
          {label}
        </span>
      )}
    </div>
  );
}

const HANDLE_POS: Record<string, [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};
const CURSORS: Record<string, string> = { nw: "nwse", se: "nwse", ne: "nesw", sw: "nesw", n: "ns", s: "ns", e: "ew", w: "ew" };

function handlesFor(it: WbItem): string[] {
  if (it.type === "sticky" || it.type === "emoji" || it.type === "image") return ["nw", "ne", "se", "sw"];
  if (it.type === "text") return ["nw", "ne", "se", "sw", "e", "w"];
  return ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
}

function Handles({ g, vp, names, rotatable }: { g: Geom; vp: Viewport; names: string[]; rotatable: boolean }) {
  const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  const at = (fx: number, fy: number, offY = 0): Pt => {
    const p = rotatePoint({ x: g.x + fx * g.w, y: g.y + fy * g.h }, c, g.rotation);
    const s = worldToScreen(p, vp);
    if (!offY) return s;
    // Outward from the top edge, turned with the item.
    const rad = (g.rotation * Math.PI) / 180;
    return { x: s.x + Math.sin(rad) * offY, y: s.y - Math.cos(rad) * offY };
  };
  // Small boxes hide side handles so corners stay grabbable.
  const tiny = g.w * vp.zoom < 40 || g.h * vp.zoom < 40;
  return (
    <>
      {names
        .filter((n) => !(tiny && n.length === 1))
        .map((n) => {
          const [fx, fy] = HANDLE_POS[n]!;
          const p = at(fx, fy);
          return (
            // Outer box places the handle (no transition, so it never lags the
            // item); the inner dot carries the hover effect. A bigger invisible
            // hit area makes it easy to grab on touch screens.
            <div
              key={n}
              data-wb-handle={n}
              className="absolute left-0 top-0 h-6 w-6 -ml-3 -mt-3 grid place-items-center pointer-events-auto touch-none group"
              style={{ transform: `translate(${p.x}px, ${p.y}px)`, cursor: `${CURSORS[n]}-resize` }}
            >
              <span className="h-3 w-3 rounded-full bg-surface border-2 border-accent group-hover:scale-125 transition-transform" />
            </div>
          );
        })}
      {rotatable && (
        <div
          data-wb-handle="rot"
          title="Rotate"
          className="absolute left-0 top-0 h-6 w-6 -ml-3 -mt-3 grid place-items-center pointer-events-auto touch-none group"
          style={{ transform: `translate(${at(0.5, 1, -42).x}px, ${at(0.5, 1, -42).y}px)`, cursor: "grab" }}
        >
          <span className="h-4 w-4 rounded-full bg-surface border-2 border-accent grid place-items-center group-hover:scale-110 transition-transform">
            <span className="h-1 w-1 rounded-full bg-accent" />
          </span>
        </div>
      )}
    </>
  );
}

function QuickConnect({ it, g, vp }: { it: WbItem; g: Geom; vp: Viewport }) {
  const c = { x: g.x + g.w / 2, y: g.y + g.h / 2 };
  const gap = 18 / vp.zoom;
  const pts: [string, Pt][] = [
    ["top", { x: c.x, y: g.y - gap }],
    ["right", { x: g.x + g.w + gap, y: c.y }],
    ["bottom", { x: c.x, y: g.y + g.h + gap }],
    ["left", { x: g.x - gap, y: c.y }],
  ];
  return (
    <>
      {pts.map(([side, p]) => {
        const s = worldToScreen(rotatePoint(p, c, g.rotation), vp);
        return (
          <div
            key={side}
            data-wb-handle={`qc:${side}`}
            data-wb-target={it.id}
            title="Drag to connect, click to add"
            className="absolute left-0 top-0 h-6 w-6 -ml-3 -mt-3 grid place-items-center pointer-events-auto touch-none cursor-pointer group"
            style={{ transform: `translate(${s.x}px, ${s.y}px)` }}
          >
            <span className="h-4 w-4 rounded-full bg-accent text-white grid place-items-center opacity-70 group-hover:opacity-100 group-hover:scale-125 transition-[opacity,transform]">
              <svg width="8" height="8" viewBox="0 0 8 8">
                <path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
          </div>
        );
      })}
    </>
  );
}

export function SelectionLayer() {
  const s = useWb();
  const vp = s.viewport;
  const accent = "rgb(var(--c-accent))";
  const sel = s.selection.filter((id) => s.items[id]).slice(0, 400);
  const single = sel.length === 1 ? s.items[sel[0]!]! : null;
  const dragging = Object.keys(s.live).length > 0;
  const geomOfId = (id: string) => geomOf(s, id);

  const outlines: JSX.Element[] = [];
  for (const id of sel) {
    const it = s.items[id]!;
    if (it.type === "connector") {
      const geo = connectorGeometry({ ...(it.data as ConnectorData), ...((s.live[id]?.data ?? {}) as ConnectorData) }, geomOfId);
      const a = worldToScreen(geo.start, vp);
      const b = worldToScreen(geo.end, vp);
      outlines.push(
        <svg key={id} className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
          <path d={geo.d} transform={`translate(${vp.x} ${vp.y}) scale(${vp.zoom})`} fill="none" stroke={accent} strokeOpacity={0.35} strokeWidth={6 / vp.zoom} />
        </svg>,
      );
      if (single && s.canEdit && !it.locked) {
        for (const [which, p] of [["start", a], ["end", b]] as const) {
          outlines.push(
            <div
              key={`${id}-${which}`}
              data-wb-handle={which}
              className="absolute left-0 top-0 h-6 w-6 -ml-3 -mt-3 grid place-items-center pointer-events-auto touch-none cursor-move"
              style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            >
              <span className="h-3.5 w-3.5 rounded-full bg-surface border-2 border-accent" />
            </div>,
          );
        }
      }
      continue;
    }
    const g = geomOf(s, id);
    if (g) outlines.push(<Outline key={id} g={g} vp={vp} color={accent} width={sel.length > 1 ? 1 : 1.5} />);
  }

  const bounds = sel.length > 1 ? selectionBounds(s, sel) : null;
  const anyLocked = sel.some((id) => s.items[id]?.locked);
  const lockBox = single && single.type !== "connector" ? geomBounds(geomOf(s, single.id)!) : bounds;

  // Quick connect: selected or hovered item, when idle.
  let qcItem: WbItem | null = null;
  if (s.canEdit && s.tool === "select" && !dragging && !s.editing && !s.marquee) {
    const cand = single ?? (s.hover && !sel.includes(s.hover) ? s.items[s.hover] : null) ?? null;
    if (cand && CONNECTABLE.includes(cand.type) && cand.type !== "frame" && !cand.locked) qcItem = cand;
  }
  const hoverItem = s.hover && !sel.includes(s.hover) ? s.items[s.hover] : null;
  const connecting = s.tool === "connector" || (dragging && sel.length === 1 && single?.type === "connector");

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {/* Other people's selections and edits. */}
      {Object.values(s.peers).flatMap((p) =>
        (p.editing ? [p.editing] : (p.sel ?? []).slice(0, 50)).map((id, i) => {
          const g = s.items[id] && s.items[id]!.type !== "connector" ? geomOf(s, id) : null;
          return g ? <Outline key={`${p.sid}-${id}`} g={g} vp={vp} color={p.color} width={2} label={i === 0 ? p.name : undefined} /> : null;
        }),
      )}

      {hoverItem && hoverItem.type !== "connector" && hoverItem.type !== "frame" && (
        <Outline g={geomOf(s, hoverItem.id)!} vp={vp} color={connecting || dragging ? accent : "rgb(var(--c-accent) / 0.5)"} width={connecting || dragging ? 2 : 1} />
      )}

      {outlines}

      {bounds && <Outline g={{ ...bounds, rotation: 0 }} vp={vp} color={accent} width={1} dashed />}

      {s.canEdit && !s.editing && !anyLocked && single && single.type !== "connector" && (
        <Handles g={geomOf(s, single.id)!} vp={vp} names={handlesFor(single)} rotatable={ROTATABLE.includes(single.type)} />
      )}
      {s.canEdit && !s.editing && !anyLocked && bounds && (
        <Handles g={{ ...bounds, rotation: 0 }} vp={vp} names={["nw", "ne", "se", "sw"]} rotatable />
      )}

      {anyLocked && lockBox && (
        <div
          className="absolute left-0 top-0 h-6 w-6 -mt-3 rounded-full bg-surface border border-border shadow-pop grid place-items-center text-muted"
          style={{ transform: `translate(${(lockBox.x + lockBox.w) * vp.zoom + vp.x - 12}px, ${lockBox.y * vp.zoom + vp.y}px)` }}
          title="Locked"
        >
          <Lock size={12} />
        </div>
      )}

      {qcItem && <QuickConnect it={qcItem} g={geomOf(s, qcItem.id)!} vp={vp} />}

      {s.marquee && (
        <div
          className="absolute left-0 top-0 border border-accent bg-accent/10 rounded-[2px]"
          style={{
            transform: `translate(${s.marquee.x * vp.zoom + vp.x}px, ${s.marquee.y * vp.zoom + vp.y}px)`,
            width: s.marquee.w * vp.zoom,
            height: s.marquee.h * vp.zoom,
          }}
        />
      )}

      {s.guides.map((gd, i) =>
        gd.axis === "x" ? (
          <div key={i} className="absolute top-0 w-px bg-accent" style={{ left: gd.at * vp.zoom + vp.x, top: gd.from * vp.zoom + vp.y, height: (gd.to - gd.from) * vp.zoom }} />
        ) : (
          <div key={i} className="absolute h-px bg-accent" style={{ top: gd.at * vp.zoom + vp.y, left: gd.from * vp.zoom + vp.x, width: (gd.to - gd.from) * vp.zoom }} />
        ),
      )}

      <Cursors />
    </div>
  );
}

function Cursors() {
  const peers = useWb((s) => s.peers);
  const vp = useWb((s) => s.viewport);
  return (
    <>
      {Object.values(peers).map((p) => {
        if (!p.cursor) return null;
        const sp = worldToScreen(p.cursor, vp);
        return (
          <div
            key={p.sid}
            className="absolute left-0 top-0 transition-transform duration-150 ease-linear will-change-transform"
            style={{ transform: `translate(${sp.x}px, ${sp.y}px)` }}
          >
            <svg width="18" height="20" viewBox="0 0 18 20" className="drop-shadow">
              <path d="M1 1 L1 16 L5.5 12 L8.5 19 L11 18 L8 11 L14 11 Z" fill={p.color} stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            <span className="absolute left-4 top-4 px-1.5 py-0.5 rounded-md text-[11px] font-medium text-white whitespace-nowrap shadow-card" style={{ background: p.color }}>
              {p.name}
            </span>
          </div>
        );
      })}
    </>
  );
}

export { center };
