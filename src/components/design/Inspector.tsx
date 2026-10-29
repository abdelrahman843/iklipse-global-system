import { useMemo } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowRight,
  Eye,
  EyeOff,
  Minus,
  Plus,
  RotateCcw,
  Unlink,
  WrapText,
  Crosshair,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from "lucide-react";
import { align, detachSelection, distribute, setPageBg } from "@/lib/design/actions";
import { isVirtual, resizeWithConstraints, shortId } from "@/lib/design/doc";
import type { RNode } from "@/lib/design/layout";
import { patchSelection, resetOverrides, resolved, select, tx, useDesign, zoomTo } from "@/lib/design/store";
import { FONT_FAMILIES, FRAME_PRESETS, type AutoLayout, type DNode, type Effect, type HSizing, type Paint, type Stroke, type TextProps } from "@/lib/design/types";
import { ColorField, IconBtn, MIXED, NumField, Section, Segmented, Select, TextField, common } from "./fields";
import { WEB_FONTS } from "@/lib/design/fonts";
import { ExportSection } from "./ExportSection";

// -----------------------------------------------------------------------------
// Right sidebar, "Design" tab: properties of the selection. Edits apply at
// once (one undo step each); inside an instance only what may be overridden.
// -----------------------------------------------------------------------------

const S = useDesign.getState;

export function Inspector() {
  const doc = useDesign((s) => s.doc);
  const page = useDesign((s) => s.page);
  const selection = useDesign((s) => s.selection);
  const canEdit = useDesign((s) => s.canEdit);
  const { byId, parentOf } = useMemo(() => resolved(doc, page), [doc, page]);
  const rns = selection.map((id) => byId.get(id)).filter(Boolean) as RNode[];

  if (!rns.length) return <PageProps />;
  const virtual = rns.some((r) => isVirtual(r.rid));
  const geomOK = canEdit && !virtual;
  const parents = rns.map((r) => parentOf.get(r.rid) ?? null);
  const parentLayout = parents.every((p) => p?.layout) ? parents[0]!.layout! : null;
  const one = rns.length === 1 ? rns[0]! : null;
  const types = new Set(rns.map((r) => r.type));
  const containers = rns.every((r) => r.type === "frame" || r.type === "component" || (r.type === "instance" && !virtual));
  const texts = rns.filter((r) => r.type === "text");

  return (
    <div className={!canEdit ? "pointer-events-none opacity-80" : undefined}>
      <Header rns={rns} />
      {geomOK && <Arrange count={rns.length} />}
      {geomOK && one && (one.type === "frame" || one.type === "component") && !one.parent && <Presets n={one} />}
      <Geometry rns={rns} disabled={!geomOK} />
      {geomOK && parents.every((p) => p && !p.layout && p.type !== "group") && <ConstraintsSection rns={rns} />}
      {geomOK && containers && types.size === 1 && !types.has("instance") && <AutoLayoutSection rns={rns} />}
      {geomOK && (parentLayout || rns.some((r) => r.layout) || texts.length) && <SizingSection rns={rns} parentLayout={parentLayout} />}
      <LayerSection rns={rns} virtual={virtual} />
      {texts.length === rns.length && <TextSection rns={texts} />}
      {one?.type === "image" && <ImageSection n={one} />}
      {(one?.type === "line" || one?.type === "arrow") && !virtual && <LineSection n={one} />}
      {(one?.type === "polygon" || one?.type === "star") && !virtual && <PolySection n={one} />}
      {!types.has("group") && <FillSection rns={rns} />}
      {!types.has("group") && <StrokeSection rns={rns} />}
      {!virtual && <EffectsSection rns={rns} />}
      {one?.type === "component" && <ComponentSection n={one} />}
      {one?.type === "instance" && !virtual && <InstanceSection n={one} />}
      {one && isVirtual(one.rid) && <OverrideNote n={one} />}
      {geomOK && one && (one.type === "frame" || one.type === "component") && <GridSection n={one} />}
      <ExportSection ids={rns.filter((r) => !isVirtual(r.rid)).map((r) => r.rid)} />
    </div>
  );
}

function PageProps() {
  const page = useDesign((s) => s.doc.data.pages.find((p) => p.id === s.page));
  if (!page) return null;
  return (
    <Section title="Page">
      <ColorField color={page.bg ?? "#F5F5F5"} onChange={(c) => setPageBg(page.id, c)} />
      <p className="text-[11px] text-subtle pt-1">Select a layer to edit it. Press F for a frame, R for a rectangle, T for text.</p>
    </Section>
  );
}

function Header({ rns }: { rns: RNode[] }) {
  const one = rns.length === 1 ? rns[0]! : null;
  const label = one ? `${typeLabel(one.type)}${isVirtual(one.rid) ? " (in instance)" : ""}` : `${rns.length} layers`;
  return (
    <div className="px-3 py-2 border-b border-border flex items-center justify-between">
      <span className="text-xs font-semibold text-ink truncate">{label}</span>
      {one && !isVirtual(one.rid) && (
        <div className="w-36">
          <TextField value={one.name} onChange={(v) => patchSelection("Rename", { name: v.slice(0, 200) || one.name })} />
        </div>
      )}
    </div>
  );
}

function typeLabel(t: DNode["type"]) {
  return { frame: "Frame", group: "Group", rect: "Rectangle", ellipse: "Ellipse", line: "Line", arrow: "Arrow", polygon: "Polygon", star: "Star", path: "Vector", text: "Text", image: "Image", component: "Component", instance: "Instance" }[t];
}

