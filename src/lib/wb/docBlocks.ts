import type { DocBlock, WbItem } from "./types";

// -----------------------------------------------------------------------------
// Doc previews. The canvas can't afford a rich-text editor per doc, so whoever
// edits a doc also writes a short block list into the item's data; the canvas,
// the PNG export and search read that. It is plain data (never HTML), so it
// is safe to render whatever another client wrote.
// -----------------------------------------------------------------------------

const MAX_BLOCKS = 60;
const MAX_TEXT = 300;

interface PMNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

function textIn(n: PMNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return " ";
  return (n.content ?? []).map(textIn).join(n.type === "tableRow" ? " | " : "");
}

const clip = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
};

/** Block list from the editor's JSON (getJSON()). */
export function blocksFromDoc(doc: PMNode): DocBlock[] {
  const out: DocBlock[] = [];
  const walk = (nodes: PMNode[] | undefined, depth: number, list?: "ul" | "ol" | "task") => {
    for (const n of nodes ?? []) {
      if (out.length >= MAX_BLOCKS) return;
      switch (n.type) {
        case "heading": {
          const lv = Number(n.attrs?.level) || 1;
          out.push({ t: lv <= 1 ? "h1" : lv === 2 ? "h2" : "h3", x: clip(textIn(n)) });
          break;
        }
        case "paragraph":
          if (list) out.push({ t: list, x: clip(textIn(n)), n: depth, ...(list === "task" ? { d: false } : {}) });
          else out.push({ t: "p", x: clip(textIn(n)) });
          break;
        case "bulletList":
          walk(n.content, list ? depth + 1 : 0, "ul");
          break;
        case "orderedList":
          walk(n.content, list ? depth + 1 : 0, "ol");
          break;
        case "taskList":
          walk(n.content, list ? depth + 1 : 0, "task");
          break;
        case "listItem":
        case "taskItem": {
          const [first, ...rest] = n.content ?? [];
          if (first) {
            const b: DocBlock = { t: list ?? "ul", x: clip(textIn(first)), n: depth };
            if (n.type === "taskItem") {
              b.t = "task";
              b.d = n.attrs?.checked === true;
            }
            out.push(b);
          }
          walk(rest, depth, list);
          break;
        }
        case "blockquote":
          out.push({ t: "quote", x: clip(textIn(n)) });
          break;
        case "codeBlock":
          out.push({ t: "code", x: clip(textIn(n)) });
          break;
        case "horizontalRule":
          out.push({ t: "hr" });
          break;
        case "table":
          for (const row of n.content ?? []) {
            if (out.length >= MAX_BLOCKS) break;
            const cells = (row.content ?? []).map((c) => textIn(c).trim());
            if (cells.some(Boolean)) out.push({ t: "table", x: clip(cells.join("  |  ")) });
          }
          break;
        default:
          if (n.content) walk(n.content, depth, list);
      }
    }
  };
  walk(doc.content, 0);
  // Trailing empty paragraphs say nothing.
  while (out.length && out[out.length - 1]!.t === "p" && !out[out.length - 1]!.x) out.pop();
  return out;
}

/** Validated blocks from item data (another client wrote them). */
export function docBlocks(it: WbItem): DocBlock[] {
  const raw = it.data.blocks;
  if (!Array.isArray(raw)) return [];
  const out: DocBlock[] = [];
  for (const b of raw.slice(0, MAX_BLOCKS)) {
    if (!b || typeof b !== "object") continue;
    const t = (b as DocBlock).t;
    if (!["h1", "h2", "h3", "p", "ul", "ol", "task", "quote", "code", "hr", "table"].includes(t)) continue;
    const x = (b as DocBlock).x;
    const n = (b as DocBlock).n;
    out.push({
      t,
      x: typeof x === "string" ? x.slice(0, MAX_TEXT) : "",
      d: (b as DocBlock).d === true,
      n: typeof n === "number" && n > 0 ? Math.min(6, Math.floor(n)) : 0,
    });
  }
  return out;
}

export function docTitle(it: WbItem): string {
  const t = it.data.title;
  return typeof t === "string" && t.trim() ? t.trim() : "Untitled doc";
}

/** Everything searchable in a doc preview. */
export function docText(it: WbItem): string {
  return [docTitle(it), ...docBlocks(it).map((b) => b.x ?? "")].filter(Boolean).join("\n");
}
