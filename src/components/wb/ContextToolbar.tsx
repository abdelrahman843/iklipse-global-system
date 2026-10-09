import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Download,
  ArrowDownToLine,
  ArrowUpToLine,
  ExternalLink,
  Link2Off,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Lock,
  LockOpen,
  MessageCircle,
  Ellipsis,
  ChevronDown,
  Minus,
  MoveRight,
  CornerDownRight,
  Spline,
  ArrowLeftRight,
  Calendar,
  CheckCircle2,
  UserRound,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalSpaceAround,
  AlignVerticalSpaceAround,
  LayoutGrid,
  FileText,
} from "lucide-react";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { insertFrameCopy } from "@/lib/wb/slides";
import { downloadMedia } from "@/lib/wb/api";
import { exportPng } from "@/lib/wb/exportImage";
import { useToast } from "@/components/ui/Toast";
import { itemText, TYPE_NAMES } from "./comments/data";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import { useWb, patchItems, deleteItems, selectionBounds, geomOf } from "@/lib/wb/store";
import {
  align,
  bringToFront,
  copySelection,
  duplicate,
  frameAround,
  group,
  sendToBack,
  setLocked,
  shiftZ,
  ungroup,
  type AlignOp,
} from "@/lib/wb/actions";
import { SHAPES, shapePath } from "@/lib/wb/shapes";
import {
  ALL_COLORS,
  COLOR_NAMES,
  ROTATABLE,
  cssColor,
  num,
  str,
  type Cap,
  type ConnectorData,
  type ConnectorKind,
  type Dash,
  type FontFamily,
  type ShapeKind,
  type WbItem,
} from "@/lib/wb/types";
import { connectorGeometry } from "@/lib/wb/geometry";
import { useWbPeople } from "@/lib/wb/people";
import { Swatches, STICKY_COLORS } from "./Swatches";

// -----------------------------------------------------------------------------
// Floating toolbar above the selection (Miro's context menu bar): style
// controls for whatever is selected, plus lock / comment / more.
// -----------------------------------------------------------------------------

const S = useWb.getState;

const FONT_SIZES = [10, 12, 14, 16, 18, 24, 32, 36, 48, 64, 80, 96, 144];