function Arrange({ count }: { count: number }) {
  return (
    <div className="px-3 py-1.5 border-b border-border flex items-center gap-0.5">
      <IconBtn title="Align left" onClick={() => align("left")}>
        <AlignStartVertical size={14} />
      </IconBtn>
      <IconBtn title="Align horizontal centres" onClick={() => align("hcenter")}>
        <AlignCenterVertical size={14} />
      </IconBtn>
      <IconBtn title="Align right" onClick={() => align("right")}>
        <AlignEndVertical size={14} />
      </IconBtn>
      <IconBtn title="Align top" onClick={() => align("top")}>
        <AlignStartHorizontal size={14} />
      </IconBtn>
      <IconBtn title="Align vertical centres" onClick={() => align("vcenter")}>
        <AlignCenterHorizontal size={14} />
      </IconBtn>
      <IconBtn title="Align bottom" onClick={() => align("bottom")}>
        <AlignEndHorizontal size={14} />
      </IconBtn>
      <span className="w-px h-4 bg-line mx-1" />
      <IconBtn title="Distribute horizontally" onClick={() => distribute("h")} disabled={count < 3}>
        <AlignHorizontalDistributeCenter size={14} />
      </IconBtn>
      <IconBtn title="Distribute vertically" onClick={() => distribute("v")} disabled={count < 3}>
        <AlignVerticalDistributeCenter size={14} />
      </IconBtn>
    </div>
  );
}

function Presets({ n }: { n: RNode }) {
  return (
    <Section title="Frame">
      <Select
        value={MIXED as string}
        options={FRAME_PRESETS.map((p) => ({ value: `${p.w}x${p.h}`, label: `${p.group} · ${p.name} (${p.w}×${p.h})` }))}
        onChange={(v) => {
          const [w, h] = v.split("x").map(Number);
          patchSelection("Frame size", { w, h }, [n.rid]);
        }}
      />
    </Section>
  );
}

// --------------------------------------------------------------- geometry --
function Geometry({ rns, disabled }: { rns: RNode[]; disabled: boolean }) {
  const x = common(rns, (r) => Math.round(r.x * 100) / 100);
  const y = common(rns, (r) => Math.round(r.y * 100) / 100);
  const w = common(rns, (r) => Math.round(r.w * 100) / 100);
  const h = common(rns, (r) => Math.round(r.h * 100) / 100);
  const rot = common(rns, (r) => r.rotation);
  const hasRadius = rns.every((r) => ["frame", "component", "instance", "rect", "image"].includes(r.type));
  const rad = common(rns, (r) => (Array.isArray(r.radius) ? MIXED : (r.radius ?? 0)));
  const tokens = useDesign((s) => s.doc.data.tokens.filter((t) => t.kind === "radius"));
  const set = (label: string, fn: (r: RNode) => Partial<DNode>) => patchSelection(label, fn);
  return (
    <Section title="Position & size">
      <div className="grid grid-cols-2 gap-1.5">
        <NumField label="X" value={x} disabled={disabled} onChange={(v) => set("Move", () => ({ x: v }))} />
        <NumField label="Y" value={y} disabled={disabled} onChange={(v) => set("Move", () => ({ y: v }))} />
        <NumField label="W" value={w} min={1} disabled={disabled} onChange={(v) => sizeTo("w", v)} />
        <NumField label="H" value={h} min={0} disabled={disabled} onChange={(v) => sizeTo("h", v)} />
        <NumField label="↻" value={rot} disabled={disabled} suffix="°" onChange={(v) => set("Rotate", () => ({ rotation: ((((v + 180) % 360) + 360) % 360) - 180 }))} />
        {hasRadius && <NumField label="◜" value={rad} min={0} disabled={disabled} title="Corner radius" onChange={(v) => set("Corner radius", () => ({ radius: v, radiusToken: undefined }))} />}
      </div>
      {hasRadius && !disabled && (
        <>
          <CornerFields rns={rns} />
          {tokens.length > 0 && (
            <Select
              value={common(rns, (r) => r.radiusToken ?? "") ?? ""}
              options={[{ value: "", label: "No radius token" }, ...tokens.map((t) => ({ value: t.id, label: `Token: ${t.name} (${t.value})` }))]}
              onChange={(v) => set("Radius token", () => ({ radiusToken: v || undefined }))}
            />
          )}
        </>
      )}
    </Section>
  );
}

function CornerFields({ rns }: { rns: RNode[] }) {
  const one = rns.length === 1 ? rns[0]! : null;
  if (!one) return null;
  const r = Array.isArray(one.radius) ? one.radius : [one.radius ?? 0, one.radius ?? 0, one.radius ?? 0, one.radius ?? 0];
  const setCorner = (i: number, v: number) => {
    const next = [...r] as [number, number, number, number];
    next[i] = v;
    patchSelection("Corner radius", { radius: next.every((x) => x === next[0]) ? next[0] : next, radiusToken: undefined });
  };
  return (
    <details className="text-[11px] text-subtle">
      <summary className="cursor-pointer select-none">Individual corners</summary>
      <div className="grid grid-cols-4 gap-1 pt-1">
        {["↖", "↗", "↘", "↙"].map((l, i) => (
          <NumField key={l} label={l} value={r[i]} min={0} onChange={(v) => setCorner(i, v)} />
        ))}
      </div>
    </details>
  );
}

/** Width / height from the inspector: constraints on children, fixed sizing. */
function sizeTo(axis: "w" | "h", v: number) {
  const { byId } = resolved();
  const ids = S().selection.filter((id) => !isVirtual(id));
  tx("Resize", (d) => {
    for (const id of ids) {
      const n = d.get(id);
      const r = byId.get(id);
      if (!n || !r) continue;
      const next = { x: n.x, y: n.y, w: axis === "w" ? v : r.w, h: axis === "h" ? v : r.h };
      if (n.sizing) d.patch(id, { sizing: { ...n.sizing, [axis === "w" ? "h" : "v"]: "fixed" } });
      if (n.type === "text" && n.text) d.patch(id, { text: { ...n.text, resize: axis === "h" ? "fixed" : n.text.resize === "auto-width" ? "auto-height" : n.text.resize } });
      resizeWithConstraints(d, id, next);
    }
  });
}

