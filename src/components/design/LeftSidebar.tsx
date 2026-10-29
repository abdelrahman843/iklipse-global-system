import { useEffect, useMemo, useState, type ReactNode } from "react";
import { imageUrl } from "@/lib/wb/api";
import {
  ChevronDown,
  ChevronRight,
  Circle,
  Component,
  Copy,
  Diamond,
  Eye,
  EyeOff,
  Frame,
  Group,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Minus,
  MoveRight,
  Pentagon,
  Plus,
  Spline,
  Square,
  Star,
  Trash2,
  Type,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { addNode, addPage, deletePage, duplicatePage, imagesInDoc, insertInstance, moveLayer, movePage, renamePage, toggle, viewCenter } from "@/lib/design/actions";
import { detachStyle, isVirtual, shortId } from "@/lib/design/doc";
import type { RNode } from "@/lib/design/layout";
import { resolved, select, toggleSelect, tx, useDesign } from "@/lib/design/store";
import type { NodeType, Token } from "@/lib/design/types";
import { ColorField, IconBtn, NumField, TextField } from "./fields";
import { ICONS, insertIcon } from "./icons";

// -----------------------------------------------------------------------------
// Left sidebar: pages and the layers tree, or assets (components, styles,
// tokens, images, icons).
// -----------------------------------------------------------------------------

const S = useDesign.getState;
const set = useDesign.setState;

export function LeftSidebar() {
  const tab = useDesign((s) => s.leftTab);
  return (
    <aside data-design-ui className="w-[248px] shrink-0 bg-surface border-r border-border flex flex-col min-h-0" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex h-10 border-b border-border px-2 gap-1 items-center">
        {(["layers", "assets"] as const).map((t) => (
          <button key={t} className={cn("h-7 px-2.5 rounded text-xs font-medium", tab === t ? "bg-hover text-ink" : "text-muted hover:text-ink")} onClick={() => set({ leftTab: t })}>
            {t === "layers" ? "Layers" : "Assets"}
          </button>
        ))}
      </div>
      {tab === "layers" ? (
        <>
          <Pages />
          <Layers />
        </>
      ) : (
        <Assets />
      )}
    </aside>
  );
}

// ------------------------------------------------------------------- pages --
function Pages() {
  const pages = useDesign((s) => s.doc.data.pages);
  const page = useDesign((s) => s.page);
  const canEdit = useDesign((s) => s.canEdit);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="border-b border-border">
      <div className="flex items-center justify-between h-8 px-2">
        <button className="flex items-center gap-1 text-[11px] font-semibold text-ink" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Pages
        </button>
        {canEdit && (
          <IconBtn title="Add page" onClick={addPage}>
            <Plus size={13} />
          </IconBtn>
        )}
      </div>
      {open && (
        <ul className="pb-1 max-h-40 overflow-auto">
          {pages.map((p, i) => (
            <li
              key={p.id}
              className={cn("group flex items-center h-7 px-3 text-xs cursor-default", p.id === page ? "bg-accent-soft text-ink font-medium" : "text-muted hover:bg-hover")}
              onClick={() => set({ page: p.id, selection: [], editingText: null })}
              onDoubleClick={() => canEdit && setEditing(p.id)}
            >
              {editing === p.id ? (
                <TextField
                  value={p.name}
                  onChange={(v) => {
                    renamePage(p.id, v);
                    setEditing(null);
                  }}
                />
              ) : (
                <span className="truncate flex-1">{p.name}</span>
              )}
              {canEdit && editing !== p.id && (
                <span className="hidden group-hover:flex items-center">
                  <IconBtn title="Move up" onClick={() => movePage(p.id, -1)} disabled={i === 0}>
                    <ArrowUp size={11} />
                  </IconBtn>
                  <IconBtn title="Move down" onClick={() => movePage(p.id, 1)} disabled={i === pages.length - 1}>
                    <ArrowDown size={11} />
                  </IconBtn>
                  <IconBtn title="Duplicate page" onClick={() => duplicatePage(p.id)}>
                    <Copy size={11} />
                  </IconBtn>
                  <IconBtn title="Delete page" onClick={() => confirm(`Delete "${p.name}" and everything on it?`) && deletePage(p.id)} disabled={pages.length < 2}>
                    <Trash2 size={11} />
                  </IconBtn>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ layers --
export const TYPE_ICON: Record<NodeType, ReactNode> = {
  frame: <Frame size={12} />,
  group: <Group size={12} />,
  rect: <Square size={12} />,
  ellipse: <Circle size={12} />,
  line: <Minus size={12} />,
  arrow: <MoveRight size={12} />,
  polygon: <Pentagon size={12} />,
  star: <Star size={12} />,
  path: <Spline size={12} />,
  text: <Type size={12} />,
  image: <ImageIcon size={12} />,
  component: <Component size={12} />,
  instance: <Diamond size={12} />,
};

function Layers() {
  const doc = useDesign((s) => s.doc);
  const page = useDesign((s) => s.page);
  const { roots } = useMemo(() => resolved(doc, page), [doc, page]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<{ id: string; where: "before" | "after" | "inside" } | null>(null);
  const dragId = useState<{ id: string | null }>({ id: null })[0];
  const rows: { n: RNode; depth: number }[] = [];
  const visit = (ns: RNode[], depth: number) => {
    // Front-most first, like the canvas stacking reads top-down.
    for (let i = ns.length - 1; i >= 0; i--) {
      const n = ns[i]!;
      rows.push({ n, depth });
      if (n.children.length && !collapsed.has(n.rid)) visit(n.children, depth + 1);
    }
  };
  visit(roots, 0);
  const selection = useDesign((s) => s.selection);
  const hover = useDesign((s) => s.hover);
  const canEdit = useDesign((s) => s.canEdit);
  if (!rows.length) return <p className="p-3 text-xs text-subtle">No layers on this page yet. Pick a tool above (F = frame) and draw.</p>;
  return (
    <ul className="flex-1 overflow-auto py-1 text-xs" onMouseLeave={() => set({ hover: null })}>
      {rows.map(({ n, depth }) => {
        const sel = selection.includes(n.rid);
        const virtual = isVirtual(n.rid);
        const kids = n.children.length > 0;
        return (
          <li
            key={n.rid}
            draggable={canEdit && !virtual}
            onDragStart={(e) => {
              dragId.id = n.rid;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!dragId.id || virtual || dragId.id === n.rid) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const f = (e.clientY - r.top) / r.height;
              const container = n.type === "frame" || n.type === "group" || n.type === "component";
              setDrop({ id: n.rid, where: container && f > 0.3 && f < 0.7 ? "inside" : f < 0.5 ? "before" : "after" });
            }}
            onDragLeave={() => setDrop(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId.id && drop) moveLayer(dragId.id, drop.id, drop.where);
              dragId.id = null;
              setDrop(null);
            }}
            onDragEnd={() => {
              dragId.id = null;
              setDrop(null);
            }}
            onMouseEnter={() => set({ hover: n.rid })}
            onClick={(e) => (e.shiftKey || e.metaKey || e.ctrlKey ? toggleSelect(n.rid) : select([n.rid]))}
            className={cn(
              "group relative flex items-center h-7 pr-1 cursor-default",
              sel ? "bg-accent-soft" : hover === n.rid ? "bg-hover" : "",
              drop?.id === n.rid && drop.where === "inside" && "ring-1 ring-inset ring-accent",
              n.visible === false && "opacity-50",
            )}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            {drop?.id === n.rid && drop.where !== "inside" && <span className={cn("absolute left-2 right-2 h-0.5 bg-accent", drop.where === "before" ? "top-0" : "bottom-0")} />}
            <button
              className={cn("w-4 h-4 grid place-items-center text-subtle shrink-0", !kids && "invisible")}
              onClick={(e) => {
                e.stopPropagation();
                const next = new Set(collapsed);
                if (next.has(n.rid)) next.delete(n.rid);
                else next.add(n.rid);
                setCollapsed(next);
              }}
            >
              {collapsed.has(n.rid) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
            <span className={cn("w-4 shrink-0 grid place-items-center", n.type === "component" || n.type === "instance" || virtual ? "text-[#9747FF]" : "text-muted")}>{TYPE_ICON[n.type]}</span>
            <LayerName n={n} editable={canEdit && !virtual} />
            {!virtual && canEdit && (
              <span className={cn("ml-auto items-center", n.locked || n.visible === false ? "flex" : "hidden group-hover:flex")}>
                <IconBtn title={n.locked ? "Unlock" : "Lock"} onClick={() => toggle("locked", [n.rid])}>
                  {n.locked ? <Lock size={11} /> : <LockOpen size={11} />}
                </IconBtn>
                <IconBtn title={n.visible === false ? "Show" : "Hide"} onClick={() => toggle("visible", [n.rid])}>
                  {n.visible === false ? <EyeOff size={11} /> : <Eye size={11} />}
                </IconBtn>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LayerName({ n, editable }: { n: RNode; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <div className="flex-1 min-w-0 pl-1" onClick={(e) => e.stopPropagation()}>
        <TextField
          value={n.name}
          onChange={(v) => {
            setEditing(false);
            if (v.trim() && v !== n.name) tx("Rename", (d) => d.patch(n.rid, { name: v.slice(0, 200) }));
          }}
        />
      </div>
    );
  return (
    <span className="truncate pl-1 flex-1 min-w-0 text-ink" onDoubleClick={() => editable && setEditing(true)}>
      {n.name}
    </span>
  );
}

// ------------------------------------------------------------------ assets --
function Assets() {
  return (
    <div className="flex-1 overflow-auto">
      <ComponentsAsset />
      <ColorStyles />
      <TextStyles />
      <Tokens />
      <ImagesAsset />
      <IconsAsset />
    </div>
  );
}

function AssetSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-border">
      <div className="flex items-center justify-between h-8 px-2">
        <button className="flex items-center gap-1 text-[11px] font-semibold text-ink" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {title}
        </button>
        {action}
      </div>
      {open && <div className="px-2 pb-2 space-y-1">{children}</div>}
    </section>
  );
}

function ComponentsAsset() {
  const doc = useDesign((s) => s.doc);
  const canEdit = useDesign((s) => s.canEdit);
  const comps = Object.values(doc.nodes).filter((n) => n.type === "component");
  const library = new Set(doc.data.library ?? []);
  const [q, setQ] = useState("");
  const shown = comps.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).sort((a, b) => Number(library.has(b.id)) - Number(library.has(a.id)) || a.name.localeCompare(b.name));
  return (
    <AssetSection title="Components">
      {comps.length > 4 && <TextField value={q} onChange={setQ} placeholder="Search components" />}
      {!comps.length && <p className="text-[11px] text-subtle">Select layers and press Ctrl+Alt+K to make a component.</p>}
      {shown.map((c) => (
        <button
          key={c.id}
          draggable={canEdit}
          onDragStart={(e) => e.dataTransfer.setData("application/x-design-component", c.id)}
          disabled={!canEdit}
          onClick={() => insertInstance(c.id)}
          className="w-full flex items-center gap-2 h-8 px-2 rounded hover:bg-hover text-left text-xs text-ink disabled:hover:bg-transparent"
          title={canEdit ? "Click or drag onto the canvas to add an instance" : c.name}
        >
          <Component size={13} className="text-[#9747FF] shrink-0" />
          <span className="truncate flex-1">{c.name}</span>
          {library.has(c.id) && <span className="text-[10px] text-subtle">Library</span>}
          <span className="text-[10px] text-subtle">{doc.data.pages.find((p) => p.id === c.page)?.name}</span>
        </button>
      ))}
    </AssetSection>
  );
}

function firstSelectedColor(): string {
  const s = S();
  for (const id of s.selection) {
    const r = resolved().byId.get(id);
    const f = r?.fills.find((p) => p.type === "solid");
    if (f?.type === "solid") return f.color;
  }
  return "#0C8CE9";
}

function ColorStyles() {
  const colors = useDesign((s) => s.doc.data.colors);
  const canEdit = useDesign((s) => s.canEdit);
  return (
    <AssetSection
      title="Colour styles"
      action={
        canEdit && (
          <IconBtn title="New colour style from selection" onClick={() => tx("Add colour style", (d) => d.setData((x) => ({ ...x, colors: [...x.colors, { id: shortId(), name: `Colour ${x.colors.length + 1}`, color: firstSelectedColor() }] })))}>
            <Plus size={13} />
          </IconBtn>
        )
      }
    >
      {colors.map((c) => (
        <div key={c.id} className="flex items-center gap-1">
          <ColorField color={c.color} onChange={(v) => tx("Edit colour style", (d) => d.setData((x) => ({ ...x, colors: x.colors.map((y) => (y.id === c.id ? { ...y, color: v } : y)) })))} />
          <div className="w-20">
            <TextField value={c.name} onChange={(v) => tx("Rename style", (d) => d.setData((x) => ({ ...x, colors: x.colors.map((y) => (y.id === c.id ? { ...y, name: v.slice(0, 80) || y.name } : y)) })))} />
          </div>
          {canEdit && (
            <IconBtn
              title="Delete style (layers keep the colour)"
              onClick={() =>
                tx("Delete colour style", (d) => {
                  detachStyle(d, c.id);
                  d.setData((x) => ({ ...x, colors: x.colors.filter((y) => y.id !== c.id) }));
                })
              }
            >
              <Trash2 size={12} />
            </IconBtn>
          )}
        </div>
      ))}
    </AssetSection>
  );
}

function TextStyles() {
  const styles = useDesign((s) => s.doc.data.textStyles);
  const canEdit = useDesign((s) => s.canEdit);
  const add = () => {
    const r = S()
      .selection.map((id) => resolved().byId.get(id))
      .find((x) => x?.type === "text");
    const t = r?.text ?? { fontFamily: "Inter", fontWeight: 400, fontSize: 16, lineHeight: null, letterSpacing: 0 };
    tx("Add text style", (d) =>
      d.setData((x) => ({
        ...x,
        textStyles: [...x.textStyles, { id: shortId(), name: `Text ${x.textStyles.length + 1}`, fontFamily: t.fontFamily, fontWeight: t.fontWeight, fontSize: t.fontSize, lineHeight: t.lineHeight ?? null, letterSpacing: t.letterSpacing ?? 0 }],
      })),
    );
  };
  const edit = (id: string, p: Partial<(typeof styles)[number]>) => tx("Edit text style", (d) => d.setData((x) => ({ ...x, textStyles: x.textStyles.map((y) => (y.id === id ? { ...y, ...p } : y)) })));
  return (
    <AssetSection
      title="Text styles"
      action={
        canEdit && (
          <IconBtn title="New text style from selection" onClick={add}>
            <Plus size={13} />
          </IconBtn>
        )
      }
    >
      {styles.map((s) => (
        <div key={s.id} className="space-y-1 pb-1">
          <div className="flex items-center gap-1">
            <TextField value={s.name} onChange={(v) => edit(s.id, { name: v.slice(0, 80) || s.name })} />
            {canEdit && (
              <IconBtn
                title="Delete style"
                onClick={() =>
                  tx("Delete text style", (d) => {
                    detachStyle(d, s.id);
                    d.setData((x) => ({ ...x, textStyles: x.textStyles.filter((y) => y.id !== s.id) }));
                  })
                }
              >
                <Trash2 size={12} />
              </IconBtn>
            )}
          </div>
          <div className="grid grid-cols-3 gap-1">
            <NumField label="Aa" value={s.fontSize} min={1} onChange={(v) => edit(s.id, { fontSize: v })} />
            <NumField label="W" value={s.fontWeight} min={100} max={900} step={100} onChange={(v) => edit(s.id, { fontWeight: Math.round(v / 100) * 100 })} />
            <NumField label="↕" value={s.lineHeight ?? undefined} min={0} onChange={(v) => edit(s.id, { lineHeight: v || null })} />
          </div>
          <TextField value={s.fontFamily} onChange={(v) => edit(s.id, { fontFamily: v || s.fontFamily })} />
        </div>
      ))}
    </AssetSection>
  );
}

function Tokens() {
  const tokens = useDesign((s) => s.doc.data.tokens);
  const canEdit = useDesign((s) => s.canEdit);
  const add = (kind: Token["kind"]) =>
    tx("Add token", (d) =>
      d.setData((x) => ({ ...x, tokens: [...x.tokens, { id: shortId(), name: `${kind}-${x.tokens.filter((t) => t.kind === kind).length + 1}`, kind, value: kind === "color" ? "#0C8CE9" : kind === "font-size" ? 16 : 8 }] })),
    );
  const edit = (id: string, p: Partial<Token>) => tx("Edit token", (d) => d.setData((x) => ({ ...x, tokens: x.tokens.map((t) => (t.id === id ? { ...t, ...p } : t)) })));
  return (
    <AssetSection title="Design tokens">
      {canEdit && (
        <div className="flex flex-wrap gap-1">
          {(["spacing", "radius", "color", "font-size"] as const).map((k) => (
            <button key={k} className="h-6 px-2 rounded bg-inset text-[11px] text-ink hover:bg-hover" onClick={() => add(k)}>
              + {k}
            </button>
          ))}
        </div>
      )}
      {tokens.map((t) => (
        <div key={t.id} className="grid grid-cols-[1fr_80px_auto] gap-1 items-center">
          <TextField value={t.name} onChange={(v) => edit(t.id, { name: v.slice(0, 80) || t.name })} />
          {t.kind === "color" ? (
            <ColorField color={String(t.value)} onChange={(c) => edit(t.id, { value: c })} />
          ) : (
            <NumField value={Number(t.value)} min={0} onChange={(v) => edit(t.id, { value: v })} suffix={t.kind === "font-size" ? "px" : undefined} />
          )}
          {canEdit && (
            <IconBtn
              title="Delete token (bound layers keep the value)"
              onClick={() =>
                tx("Delete token", (d) => {
                  detachStyle(d, t.id);
                  d.setData((x) => ({ ...x, tokens: x.tokens.filter((y) => y.id !== t.id) }));
                })
              }
            >
              <Trash2 size={12} />
            </IconBtn>
          )}
        </div>
      ))}
      {!!tokens.length && <p className="text-[11px] text-subtle">Bind spacing tokens in Auto layout, radius tokens in Position & size.</p>}
    </AssetSection>
  );
}

function ImagesAsset() {
  useDesign((s) => s.doc.nodes);
  const canEdit = useDesign((s) => s.canEdit);
  const imgs = imagesInDoc();
  return (
    <AssetSection title="Images">
      {!imgs.length && <p className="text-[11px] text-subtle">Images you add (drop, paste, or the image tool) show up here for reuse.</p>}
      <div className="grid grid-cols-3 gap-1">
        {imgs.map((im) => (
          <button
            key={im.src}
            disabled={!canEdit}
            title={im.name}
            className="aspect-square rounded border border-border overflow-hidden bg-inset hover:ring-1 hover:ring-accent"
            onClick={() => {
              const c = viewCenter();
              const k = Math.min(1, 400 / Math.max(im.nw, im.nh));
              addNode("image", { x: c.x - (im.nw * k) / 2, y: c.y - (im.nh * k) / 2, w: im.nw * k, h: im.nh * k }, null, { name: im.name, image: { src: im.src, nw: im.nw, nh: im.nh, fit: "fill" } });
            }}
          >
            <ImageThumb src={im.src} />
          </button>
        ))}
      </div>
    </AssetSection>
  );
}

function ImageThumb({ src }: { src: string }) {
  const [url, setUrl] = useState<string | null>(src.startsWith("data:") ? src : null);
  useEffect(() => {
    if (src.startsWith("data:")) return;
    let alive = true;
    void imageUrl(src).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [src]);
  return url ? <img src={url} alt="" className="w-full h-full object-cover" /> : null;
}

function IconsAsset() {
  const canEdit = useDesign((s) => s.canEdit);
  return (
    <AssetSection title="Icons">
      <div className="grid grid-cols-6 gap-1">
        {ICONS.map(([name, Icon]) => (
          <button key={name} disabled={!canEdit} title={name} className="aspect-square grid place-items-center rounded hover:bg-hover text-ink" onClick={() => insertIcon(name)}>
            <Icon size={16} />
          </button>
        ))}
      </div>
    </AssetSection>
  );
}