function Btn({ on, title, onClick, children, className }: { on?: boolean; title: string; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-8 min-w-8 px-1.5 shrink-0 inline-flex items-center justify-center gap-1 rounded-md text-sm transition-colors",
        on ? "bg-accent-soft text-accent" : "text-ink hover:bg-inset",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-line mx-0.5 shrink-0" />;
}

function ColorDot({ c, ring }: { c: string; ring?: boolean }) {
  return (
    <span
      className={cn("h-4 w-4 rounded-full ring-1 ring-border inline-block", ring && "bg-transparent")}
      style={ring ? { boxShadow: `inset 0 0 0 3px ${cssColor(c)}` } : { background: c === "none" ? "transparent" : cssColor(c) }}
    />
  );
}

function ColorMenu({ value, onChange, title, colors = ALL_COLORS, allowNone, ring }: { value: string; onChange: (c: string) => void; title: string; colors?: readonly string[]; allowNone?: boolean; ring?: boolean }) {
  return (
    <Menu
      trigger={
        <Btn title={`${title}: ${COLOR_NAMES[value] ?? value}`}>
          <ColorDot c={value} ring={ring} />
        </Btn>
      }
    >
      {(close) => (
        <div className="p-2.5" data-wb-ui>
          <div className="text-xs text-subtle mb-2">{title}</div>
          <Swatches
            value={value}
            colors={colors}
            allowNone={allowNone}
            columns={7}
            onChange={(c) => {
              onChange(c);
              close();
            }}
          />
        </div>
      )}
    </Menu>
  );
}

export function ContextToolbar({ onComment }: { onComment: (id: string) => void }) {
  const sel = useWb((s) => s.selection);
  const items = useWb((s) => s.items);
  const vp = useWb((s) => s.viewport);
  const dragging = useWb((s) => Object.keys(s.live).length > 0 || !!s.marquee);
  const canEdit = useWb((s) => s.canEdit);
  const canComment = useWb((s) => s.canComment);
  const canCopy = useWb((s) => s.canCopy);
  const screen = useWb((s) => s.screen);
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  // Measured width keeps the bar fully on screen (phones especially).
  const barRef = useRef<HTMLDivElement>(null);
  const [barW, setBarW] = useState(0);
  useLayoutEffect(() => {
    const w = barRef.current?.offsetWidth ?? 0;
    if (w && Math.abs(w - barW) > 1) setBarW(w);
  });
  const list = sel.map((id) => items[id]).filter((x): x is WbItem => !!x);
  if (!list.length || dragging) return null;

  const s = S();
  let b = selectionBounds(s, sel);
  if (list.length === 1 && list[0]!.type === "connector") {
    b = connectorGeometry(list[0]!.data as ConnectorData, (id) => geomOf(s, id)).bounds;
  }
  if (!b) return null;
  const top = b.y * vp.zoom + vp.y;
  const bottom = (b.y + b.h) * vp.zoom + vp.y;
  const cx = (b.x + b.w / 2) * vp.zoom + vp.x;
  const above = top > 70;
  // Below the selection, clear the rotate handle (it sits under single items).
  const handleRoom = list.length === 1 && ROTATABLE.includes(list[0]!.type) ? 62 : 18;
  const y = above ? top - 54 : Math.min(bottom + handleRoom, screen.h - 60);
  const left = Math.max(8, Math.min(cx - barW / 2, screen.w - barW - 8));

  const types = new Set(list.map((i) => i.type));
  const only = types.size === 1 ? list[0]!.type : null;
  const first = list[0]!;
  const locked = list.every((i) => i.locked);
  const ids = list.map((i) => i.id);
  const setData = (data: Record<string, unknown>, key?: string) => patchItems(ids, () => ({ data }), key ? { key } : undefined);
  const editable = canEdit && !locked;

  return (
    <div
      data-wb-ui
      ref={barRef}
      className="absolute z-20 flex items-center gap-0.5 p-1 bg-surface border border-border rounded-lg shadow-raise max-w-[calc(100%-16px)] overflow-x-auto [scrollbar-width:none] animate-fade-in"
      style={{ left, top: Math.max(8, y), visibility: barW ? undefined : "hidden" }}
      onPointerDown={(e) => {
        e.stopPropagation();
        // Keep the text editor focused while formatting.
        if ((e.target as HTMLElement).closest("button")) e.preventDefault();
      }}
    >
      {editable && only === "sticky" && <StickyControls first={first} setData={setData} />}
      {editable && only === "shape" && <ShapeControls first={first} setData={setData} />}
      {editable && only === "text" && <TextControls first={first} setData={setData} />}
      {editable && only === "connector" && <ConnectorControls first={first} setData={setData} ids={ids} />}
      {editable && only === "frame" && (
        <>
          <ColorMenu title="Background" value={str(first.data.fill, "surface")} onChange={(c) => setData({ fill: c })} />
          {list.length === 1 && !locked && (
            <>
              <Btn title="Add a copy before this frame" onClick={() => insertFrameCopy(first.id, "before")}>
                <ArrowUpToLine size={15} />
              </Btn>
              <Btn title="Add a copy after this frame" onClick={() => insertFrameCopy(first.id, "after")} className="px-2 font-medium">
                <ArrowDownToLine size={15} /> Add next
              </Btn>
            </>
          )}
          <Sep />
        </>
      )}
      {editable && only === "pen" && (
        <>
          <ColorMenu title="Colour" value={str(first.data.color, "ink")} onChange={(c) => setData({ color: c })} />
          <Menu trigger={<Btn title="Thickness">{num(first.data.width, 3)}px <ChevronDown size={12} /></Btn>}>
            {(close) =>
              [1, 2, 3, 4, 6, 8, 12, 16, 24].map((w) => (
                <MenuItem key={w} onClick={() => (setData({ width: w }), close())}>
                  {w}px
                </MenuItem>
              ))
            }
          </Menu>
          <Sep />
        </>
      )}
      {editable && only === "card" && <CardControls first={first} setData={setData} />}
      {only === "embed" && list.length === 1 && str(first.data.url) && (
        <>
          <Btn title="Open in a new tab" onClick={() => window.open(str(first.data.url), "_blank", "noopener,noreferrer")} className="px-2.5 font-medium">
            <ExternalLink size={15} className="text-accent" /> Open link
          </Btn>
          {editable && (
            <Btn title="Change the link" onClick={() => setData({ url: "" })}>
              <Link2Off size={15} />
            </Btn>
          )}
          <Sep />
        </>
      )}
      {only === "doc" && list.length === 1 && (
        <>
          <Btn title="Open doc" onClick={() => useWb.setState({ openDoc: first.id })} className="px-2.5 font-medium">
            <FileText size={15} className="text-accent" /> Open
          </Btn>
          <Sep />
        </>
      )}

      {editable && list.length > 1 && types.size >= 1 && !only?.match(/connector/) && <AlignMenu />}

      {canEdit && (
        <Btn title={locked ? "Unlock" : "Lock"} on={locked} onClick={() => setLocked(!locked, ids)}>
          {locked ? <Lock size={15} /> : <LockOpen size={15} />}
        </Btn>
      )}
      {canCopy && (
        <Btn
          title={list.length === 1 && str(first.data.path) ? "Download" : "Download as image"}
          onClick={async () => {
            if (saving) return;
            setSaving(true);
            try {
              // An image or uploaded video: the original file. Anything else: a PNG of the selection.
              if (list.length === 1 && str(first.data.path)) await downloadMedia(str(first.data.path), str(first.data.name, first.type === "image" ? "Image" : "Video"));
              else await exportPng({ ids, title: list.length === 1 ? itemText(first).slice(0, 60) || TYPE_NAMES[first.type] : "Selection" });
            } catch (e) {
              toast.push({ kind: "error", title: "Couldn't download", description: (e as Error).message });
            } finally {
              setSaving(false);
            }
          }}
        >
          <Download size={15} className={cn(saving && "animate-pulse")} />
        </Btn>
      )}
      {canComment && list.length === 1 && (
        <Btn title="Comment" onClick={() => onComment(first.id)}>
          <MessageCircle size={15} />
        </Btn>
      )}
      <Menu
        align="right"
        trigger={
          <Btn title="More">
            <Ellipsis size={16} />
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="min-w-[200px]">
            {canEdit && !locked && (
              <>
                <MenuItem onClick={() => (duplicate(), close())}>
                  <Row>Duplicate</Row>
                </MenuItem>
                <MenuItem onClick={() => (void copySelection(), close())}>
                  <Row k="Ctrl+C">Copy</Row>
                </MenuItem>
                {list.length > 1 && (
                  <MenuItem onClick={() => (group(), close())}>
                    <Row>Group</Row>
                  </MenuItem>
                )}
                {list.some((i) => i.group_id) && (
                  <MenuItem onClick={() => (ungroup(), close())}>
                    <Row>Ungroup</Row>
                  </MenuItem>
                )}
                {!types.has("frame") && (
                  <MenuItem onClick={() => (frameAround(), close())}>
                    <Row>Create frame</Row>
                  </MenuItem>
                )}
                <MenuDivider />
                <MenuItem onClick={() => (bringToFront(), close())}>
                  <Row>Bring to front</Row>
                </MenuItem>
                <MenuItem onClick={() => (shiftZ(1), close())}>
                  <Row>Bring forward</Row>
                </MenuItem>
                <MenuItem onClick={() => (shiftZ(-1), close())}>
                  <Row>Send backward</Row>
                </MenuItem>
                <MenuItem onClick={() => (sendToBack(), close())}>
                  <Row>Send to back</Row>
                </MenuItem>
                <MenuDivider />
              </>
            )}
            <MenuItem
              onClick={() => {
                const url = `${location.origin}${location.pathname}#/wb/${S().boardId}?item=${first.id}`;
                void navigator.clipboard?.writeText(url).catch(() => undefined);
                close();
              }}
            >
              Copy link to object
            </MenuItem>
            {canEdit && !locked && (
              <>
                <MenuDivider />
                <MenuItem destructive onClick={() => (deleteItems(ids), close())}>
                  <Row k="Del">Delete</Row>
                </MenuItem>
              </>
            )}
          </div>
        )}
      </Menu>
    </div>
  );
}