function ConstraintsSection({ rns }: { rns: RNode[] }) {
  const h = common(rns, (r) => r.constraints?.h ?? "left");
  const v = common(rns, (r) => r.constraints?.v ?? "top");
  return (
    <Section title="Constraints">
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={h ?? "left"}
          options={[
            { value: "left", label: "Left" },
            { value: "right", label: "Right" },
            { value: "left-right", label: "Left & right" },
            { value: "center", label: "Centre" },
            { value: "scale", label: "Scale" },
          ]}
          onChange={(x) => patchSelection("Constraints", (r) => ({ constraints: { h: x, v: r.constraints?.v ?? "top" } }))}
        />
        <Select
          value={v ?? "top"}
          options={[
            { value: "top", label: "Top" },
            { value: "bottom", label: "Bottom" },
            { value: "top-bottom", label: "Top & bottom" },
            { value: "center", label: "Centre" },
            { value: "scale", label: "Scale" },
          ]}
          onChange={(x) => patchSelection("Constraints", (r) => ({ constraints: { h: r.constraints?.h ?? "left", v: x } }))}
        />
      </div>
    </Section>
  );
}

// ------------------------------------------------------------ auto layout --
const DEFAULT_LAYOUT: AutoLayout = { mode: "vertical", gap: 10, padding: { t: 10, r: 10, b: 10, l: 10 }, justify: "start", align: "start" };

