import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { exportLayers } from "@/lib/design/exporter";
import { useDesign } from "@/lib/design/store";
import { Section, Select } from "./fields";

// -----------------------------------------------------------------------------
// "Export" in the inspector: the selected layers (or every top-level frame on
// the page) as PNG / JPG / SVG / PDF at a chosen scale.
// -----------------------------------------------------------------------------

type Format = "png" | "jpg" | "svg" | "pdf";

export function ExportSection({ ids }: { ids: string[] }) {
  const toast = useToast();
  const canCopy = useDesign((s) => s.canCopy);
  const [format, setFormat] = useState<Format>("png");
  const [scale, setScale] = useState(2);
  const [busy, setBusy] = useState(false);
  if (!canCopy) return null;
  const run = async () => {
    const s = useDesign.getState();
    let targets = ids;
    if (!targets.length)
      targets = Object.values(s.doc.nodes)
        .filter((n) => n.page === s.page && !n.parent && (n.type === "frame" || n.type === "component"))
        .sort((a, b) => a.order - b.order)
        .map((n) => n.id);
    if (!targets.length) return toast.push({ kind: "info", title: "Nothing to export", description: "Select layers or add a frame first." });
    setBusy(true);
    try {
      await exportLayers(s.doc, targets, { format, scale });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't export", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={ids.length ? `Export ${ids.length > 1 ? `${ids.length} layers` : "layer"}` : "Export all frames"}>
      <div className="grid grid-cols-[1fr_1fr] gap-1.5">
        <Select
          value={format}
          options={[
            { value: "png", label: "PNG" },
            { value: "jpg", label: "JPG" },
            { value: "svg", label: "SVG" },
            { value: "pdf", label: "PDF" },
          ]}
          onChange={(v) => setFormat(v)}
        />
        <Select
          value={scale}
          options={[0.5, 1, 1.5, 2, 3, 4].map((x) => ({ value: x, label: `${x}x` }))}
          onChange={(v) => setScale(v)}
          disabled={format === "svg"}
        />
      </div>
      <button
        className="w-full h-7 rounded bg-inset text-xs text-ink hover:bg-hover inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
        onClick={run}
        disabled={busy}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Export
      </button>
    </Section>
  );
}