function Row({ children, k }: { children: ReactNode; k?: string }) {
  return (
    <span className="flex items-center gap-6 justify-between w-full">
      <span>{children}</span>
      {k && <span className="text-xs text-subtle">{k}</span>}
    </span>
  );
}

type SetData = (d: Record<string, unknown>, key?: string) => void;

function TextStyleButtons({ first, setData }: { first: WbItem; setData: SetData }) {
  const d = first.data;
  const alignNow = str(d.align, first.type === "text" ? "left" : "center");
  return (
    <>
      <Btn title="Bold" on={d.bold === true} onClick={() => setData({ bold: d.bold ? undefined : true })}>
        <Bold size={15} />
      </Btn>
      <Btn title="Italic" on={d.italic === true} onClick={() => setData({ italic: d.italic ? undefined : true })}>
        <Italic size={15} />
      </Btn>
      <Btn title="Underline" on={d.underline === true} onClick={() => setData({ underline: d.underline ? undefined : true })}>
        <Underline size={15} />
      </Btn>
      <Btn title="Strikethrough" on={d.strike === true} onClick={() => setData({ strike: d.strike ? undefined : true })}>
        <Strikethrough size={15} />
      </Btn>
      <Menu
        trigger={
          <Btn title="Alignment">
            {alignNow === "left" ? <AlignLeft size={15} /> : alignNow === "right" ? <AlignRight size={15} /> : <AlignCenter size={15} />}
          </Btn>
        }
      >
        {(close) => (
          <div className="flex p-1 gap-0.5" data-wb-ui>
            {(["left", "center", "right"] as const).map((a) => (
              <Btn key={a} title={`Align ${a}`} on={alignNow === a} onClick={() => (setData({ align: a }), close())}>
                {a === "left" ? <AlignLeft size={15} /> : a === "right" ? <AlignRight size={15} /> : <AlignCenter size={15} />}
              </Btn>
            ))}
          </div>
        )}
      </Menu>
    </>
  );
}