function AutoLayoutSection({ rns }: { rns: RNode[] }) {
  const one = rns[0]!;
  const L = rns.length === 1 ? (S().doc.nodes[one.rid]?.layout ?? null) : null;
  const spacing = useDesign((s) => s.doc.data.tokens.filter((t) => t.kind === "spacing"));
  const setL = (p: Partial<AutoLayout>) => patchSelection("Auto layout", (r) => ({ layout: { ...(S().doc.nodes[r.rid]?.layout ?? DEFAULT_LAYOUT), ...p } }));
  return (
    <Section
      title="Auto layout"
      action={
        L ? (
          <IconBtn title="Remove auto layout" onClick={() => patchSelection("Remove auto layout", { layout: null })}>
            <Minus size={14} />
          </IconBtn>
        ) : (
          <IconBtn
            title="Add auto layout (Shift+A)"
            onClick={() =>
              patchSelection("Add auto layout", (r) => ({
                layout: { ...DEFAULT_LAYOUT, mode: r.w >= r.h ? "horizontal" : "vertical" },
                sizing: { h: "hug", v: "hug" },
              }))
            }
          >
            <Plus size={14} />
          </IconBtn>
        )
      }
    >
      {L && (
        <>
          <Segmented
            value={L.wrap ? "wrap" : L.mode}
            options={[
              { value: "vertical", label: <ArrowDown size={14} />, title: "Vertical" },
              { value: "horizontal", label: <ArrowRight size={14} />, title: "Horizontal" },
              { value: "wrap", label: <WrapText size={14} />, title: "Wrap" },
            ]}
            onChange={(v) => setL(v === "wrap" ? { mode: "horizontal", wrap: true } : { mode: v, wrap: false })}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <NumField label="↔" title="Gap between items" value={L.gap} min={0} onChange={(v) => setL({ gap: v, gapToken: undefined })} />
            {L.wrap ? <NumField label="↕" title="Gap between rows" value={L.rowGap ?? L.gap} min={0} onChange={(v) => setL({ rowGap: v })} /> : <span />}
            <NumField label="T" title="Padding top" value={L.padding.t} min={0} onChange={(v) => setL({ padding: { ...L.padding, t: v }, paddingToken: undefined })} />
            <NumField label="R" title="Padding right" value={L.padding.r} min={0} onChange={(v) => setL({ padding: { ...L.padding, r: v }, paddingToken: undefined })} />
            <NumField label="B" title="Padding bottom" value={L.padding.b} min={0} onChange={(v) => setL({ padding: { ...L.padding, b: v }, paddingToken: undefined })} />
            <NumField label="L" title="Padding left" value={L.padding.l} min={0} onChange={(v) => setL({ padding: { ...L.padding, l: v }, paddingToken: undefined })} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Select
              value={L.justify}
              options={[
                { value: "start", label: "Pack start" },
                { value: "center", label: "Pack centre" },
                { value: "end", label: "Pack end" },
                { value: "space-between", label: "Space between" },
              ]}
              onChange={(v) => setL({ justify: v })}
            />
            <Select
              value={L.align}
              options={[
                { value: "start", label: "Align start" },
                { value: "center", label: "Align centre" },
                { value: "end", label: "Align end" },
                { value: "stretch", label: "Stretch" },
                { value: "baseline", label: "Baseline (start)" },
              ]}
              onChange={(v) => setL({ align: v })}
            />
          </div>
          {spacing.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5">
              <Select
                value={L.gapToken ?? ""}
                options={[{ value: "", label: "Gap: no token" }, ...spacing.map((t) => ({ value: t.id, label: `Gap: ${t.name}` }))]}
                onChange={(v) => setL({ gapToken: v || undefined })}
              />
              <Select
                value={L.paddingToken ?? ""}
                options={[{ value: "", label: "Padding: no token" }, ...spacing.map((t) => ({ value: t.id, label: `Pad: ${t.name}` }))]}
                onChange={(v) => setL({ paddingToken: v || undefined })}
              />
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function SizingSection({ rns, parentLayout }: { rns: RNode[]; parentLayout: AutoLayout | null }) {
  const canHug = rns.every((r) => r.layout || r.type === "text");
  const opts = (axis: "h" | "v") => {
    const o: { value: HSizing; label: string }[] = [{ value: "fixed", label: axis === "h" ? "Fixed width" : "Fixed height" }];
    if (canHug) o.push({ value: "hug", label: "Hug contents" });
    if (parentLayout) o.push({ value: "fill", label: "Fill container" });
    return o;
  };
  const hs = common(rns, (r) => r.sizing?.h ?? (r.type === "text" && r.text?.resize === "auto-width" ? "hug" : "fixed"));
  const vs = common(rns, (r) => r.sizing?.v ?? (r.type === "text" && r.text?.resize !== "fixed" ? "hug" : "fixed"));
  const setSizing = (axis: "h" | "v", v: HSizing) =>
    patchSelection("Resizing", (r) => {
      const sizing = { ...(r.sizing ?? { h: "fixed", v: "fixed" }), [axis]: v } as NonNullable<DNode["sizing"]>;
      const p: Partial<DNode> = { sizing };
      // Text layers follow their resize mode.
      if (r.type === "text" && r.text) p.text = { ...r.text, resize: sizing.h === "hug" ? "auto-width" : sizing.v === "hug" ? "auto-height" : "fixed" };
      return p;
    });
  return (
    <Section title="Resizing">
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={hs ?? "fixed"} options={opts("h")} onChange={(v) => setSizing("h", v)} />
        <Select value={vs ?? "fixed"} options={opts("v")} onChange={(v) => setSizing("v", v)} />
      </div>
      {parentLayout && (
        <label className="flex items-center gap-2 text-xs text-ink">
          <input type="checkbox" checked={rns.every((r) => r.absolute)} onChange={(e) => patchSelection("Absolute position", { absolute: e.target.checked })} />
          Absolute position (ignore auto layout)
        </label>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ layer --
function LayerSection({ rns, virtual }: { rns: RNode[]; virtual: boolean }) {
  const op = common(rns, (r) => Math.round(r.opacity * 100));
  const blend = common(rns, (r) => r.blend ?? "normal");
  const vis = rns.every((r) => r.visible !== false);
  const clip = rns.every((r) => r.clip);
  const clippable = rns.every((r) => r.type === "frame" || r.type === "component");
  return (
    <Section
      title="Layer"
      action={
        <IconBtn title={vis ? "Hide" : "Show"} onClick={() => patchSelection(vis ? "Hide" : "Show", { visible: !vis })}>
          {vis ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconBtn>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <NumField label="◐" title="Opacity" value={op} min={0} max={100} suffix="%" onChange={(v) => patchSelection("Opacity", { opacity: v / 100 })} />
        {!virtual && (
          <Select
            value={blend ?? "normal"}
            options={["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "difference", "exclusion", "luminosity"].map((b) => ({ value: b, label: b[0]!.toUpperCase() + b.slice(1) }))}
            onChange={(v) => patchSelection("Blend mode", { blend: v === "normal" ? undefined : v })}
          />
        )}
      </div>
      {clippable && !virtual && (
        <label className="flex items-center gap-2 text-xs text-ink">
          <input type="checkbox" checked={clip} onChange={(e) => patchSelection("Clip content", { clip: e.target.checked })} />
          Clip content
        </label>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------- text --
function TextSection({ rns }: { rns: RNode[] }) {
  const t = (k: keyof TextProps) => common(rns, (r) => r.text?.[k]);
  const virtual = rns.some((r) => isVirtual(r.rid));
  const styles = useDesign((s) => s.doc.data.textStyles);
  const setT = (label: string, p: Partial<TextProps>) => patchSelection(label, (r) => ({ text: { ...(S().doc.nodes[r.rid]?.text ?? r.text!), ...p } }));
  const styleId = t("styleId") as string | undefined | typeof MIXED;
  if (virtual)
    return (
      <Section title="Text">
        <p className="text-[11px] text-subtle">Double-click the text on the canvas to change it for this instance.</p>
      </Section>
    );
  const locked = !!styleId && styleId !== MIXED;
  return (
    <Section title="Text">
      {styles.length > 0 && (
        <Select
          value={(styleId as string) ?? ""}
          options={[{ value: "", label: "No text style" }, ...styles.map((s) => ({ value: s.id, label: `${s.name} · ${s.fontSize}/${s.fontWeight}` }))]}
          onChange={(v) => setT("Text style", { styleId: v || undefined })}
        />
      )}
      <Select
        value={(t("fontFamily") as string) ?? "Inter"}
        options={[...new Set([...(t("fontFamily") && t("fontFamily") !== MIXED ? [t("fontFamily") as string] : []), ...WEB_FONTS, ...FONT_FAMILIES])].map((f) => ({ value: f, label: f }))}
        onChange={(v) => setT("Font", { fontFamily: v, styleId: undefined })}
        disabled={locked}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={(t("fontWeight") as number) ?? 400}
          options={[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: w, label: `${w} ${weightName(w)}` }))}
          onChange={(v) => setT("Font weight", { fontWeight: v, styleId: undefined })}
          disabled={locked}
        />
        <NumField label="Aa" title="Font size" value={t("fontSize") as number} min={1} max={1000} onChange={(v) => setT("Font size", { fontSize: v, styleId: undefined })} disabled={locked} />
        <NumField
          label="↕"
          title="Line height (px, empty = auto)"
          value={(t("lineHeight") as number | null) ?? undefined}
          min={0}
          onChange={(v) => setT("Line height", { lineHeight: v || null, styleId: undefined })}
          disabled={locked}
        />
        <NumField label="↔" title="Letter spacing" value={(t("letterSpacing") as number) ?? 0} step={0.1} onChange={(v) => setT("Letter spacing", { letterSpacing: v, styleId: undefined })} disabled={locked} />
      </div>
      <Segmented
        value={(t("align") as TextProps["align"]) ?? "left"}
        options={[
          { value: "left", label: "L", title: "Align left" },
          { value: "center", label: "C", title: "Align centre" },
          { value: "right", label: "R", title: "Align right" },
          { value: "justify", label: "J", title: "Justify (renders left aligned)" },
        ]}
        onChange={(v) => setT("Text align", { align: v })}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <Select
          value={(t("valign") as string) ?? "top"}
          options={[
            { value: "top", label: "Top" },
            { value: "middle", label: "Middle" },
            { value: "bottom", label: "Bottom" },
          ]}
          onChange={(v) => setT("Vertical align", { valign: v as TextProps["valign"] })}
        />
        <Select
          value={(t("resize") as string) ?? "auto-width"}
          options={[
            { value: "auto-width", label: "Auto width" },
            { value: "auto-height", label: "Auto height" },
            { value: "fixed", label: "Fixed size" },
          ]}
          onChange={(v) => setT("Text resizing", { resize: v as TextProps["resize"] })}
        />
        <Select
          value={(t("decoration") as string) ?? "none"}
          options={[
            { value: "none", label: "No decoration" },
            { value: "underline", label: "Underline" },
            { value: "strike", label: "Strikethrough" },
          ]}
          onChange={(v) => setT("Decoration", { decoration: v as TextProps["decoration"] })}
        />
        <Select
          value={(t("transform") as string) ?? "none"}
          options={[
            { value: "none", label: "As typed" },
            { value: "upper", label: "UPPERCASE" },
            { value: "lower", label: "lowercase" },
            { value: "title", label: "Title Case" },
          ]}
          onChange={(v) => setT("Case", { transform: v as TextProps["transform"] })}
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-ink">
        <input type="checkbox" checked={rns.every((r) => r.text?.italic)} onChange={(e) => setT("Italic", { italic: e.target.checked })} /> Italic
      </label>
    </Section>
  );
}

function weightName(w: number) {
  return { 100: "Thin", 200: "Extra light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Extra bold", 900: "Black" }[w] ?? "";
}

// ----------------------------------------------------------------- paints --
function FillSection({ rns }: { rns: RNode[] }) {
  const fills = common(rns, (r) => r.fills);
  const colors = useDesign((s) => s.doc.data.colors);
  const setFills = (label: string, f: Paint[]) => patchSelection(label, { fills: f });
  const list = fills === MIXED || !fills ? null : fills;
  return (
    <Section
      title="Fill"
      action={
        <IconBtn title="Add fill" onClick={() => patchSelection("Add fill", (r) => ({ fills: [...r.fills, { type: "solid", color: r.type === "text" ? "#1E1E1E" : "#D9D9D9" }] }))}>
          <Plus size={14} />
        </IconBtn>
      }
    >
      {fills === MIXED && <p className="text-[11px] text-subtle">Mixed fills. Add one to replace them all.</p>}
      {list?.map((p, i) => (
        <PaintRow
          key={i}
          p={p}
          colors={colors}
          onChange={(np) => setFills("Fill", list.map((x, j) => (j === i ? np : x)))}
          onRemove={() => setFills("Remove fill", list.filter((_, j) => j !== i))}
        />
      ))}
    </Section>
  );
}

function PaintRow({ p, onChange, onRemove, colors }: { p: Paint; onChange: (p: Paint) => void; onRemove: () => void; colors: { id: string; name: string; color: string }[] }) {
  const styled = p.type === "solid" && p.styleId ? colors.find((c) => c.id === p.styleId) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <select
          className="h-7 w-[70px] shrink-0 rounded bg-inset text-xs text-ink px-1 outline-none"
          value={p.type}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const t = e.target.value as Paint["type"];
            const c = p.type === "solid" ? p.color : p.stops[0]?.color ?? "#000000";
            if (t === "solid") onChange({ type: "solid", color: c, opacity: p.opacity });
            else if (t === "linear") onChange({ type: "linear", angle: 90, stops: [{ pos: 0, color: c }, { pos: 1, color: "#FFFFFF" }], opacity: p.opacity });
            else onChange({ type: "radial", stops: [{ pos: 0, color: c }, { pos: 1, color: "#FFFFFF" }], opacity: p.opacity });
          }}
        >
          <option value="solid">Solid</option>
          <option value="linear">Linear</option>
          <option value="radial">Radial</option>
        </select>
        {p.type === "solid" ? (
          styled ? (
            <div className="flex-1 flex items-center gap-1.5 h-7 px-1.5 rounded bg-inset text-xs text-ink min-w-0">
              <span className="h-4 w-4 rounded border border-border shrink-0" style={{ background: styled.color }} />
              <span className="truncate">{styled.name}</span>
              <button className="ml-auto text-subtle hover:text-ink" title="Detach style" onClick={() => onChange({ ...p, styleId: undefined })}>
                <Unlink size={12} />
              </button>
            </div>
          ) : (
            <ColorField color={p.color} opacity={p.opacity} onChange={(c, o) => onChange({ ...p, color: c, opacity: o })} />
          )
        ) : (
          <span className="flex-1 h-6 rounded border border-border" style={{ background: `linear-gradient(90deg, ${p.stops.map((s) => `${s.color} ${s.pos * 100}%`).join(", ")})` }} />
        )}
        <IconBtn title={p.visible === false ? "Show" : "Hide"} onClick={() => onChange({ ...p, visible: p.visible === false })}>
          {p.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
        </IconBtn>
        <IconBtn title="Remove" onClick={onRemove}>
          <Minus size={13} />
        </IconBtn>
      </div>
      {p.type === "solid" && colors.length > 0 && !styled && (
        <Select value={""} options={[{ value: "", label: "Apply colour style…" }, ...colors.map((c) => ({ value: c.id, label: c.name }))]} onChange={(v) => v && onChange({ ...p, styleId: v, color: colors.find((c) => c.id === v)!.color })} />
      )}
      {p.type !== "solid" && (
        <div className="pl-[74px] space-y-1">
          {p.type === "linear" && <NumField label="∠" title="Angle" value={p.angle} suffix="°" onChange={(v) => onChange({ ...p, angle: v })} />}
          {p.stops.map((s, i) => (
            <div key={i} className="flex items-center gap-1">
              <div className="w-12 shrink-0">
                <NumField value={Math.round(s.pos * 100)} min={0} max={100} suffix="%" onChange={(v) => onChange({ ...p, stops: p.stops.map((x, j) => (j === i ? { ...x, pos: v / 100 } : x)) })} />
              </div>
              <ColorField color={s.color} onChange={(c) => onChange({ ...p, stops: p.stops.map((x, j) => (j === i ? { ...x, color: c } : x)) })} />
            </div>
          ))}
          <button className="text-[11px] text-accent hover:underline" onClick={() => onChange({ ...p, stops: [...p.stops, { pos: 0.5, color: "#888888" }].sort((a, b) => a.pos - b.pos) })}>
            Add stop
          </button>
        </div>
      )}
    </div>
  );
}

function StrokeSection({ rns }: { rns: RNode[] }) {
  const strokes = common(rns, (r) => r.strokes);
  const list = strokes === MIXED || !strokes ? null : strokes;
  const setStrokes = (label: string, s: Stroke[]) => patchSelection(label, { strokes: s });
  return (
    <Section
      title="Stroke"
      action={
        <IconBtn title="Add stroke" onClick={() => patchSelection("Add stroke", (r) => ({ strokes: [...r.strokes, { color: "#1E1E1E", width: 1, align: "inside" }] }))}>
          <Plus size={14} />
        </IconBtn>
      }
    >
      {strokes === MIXED && <p className="text-[11px] text-subtle">Mixed strokes.</p>}
      {list?.map((s, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-1">
            <ColorField color={s.color} onChange={(c) => setStrokes("Stroke", list.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
            <IconBtn title={s.visible === false ? "Show" : "Hide"} onClick={() => setStrokes("Stroke", list.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)))}>
              {s.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </IconBtn>
            <IconBtn title="Remove" onClick={() => setStrokes("Remove stroke", list.filter((_, j) => j !== i))}>
              <Minus size={13} />
            </IconBtn>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <NumField label="W" value={s.width} min={0} step={0.5} onChange={(v) => setStrokes("Stroke width", list.map((x, j) => (j === i ? { ...x, width: v } : x)))} />
            <Select
              value={s.align ?? "inside"}
              options={[
                { value: "inside", label: "Inside" },
                { value: "center", label: "Centre" },
                { value: "outside", label: "Outside" },
              ]}
              onChange={(v) => setStrokes("Stroke position", list.map((x, j) => (j === i ? { ...x, align: v as Stroke["align"] } : x)))}
            />
            <Select
              value={s.dash?.length ? "dash" : "solid"}
              options={[
                { value: "solid", label: "Solid" },
                { value: "dash", label: "Dashed" },
              ]}
              onChange={(v) => setStrokes("Dash", list.map((x, j) => (j === i ? { ...x, dash: v === "dash" ? [6, 4] : undefined } : x)))}
            />
          </div>
        </div>
      ))}
    </Section>
  );
}

function EffectsSection({ rns }: { rns: RNode[] }) {
  const fx = common(rns, (r) => r.effects ?? []);
  const list = fx === MIXED || !fx ? null : fx;
  const setFx = (label: string, e: Effect[]) => patchSelection(label, { effects: e.length ? e : undefined });
  return (
    <Section
      title="Effects"
      action={
        <IconBtn title="Add drop shadow" onClick={() => patchSelection("Add effect", (r) => ({ effects: [...(r.effects ?? []), { type: "drop-shadow", x: 0, y: 4, blur: 12, color: "rgba(0,0,0,0.25)" }] }))}>
          <Plus size={14} />
        </IconBtn>
      }
    >
      {list?.map((e, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-1">
            <Select
              value={e.type}
              options={[
                { value: "drop-shadow", label: "Drop shadow" },
                { value: "inner-shadow", label: "Inner shadow" },
                { value: "layer-blur", label: "Layer blur" },
              ]}
              onChange={(t) =>
                setFx(
                  "Effect",
                  list.map((x, j) => (j !== i ? x : t === "layer-blur" ? { type: "layer-blur", blur: "blur" in x ? x.blur : 4 } : { type: t, x: 0, y: 4, blur: 12, color: "rgba(0,0,0,0.25)" })),
                )
              }
            />
            <IconBtn title={e.visible === false ? "Show" : "Hide"} onClick={() => setFx("Effect", list.map((x, j) => (j === i ? { ...x, visible: x.visible === false } : x)))}>
              {e.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
            </IconBtn>
            <IconBtn title="Remove" onClick={() => setFx("Remove effect", list.filter((_, j) => j !== i))}>
              <Minus size={13} />
            </IconBtn>
          </div>
          {e.type === "layer-blur" ? (
            <NumField label="B" title="Blur" value={e.blur} min={0} onChange={(v) => setFx("Effect", list.map((x, j) => (j === i ? { ...e, blur: v } : x)))} />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1">
                <NumField label="X" value={e.x} onChange={(v) => setFx("Effect", list.map((x, j) => (j === i ? { ...e, x: v } : x)))} />
                <NumField label="Y" value={e.y} onChange={(v) => setFx("Effect", list.map((x, j) => (j === i ? { ...e, y: v } : x)))} />
                <NumField label="B" value={e.blur} min={0} onChange={(v) => setFx("Effect", list.map((x, j) => (j === i ? { ...e, blur: v } : x)))} />
              </div>
              <ColorField color={e.color} opacity={alphaOf(e.color)} onChange={(c, o) => setFx("Effect", list.map((x, j) => (j === i ? { ...e, color: rgba(c, o) } : x)))} />
            </>
          )}
        </div>
      ))}
    </Section>
  );
}

function alphaOf(c: string) {
  const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(c);
  return m ? Number(m[1]) : 1;
}

function rgba(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(a * 100) / 100})`;
}

// ------------------------------------------------------------- type extras --
function ImageSection({ n }: { n: RNode }) {
  const img = n.image!;
  const setImg = (label: string, p: Partial<NonNullable<DNode["image"]>>) => patchSelection(label, (r) => ({ image: { ...(r.image ?? img), ...p } }));
  return (
    <Section title="Image">
      <Select
        value={img.fit}
        options={[
          { value: "fill", label: "Fill" },
          { value: "fit", label: "Fit" },
          { value: "crop", label: "Crop" },
          { value: "tile", label: "Tile" },
        ]}
        onChange={(v) => setImg("Image fit", { fit: v, crop: v === "crop" ? (img.crop ?? { x: 0, y: 0, scale: Math.max(n.w / img.nw, n.h / img.nh) }) : img.crop })}
      />
      {img.fit === "crop" && img.crop && (
        <div className="grid grid-cols-3 gap-1">
          <NumField label="X" value={img.crop.x} onChange={(v) => setImg("Crop", { crop: { ...img.crop!, x: v } })} />
          <NumField label="Y" value={img.crop.y} onChange={(v) => setImg("Crop", { crop: { ...img.crop!, y: v } })} />
          <NumField label="×" title="Scale" value={Math.round(img.crop.scale * 100)} min={1} suffix="%" onChange={(v) => setImg("Crop", { crop: { ...img.crop!, scale: v / 100 } })} />
        </div>
      )}
      <button className="text-[11px] text-accent hover:underline" onClick={() => patchSelection("Original size", { w: img.nw, h: img.nh })}>
        Reset to original size ({img.nw}×{img.nh})
      </button>
    </Section>
  );
}

function LineSection({ n }: { n: RNode }) {
  const caps = n.caps ?? { start: "none", end: "none" };
  const opts = [
    { value: "none", label: "None" },
    { value: "arrow", label: "Arrow" },
    { value: "circle", label: "Circle" },
  ] as const;
  return (
    <Section title="Line ends">
      <div className="grid grid-cols-2 gap-1.5">
        <Select value={caps.start} options={[...opts]} onChange={(v) => patchSelection("Line start", { caps: { ...caps, start: v } })} />
        <Select value={caps.end} options={[...opts]} onChange={(v) => patchSelection("Line end", { caps: { ...caps, end: v } })} />
      </div>
    </Section>
  );
}

function PolySection({ n }: { n: RNode }) {
  return (
    <Section title={n.type === "star" ? "Star" : "Polygon"}>
      <div className="grid grid-cols-2 gap-1.5">
        <NumField label="#" title={n.type === "star" ? "Points" : "Sides"} value={n.sides ?? 5} min={3} max={60} onChange={(v) => patchSelection("Sides", { sides: Math.round(v) })} />
        {n.type === "star" && <NumField label="%" title="Inner radius" value={Math.round((n.innerRatio ?? 0.38) * 100)} min={1} max={100} onChange={(v) => patchSelection("Ratio", { innerRatio: v / 100 })} />}
      </div>
    </Section>
  );
}

function GridSection({ n }: { n: RNode }) {
  const g = n.grid;
  return (
    <Section
      title="Layout grid"
      action={
        g ? (
          <IconBtn title="Remove grid" onClick={() => patchSelection("Remove grid", { grid: null })}>
            <Minus size={14} />
          </IconBtn>
        ) : (
          <IconBtn title="Add column grid" onClick={() => patchSelection("Add grid", { grid: { columns: 12, gutter: 20, margin: 40, visible: true } })}>
            <Plus size={14} />
          </IconBtn>
        )
      }
    >
      {g && (
        <div className="grid grid-cols-3 gap-1">
          <NumField label="#" title="Columns" value={g.columns} min={1} max={48} onChange={(v) => patchSelection("Grid", { grid: { ...g, columns: Math.round(v) } })} />
          <NumField label="G" title="Gutter" value={g.gutter} min={0} onChange={(v) => patchSelection("Grid", { grid: { ...g, gutter: v } })} />
          <NumField label="M" title="Margin" value={g.margin} min={0} onChange={(v) => patchSelection("Grid", { grid: { ...g, margin: v } })} />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------ components --
function ComponentSection({ n }: { n: RNode }) {
  const doc = useDesign((s) => s.doc);
  const library = doc.data.library ?? [];
  const published = library.includes(n.rid);
  const props = doc.nodes[n.rid]?.props ?? [];
  const targets = useMemo(() => {
    const out: { id: string; name: string; type: string }[] = [];
    const visit = (r: RNode) => {
      for (const c of r.children) {
        if (!c.rid.includes("/")) out.push({ id: c.rid, name: c.name, type: c.type });
        visit(c);
      }
    };
    visit(n);
    return out;
  }, [n]);
  const instances = Object.values(doc.nodes).filter((x) => x.type === "instance" && x.componentId === n.rid).length;
  const setProps = (p: NonNullable<DNode["props"]>) => patchSelection("Component properties", { props: p }, [n.rid]);
  return (
    <Section title="Component">
      <TextField value={n.description ?? ""} placeholder="Description" onChange={(v) => patchSelection("Description", { description: v.slice(0, 500) || undefined }, [n.rid])} />
      <label className="flex items-center gap-2 text-xs text-ink">
        <input
          type="checkbox"
          checked={published}
          onChange={(e) => tx("Library", (d) => d.setData((x) => ({ ...x, library: e.target.checked ? [...(x.library ?? []), n.rid] : (x.library ?? []).filter((id) => id !== n.rid) })))}
        />
        Show in the team library
      </label>
      <p className="text-[11px] text-subtle">
        {instances} instance{instances === 1 ? "" : "s"}. Changes here update every instance, except what an instance overrides (text, fills, strokes, visibility, opacity, image).
      </p>
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] font-semibold text-ink">Properties</span>
        <div className="flex gap-1">
          <button
            className="text-[11px] text-accent hover:underline disabled:opacity-40"
            disabled={!targets.some((t) => t.type === "text")}
            onClick={() => {
              const t = targets.find((x) => x.type === "text")!;
              setProps([...props, { id: shortId(), name: t.name, kind: "text", target: t.id, default: doc.nodes[t.id]?.text?.content ?? "" }]);
            }}
          >
            + Text
          </button>
          <button
            className="text-[11px] text-accent hover:underline disabled:opacity-40"
            disabled={!targets.length}
            onClick={() => setProps([...props, { id: shortId(), name: `Show ${targets[0]!.name}`, kind: "boolean", target: targets[0]!.id, default: true }])}
          >
            + Boolean
          </button>
        </div>
      </div>
      {props.map((p, i) => (
        <div key={p.id} className="grid grid-cols-[1fr_1fr_auto] gap-1 items-center">
          <TextField value={p.name} onChange={(v) => setProps(props.map((x, j) => (j === i ? { ...x, name: v.slice(0, 80) || x.name } : x)))} />
          <Select
            value={p.target}
            options={targets.filter((t) => p.kind === "boolean" || t.type === "text").map((t) => ({ value: t.id, label: t.name }))}
            onChange={(v) => setProps(props.map((x, j) => (j === i ? { ...x, target: v } : x)))}
          />
          <IconBtn title="Remove property" onClick={() => setProps(props.filter((_, j) => j !== i))}>
            <Minus size={13} />
          </IconBtn>
        </div>
      ))}
    </Section>
  );
}

function InstanceSection({ n }: { n: RNode }) {
  const doc = useDesign((s) => s.doc);
  const comp = n.componentId ? doc.nodes[n.componentId] : undefined;
  const own = doc.nodes[n.rid];
  const overrides = Object.keys(own?.overrides ?? {}).length + Object.keys(own?.propValues ?? {}).length;
  return (
    <Section title="Instance">
      <div className="text-xs text-ink truncate">◆ {comp?.name ?? "Missing component"}</div>
      {comp?.props?.map((p) => {
        const v = own?.propValues?.[p.id] ?? p.default;
        return p.kind === "text" ? (
          <div key={p.id} className="grid grid-cols-[80px_1fr] gap-1 items-center">
            <span className="text-[11px] text-subtle truncate">{p.name}</span>
            <TextField value={String(v)} onChange={(x) => patchSelection("Instance property", { propValues: { ...(own?.propValues ?? {}), [p.id]: x } }, [n.rid])} />
          </div>
        ) : (
          <label key={p.id} className="flex items-center gap-2 text-xs text-ink">
            <input type="checkbox" checked={!!v} onChange={(e) => patchSelection("Instance property", { propValues: { ...(own?.propValues ?? {}), [p.id]: e.target.checked } }, [n.rid])} />
            {p.name}
          </label>
        );
      })}
      <div className="flex flex-wrap gap-1 pt-1">
        {comp && (
          <button
            className="h-7 px-2 rounded bg-inset text-xs text-ink hover:bg-hover inline-flex items-center gap-1"
            onClick={() => {
              if (comp.page !== S().page) useDesign.setState({ page: comp.page });
              select([comp.id]);
              const r = resolved().byId.get(comp.id);
              if (r) zoomTo({ x: r.ax, y: r.ay, w: r.w, h: r.h }, 120, 2);
            }}
          >
            <Crosshair size={12} /> Main component
          </button>
        )}
        <button className="h-7 px-2 rounded bg-inset text-xs text-ink hover:bg-hover inline-flex items-center gap-1 disabled:opacity-40" disabled={!overrides} onClick={() => resetOverrides(n.rid)}>
          <RotateCcw size={12} /> Reset ({overrides})
        </button>
        <button className="h-7 px-2 rounded bg-inset text-xs text-ink hover:bg-hover inline-flex items-center gap-1" onClick={detachSelection}>
          <Unlink size={12} /> Detach
        </button>
      </div>
    </Section>
  );
}

function OverrideNote({ n }: { n: RNode }) {
  const inst = n.inst ? S().doc.nodes[n.inst] : undefined;
  const has = !!(n.okey && inst?.overrides?.[n.okey]);
  return (
    <Section title="Override">
      <p className="text-[11px] text-subtle">This layer comes from the component. Text, fills, strokes, visibility, opacity and image can change here; everything else follows the main component.</p>
      {has && inst && (
        <button className="h-7 px-2 rounded bg-inset text-xs text-ink hover:bg-hover inline-flex items-center gap-1" onClick={() => resetOverrides(inst.id, n.okey)}>
          <RotateCcw size={12} /> Reset this layer
        </button>
      )}
    </Section>
  );
}
