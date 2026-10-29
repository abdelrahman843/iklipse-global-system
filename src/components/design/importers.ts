import { importDesignFile, importSvg, parseDesignFile, toDesignFile } from "@/lib/design/io";
import { topOrder } from "@/lib/design/doc";
import { select, tx, useDesign } from "@/lib/design/store";

// -----------------------------------------------------------------------------
// Importing into the open document: SVG (as editable vectors) and the native
// JSON format (pages appended, ids fresh). Each import is one undo step.
// -----------------------------------------------------------------------------

const S = useDesign.getState;

export function importSvgText(svg: string, at: { x: number; y: number }, name?: string) {
  const s = S();
  if (!s.canEdit) return;
  const nodes = importSvg(svg, s.page, null, at);
  if (!nodes.length) throw new Error("Nothing in that SVG could be imported.");
  const roots = nodes.filter((n) => n.parent === null);
  let order = topOrder(s.doc, null, s.page);
  for (const r of roots) {
    r.order = order++;
    if (name) r.name = name;
  }
  tx("Import SVG", (d) => {
    for (const n of nodes) d.put(n);
  });
  select(roots.map((r) => r.id));
}

export function importDesignJson(text: string): number {
  const s = S();
  if (!s.canEdit) return 0;
  const file = parseDesignFile(text);
  const out = importDesignFile(file, s.doc);
  tx(
    "Import design file",
    (d) => {
      d.setData(() => out.data);
      for (const n of out.nodes) d.put(n);
    },
    { select: [] },
  );
  if (out.pages[0]) useDesign.setState({ page: out.pages[0].id });
  return out.nodes.length;
}

export function exportDesignJson(name: string) {
  const file = toDesignFile(S().doc, name);
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w\- ]+/g, "").trim() || "design"}.design.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