function FontSizeMenu({ first, setData, allowAuto }: { first: WbItem; setData: SetData; allowAuto?: boolean }) {
  const v = first.data.fontSize;
  const label = v === "auto" || v == null ? (allowAuto ? "Auto" : "16") : String(v);
  return (
    <Menu
      trigger={
        <Btn title="Font size" className="min-w-12">
          {label} <ChevronDown size={12} />
        </Btn>
      }
    >
      {(close) => (
        <div data-wb-ui className="max-h-72 overflow-auto">
          {allowAuto && (
            <MenuItem onClick={() => (setData({ fontSize: "auto" }), close())}>
              <span className={cn(label === "Auto" && "text-accent font-medium")}>Auto</span>
            </MenuItem>
          )}
          {FONT_SIZES.map((n) => (
            <MenuItem key={n} onClick={() => (setData({ fontSize: n }), close())}>
              <span className={cn(String(n) === label && "text-accent font-medium")}>{n}</span>
            </MenuItem>
          ))}
        </div>
      )}
    </Menu>
  );
}

function FontMenu({ first, setData }: { first: WbItem; setData: SetData }) {
  const f = (first.data.font as FontFamily) ?? "sans";
  const names: Record<FontFamily, string> = { sans: "Sans", serif: "Serif", mono: "Mono" };
  return (
    <Menu trigger={<Btn title="Font">{names[f]} <ChevronDown size={12} /></Btn>}>
      {(close) =>
        (Object.keys(names) as FontFamily[]).map((k) => (
          <MenuItem key={k} onClick={() => (setData({ font: k === "sans" ? undefined : k }), close())}>
            <span className={cn(k === f && "text-accent font-medium")}>{names[k]}</span>
          </MenuItem>
        ))
      }
    </Menu>
  );
}

