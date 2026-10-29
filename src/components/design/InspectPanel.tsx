import { useMemo } from "react";
import { Copy } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { cssFor, cssText } from "@/lib/design/css";
import type { RNode } from "@/lib/design/layout";
import { resolved, useDesign } from "@/lib/design/store";
import { Section } from "./fields";

// -----------------------------------------------------------------------------
// Developer handoff ("Inspect" tab): measurements, colours, typography and
// CSS for the selected layer, each value one click to copy.
// -----------------------------------------------------------------------------

export function InspectPanel() {
  const doc = useDesign((s) => s.doc);
  const page = useDesign((s) => s.page);
  const selection = useDesign((s) => s.selection);
  const { byId, parentOf } = useMemo(() => resolved(doc, page), [doc, page]);
  const n = selection.length === 1 ? byId.get(selection[0]!) : undefined;
  if (!n) return <p className="p-3 text-xs text-subtle">Select one layer to see its measurements and CSS.</p>;
  const parent = parentOf.get(n.rid) ?? null;
  const rules = cssFor(n, parent);
  return (
    <div>
      <Section title="Measurements">
        <Rows
          rows={[
            ["Width", `${r(n.w)}px`],
            ["Height", `${r(n.h)}px`],
            ["Left (in parent)", `${r(n.x)}px`],
            ["Top (in parent)", `${r(n.y)}px`],
            ...(parent ? ([["Right gap", `${r(parent.w - n.x - n.w)}px`], ["Bottom gap", `${r(parent.h - n.y - n.h)}px`]] as [string, string][]) : []),
            ...(n.rotation ? ([["Rotation", `${r(n.rotation)}°`]] as [string, string][]) : []),
            ...(n.layout ? ([["Gap", `${n.layout.gap}px`], ["Padding", `${n.layout.padding.t}px ${n.layout.padding.r}px ${n.layout.padding.b}px ${n.layout.padding.l}px`]] as [string, string][]) : []),
          ]}
        />
      </Section>
      <Colors n={n} />
      {n.text && (
        <Section title="Typography">
          <Rows
            rows={[
              ["Font", n.text.fontFamily],
              ["Weight", String(n.text.fontWeight)],
              ["Size", `${n.text.fontSize}px`],
              ["Line height", n.text.lineHeight ? `${n.text.lineHeight}px` : "auto"],
              ["Letter spacing", `${n.text.letterSpacing ?? 0}px`],
              ["Content", n.text.content],
            ]}
          />
        </Section>
      )}
      <Section title="CSS" action={<CopyBtn text={cssText(rules)} label="Copy all" />}>
        <pre className="text-[11px] leading-4 font-mono text-ink bg-inset rounded p-2 overflow-auto whitespace-pre-wrap break-all">{cssText(rules)}</pre>
      </Section>
    </div>
  );
}

function Colors({ n }: { n: RNode }) {
  const list: [string, string][] = [];
  n.fills.forEach((f, i) => {
    if (f.type === "solid") list.push([`Fill ${i + 1}`, withAlpha(f.color, f.opacity)]);
    else f.stops.forEach((s, j) => list.push([`Fill ${i + 1} stop ${j + 1}`, s.color]));
  });
  n.strokes.forEach((s, i) => list.push([`Stroke ${i + 1} (${s.width}px)`, s.color]));
  (n.effects ?? []).forEach((e, i) => "color" in e && list.push([`Effect ${i + 1}`, e.color]));
  if (!list.length) return null;
  return (
    <Section title="Colours">
      {list.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 text-xs">
          <span className="h-4 w-4 rounded border border-border shrink-0" style={{ background: v }} />
          <span className="text-subtle w-24 truncate">{k}</span>
          <span className="font-mono text-ink truncate flex-1">{v}</span>
          <CopyBtn text={v} />
        </div>
      ))}
    </Section>
  );
}

function withAlpha(hex: string, a?: number) {
  if (a === undefined || a >= 1) return hex.toUpperCase();
  return `${hex.toUpperCase()}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase()}`;
}

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 text-xs">
          <span className="text-subtle w-28 shrink-0">{k}</span>
          <span className="font-mono text-ink truncate flex-1" title={v}>
            {v}
          </span>
          <CopyBtn text={v} />
        </div>
      ))}
    </>
  );
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      className="h-6 px-1.5 rounded text-subtle hover:bg-hover hover:text-ink inline-flex items-center gap-1 text-[11px]"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => toast.push({ kind: "success", title: "Copied" }),
          () => toast.push({ kind: "error", title: "Couldn't copy" }),
        );
      }}
    >
      <Copy size={11} />
      {label}
    </button>
  );
}

function r(v: number) {
  return Math.round(v * 100) / 100;
}