function StickyControls({ first, setData }: { first: WbItem; setData: SetData }) {
  return (
    <>
      <ColorMenu title="Sticky colour" colors={STICKY_COLORS} value={str(first.data.fill, "#f5cd47")} onChange={(c) => setData({ fill: c })} />
      <FontSizeMenu first={first} setData={setData} allowAuto />
      <TextStyleButtons first={first} setData={setData} />
      <Btn title="Show author" on={first.data.showAuthor === true} onClick={() => setData({ showAuthor: first.data.showAuthor ? undefined : true })}>
        <UserRound size={15} />
      </Btn>
      <Sep />
    </>
  );
}

function ShapeControls({ first, setData }: { first: WbItem; setData: SetData }) {
  const kind = (first.data.shape as ShapeKind) ?? "rect";
  const sw = num(first.data.strokeWidth, 2);
  return (
    <>
      <Menu
        trigger={
          <Btn title="Shape">
            <svg width="16" height="16" viewBox="-1 -1 18 18" className="overflow-visible">
              <path d={shapePath(kind, 16, 16)} fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <ChevronDown size={12} />
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="grid grid-cols-5 gap-1 p-2 w-[230px]">
            {SHAPES.map((sh) => (
              <button
                key={sh.kind}
                title={sh.label}
                onClick={() => (setData({ shape: sh.kind }), close())}
                className={cn("h-10 w-10 grid place-items-center rounded-md hover:bg-inset", kind === sh.kind && "bg-accent-soft")}
              >
                <svg width="22" height="22" viewBox="-2 -2 26 26" className="overflow-visible">
                  <path d={shapePath(sh.kind, 22, 22)} fill="none" stroke="rgb(var(--c-ink))" strokeWidth="1.5" />
                </svg>
              </button>
            ))}
          </div>
        )}
      </Menu>
      <ColorMenu title="Fill" value={str(first.data.fill, "surface")} allowNone onChange={(c) => setData({ fill: c })} />
      <Menu
        trigger={
          <Btn title="Border">
            <ColorDot c={str(first.data.stroke, "ink")} ring />
            <ChevronDown size={12} />
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="p-2.5 w-[230px]">
            <div className="text-xs text-subtle mb-2">Border colour</div>
            <Swatches value={str(first.data.stroke, "ink")} columns={7} onChange={(c) => setData({ stroke: c })} />
            <div className="text-xs text-subtle mt-3 mb-1.5">Thickness</div>
            <div className="flex gap-1 flex-wrap">
              {[0, 1, 2, 4, 6, 8, 12].map((w) => (
                <Btn key={w} title={w ? `${w}px` : "No border"} on={sw === w} onClick={() => setData({ strokeWidth: w })}>
                  {w || "None"}
                </Btn>
              ))}
            </div>
            <DashRow value={(first.data.dash as Dash) ?? "solid"} onChange={(v) => (setData({ dash: v }), close())} />
          </div>
        )}
      </Menu>
      <ColorMenu title="Text colour" value={str(first.data.color, "ink")} onChange={(c) => setData({ color: c })} />
      <FontSizeMenu first={first} setData={setData} allowAuto />
      <TextStyleButtons first={first} setData={setData} />
      <Sep />
    </>
  );
}

function DashRow({ value, onChange }: { value: Dash; onChange: (d: Dash) => void }) {
  return (
    <>
      <div className="text-xs text-subtle mt-3 mb-1.5">Style</div>
      <div className="flex gap-1">
        {(["solid", "dashed", "dotted"] as Dash[]).map((d) => (
          <Btn key={d} title={d} on={value === d} onClick={() => onChange(d)} className="w-14">
            <svg width="36" height="4">
              <line x1="0" y1="2" x2="36" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray={d === "dashed" ? "6 4" : d === "dotted" ? "2 3" : undefined} />
            </svg>
          </Btn>
        ))}
      </div>
    </>
  );
}

function TextControls({ first, setData }: { first: WbItem; setData: SetData }) {
  return (
    <>
      <FontMenu first={first} setData={setData} />
      <FontSizeMenu first={first} setData={setData} />
      <ColorMenu title="Text colour" value={str(first.data.color, "ink")} onChange={(c) => setData({ color: c })} />
      <ColorMenu title="Highlight" value={str(first.data.fill, "none")} allowNone onChange={(c) => setData({ fill: c === "none" ? undefined : c })} />
      <TextStyleButtons first={first} setData={setData} />
      <Sep />
    </>
  );
}

const CAPS: { v: Cap; label: string }[] = [
  { v: "none", label: "None" },
  { v: "arrow", label: "Arrow" },
  { v: "triangle", label: "Triangle" },
  { v: "circle", label: "Circle" },
  { v: "diamond", label: "Diamond" },
  { v: "bar", label: "Bar" },
];

function ConnectorControls({ first, setData, ids }: { first: WbItem; setData: SetData; ids: string[] }) {
  const d = first.data as ConnectorData;
  const kind = d.kind ?? "curved";
  return (
    <>
      <Menu
        trigger={
          <Btn title="Line type">
            {kind === "straight" ? <Minus size={15} className="-rotate-45" /> : kind === "elbow" ? <CornerDownRight size={15} /> : <Spline size={15} />}
            <ChevronDown size={12} />
          </Btn>
        }
      >
        {(close) =>
          (
            [
              ["straight", "Straight"],
              ["elbow", "Elbowed"],
              ["curved", "Curved"],
            ] as [ConnectorKind, string][]
          ).map(([k, l]) => (
            <MenuItem key={k} onClick={() => (setData({ kind: k }), close())}>
              <span className={cn(kind === k && "text-accent font-medium")}>{l}</span>
            </MenuItem>
          ))
        }
      </Menu>
      <CapMenu title="Start" value={(d.startCap as Cap) ?? "none"} onChange={(c) => setData({ startCap: c })} flip />
      <CapMenu title="End" value={(d.endCap as Cap) ?? "arrow"} onChange={(c) => setData({ endCap: c })} />
      <Btn
        title="Swap direction"
        onClick={() => patchItems(ids, (it) => ({ data: { start: it.data.end, end: it.data.start, startCap: it.data.endCap ?? "arrow", endCap: it.data.startCap ?? "none" } }))}
      >
        <ArrowLeftRight size={15} />
      </Btn>
      <ColorMenu title="Line colour" value={str(d.color, "ink")} onChange={(c) => setData({ color: c })} />
      <Menu
        trigger={
          <Btn title="Thickness and style">
            {num(d.width, 2)}px <ChevronDown size={12} />
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="p-2.5 w-[220px]">
            <div className="text-xs text-subtle mb-1.5">Thickness</div>
            <div className="flex gap-1 flex-wrap">
              {[1, 2, 3, 4, 6, 8, 12].map((w) => (
                <Btn key={w} title={`${w}px`} on={num(d.width, 2) === w} onClick={() => setData({ width: w })}>
                  {w}
                </Btn>
              ))}
            </div>
            <DashRow value={(d.dash as Dash) ?? "solid"} onChange={(v) => (setData({ dash: v }), close())} />
          </div>
        )}
      </Menu>
      <Sep />
    </>
  );
}

function CapMenu({ title, value, onChange, flip }: { title: string; value: Cap; onChange: (c: Cap) => void; flip?: boolean }) {
  return (
    <Menu
      trigger={
        <Btn title={`${title} point`}>
          {value === "none" ? <Minus size={15} /> : <MoveRight size={15} className={cn(flip && "rotate-180")} />}
          <ChevronDown size={12} />
        </Btn>
      }
    >
      {(close) =>
        CAPS.map((c) => (
          <MenuItem key={c.v} onClick={() => (onChange(c.v), close())}>
            <span className={cn(value === c.v && "text-accent font-medium")}>{c.label}</span>
          </MenuItem>
        ))
      }
    </Menu>
  );
}

function CardControls({ first, setData }: { first: WbItem; setData: SetData }) {
  const people = useWbPeople();
  const d = first.data as { assignee?: string | null; due?: string | null; done?: boolean; description?: string; fill?: string };
  const who = d.assignee ? people.data?.byId.get(d.assignee) : null;
  const [q, setQ] = useState("");
  return (
    <>
      <ColorMenu title="Colour" value={str(d.fill, "#579dff")} onChange={(c) => setData({ fill: c })} />
      <Menu
        trigger={
          <Btn title="Assignee">
            {who ? <Avatar name={who.display_name} src={who.avatar_url} size={20} /> : <UserRound size={15} />}
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="w-60">
            <div className="p-2">
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search people"
                className="w-full h-8 px-2 rounded-md border border-border bg-surface text-sm text-ink outline-none focus:border-accent"
              />
            </div>
            <div className="max-h-64 overflow-auto">
              {d.assignee && (
                <MenuItem onClick={() => (setData({ assignee: null }), close())}>Remove assignee</MenuItem>
              )}
              {(people.data?.list ?? [])
                .filter((p) => p.is_active && (p.display_name + p.username).toLowerCase().includes(q.toLowerCase()))
                .slice(0, 50)
                .map((p) => (
                  <MenuItem key={p.id} onClick={() => (setData({ assignee: p.id }), close())}>
                    <span className="flex items-center gap-2">
                      <Avatar name={p.display_name} src={p.avatar_url} size={20} />
                      <span className={cn(p.id === d.assignee && "text-accent font-medium")}>{p.display_name}</span>
                    </span>
                  </MenuItem>
                ))}
            </div>
          </div>
        )}
      </Menu>
      <Menu
        trigger={
          <Btn title="Due date" on={!!d.due}>
            <Calendar size={15} />
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="p-2.5 flex flex-col gap-2 w-56">
            <input
              type="date"
              defaultValue={d.due ?? ""}
              onChange={(e) => setData({ due: e.target.value || null })}
              className="h-9 px-2 rounded-md border border-border bg-surface text-sm text-ink outline-none focus:border-accent"
            />
            {d.due && (
              <button className="text-sm text-danger text-left" onClick={() => (setData({ due: null }), close())}>
                Remove date
              </button>
            )}
          </div>
        )}
      </Menu>
      <Btn title={d.done ? "Mark not done" : "Mark done"} on={d.done === true} onClick={() => setData({ done: d.done ? undefined : true })}>
        <CheckCircle2 size={15} />
      </Btn>
      <Menu
        trigger={
          <Btn title="Description" on={!!d.description}>
            <FileText size={15} />
          </Btn>
        }
      >
        {() => (
          <div data-wb-ui className="p-2.5 w-72">
            <textarea
              autoFocus
              defaultValue={d.description ?? ""}
              rows={6}
              maxLength={5000}
              placeholder="Add a description"
              onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => setData({ description: e.target.value.trim() || undefined })}
              className="w-full p-2 rounded-md border border-border bg-surface text-sm text-ink outline-none focus:border-accent resize-y"
            />
          </div>
        )}
      </Menu>
      <Sep />
    </>
  );
}

function AlignMenu() {
  const ops: [AlignOp, ReactNode, string][] = [
    ["left", <AlignStartVertical key="l" size={15} />, "Align left"],
    ["hcenter", <AlignCenterVertical key="hc" size={15} />, "Align centre"],
    ["right", <AlignEndVertical key="r" size={15} />, "Align right"],
    ["top", <AlignStartHorizontal key="t" size={15} />, "Align top"],
    ["vmiddle", <AlignCenterHorizontal key="m" size={15} />, "Align middle"],
    ["bottom", <AlignEndHorizontal key="b" size={15} />, "Align bottom"],
    ["hspace", <AlignHorizontalSpaceAround key="hs" size={15} />, "Distribute horizontally"],
    ["vspace", <AlignVerticalSpaceAround key="vs" size={15} />, "Distribute vertically"],
  ];
  return (
    <>
      <Menu
        trigger={
          <Btn title="Align and distribute">
            <LayoutGrid size={15} />
            <ChevronDown size={12} />
          </Btn>
        }
      >
        {(close) => (
          <div data-wb-ui className="grid grid-cols-4 gap-0.5 p-1">
            {ops.map(([op, icon, label]) => (
              <Btn key={op} title={label} onClick={() => (align(op), close())}>
                {icon}
              </Btn>
            ))}
          </div>
        )}
      </Menu>
      <Sep />
    </>
  );
}
