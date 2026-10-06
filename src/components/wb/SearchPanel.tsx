import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { CreditCard, FileText, Frame, Search, Shapes, Spline, StickyNote, Type, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useWb, select, animateViewport, viewportFor, geomOf } from "@/lib/wb/store";
import { connectorGeometry, geomBounds, type Rect } from "@/lib/wb/geometry";
import { str, type ConnectorData, type ItemType, type WbItem } from "@/lib/wb/types";
import { docText } from "@/lib/wb/docBlocks";
import { PanelHeader } from "./PanelHeader";

// -----------------------------------------------------------------------------
// Find text on the board. Enter / arrows step through the matches, each one is
// selected and brought into view.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const MAX_RESULTS = 300;

const ICONS: Partial<Record<ItemType, typeof StickyNote>> = {
  sticky: StickyNote,
  shape: Shapes,
  text: Type,
  card: CreditCard,
  frame: Frame,
  connector: Spline,
  doc: FileText,
};

const TYPE_NAMES: Partial<Record<ItemType, string>> = {
  sticky: "Sticky note",
  shape: "Shape",
  text: "Text",
  card: "Card",
  frame: "Frame",
  connector: "Line",
  doc: "Doc",
};

/** The searchable text of an item. */
function textOf(it: WbItem): string {
  const d = it.data;
  switch (it.type) {
    case "sticky":
    case "shape":
    case "text":
      return str(d.text);
    case "card":
      return [str(d.title), str(d.description)].filter(Boolean).join("\n");
    case "frame":
      return str(d.title);
    case "connector":
      return str(d.label);
    case "doc":
      return docText(it);
    default:
      return "";
  }
}

function boundsOf(it: WbItem): Rect {
  if (it.type === "connector") return connectorGeometry(it.data as ConnectorData, (id) => geomOf(S(), id)).bounds;
  return geomBounds(it);
}

interface Hit {
  id: string;
  type: ItemType;
  before: string;
  match: string;
  after: string;
  r: Rect;
}

function find(items: Record<string, WbItem>, q: string): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: Hit[] = [];
  for (const it of Object.values(items)) {
    const text = textOf(it).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 28);
    const end = Math.min(text.length, at + needle.length + 60);
    out.push({
      id: it.id,
      type: it.type,
      before: (start > 0 ? "…" : "") + text.slice(start, at),
      match: text.slice(at, at + needle.length),
      after: text.slice(at + needle.length, end) + (end < text.length ? "…" : ""),
      r: boundsOf(it),
    });
  }
  // Reading order: top to bottom, then left to right.
  out.sort((a, b) => Math.round(a.r.y / 40) - Math.round(b.r.y / 40) || a.r.x - b.r.x);
  return out;
}

function reveal(id: string) {
  const it = S().items[id];
  if (!it) return;
  select([id]);
  animateViewport(viewportFor(boundsOf(it), 120, 1));
}

export function SearchPanel({ onClose }: { onClose: () => void }) {
  const items = useWb((s) => s.items);
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hits = useMemo(() => find(items, query), [items, query]);
  const shown = hits.slice(0, MAX_RESULTS);

  useEffect(() => setActive(-1), [query]);

  // Ctrl+F while the panel is open puts the cursor back in the box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-hit="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const goTo = (n: number) => {
    if (!shown.length) return;
    const i = ((n % shown.length) + shown.length) % shown.length;
    setActive(i);
    reveal(shown[i]!.id);
  };

  return (
    <div
      className="flex-1 min-h-0 flex flex-col"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <PanelHeader title="Search" icon={<Search size={16} />} onClose={onClose} />
      <div className="shrink-0 p-3 pb-2">
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
          <input
            ref={inputRef}
            autoFocus
            type="search"
            value={q}
            placeholder="Find on this board"
            aria-label="Find on this board"
            enterKeyHint="search"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                goTo(e.shiftKey ? active - 1 : active + 1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                goTo(active + 1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                goTo(active < 0 ? shown.length - 1 : active - 1);
              }
            }}
            className="block w-full h-10 pl-8 pr-[4.5rem] rounded-md border border-border bg-surface text-lg sm:text-base text-ink placeholder:text-subtle outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring [&::-webkit-search-cancel-button]:hidden"
          />
          <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {query.trim() && (
              <span className="text-xs text-subtle tabular-nums whitespace-nowrap">
                {hits.length ? `${active >= 0 ? active + 1 : 0}/${hits.length}` : "0"}
              </span>
            )}
            {q && (
              <button
                type="button"
                title="Clear"
                aria-label="Clear search"
                onClick={() => {
                  setQ("");
                  inputRef.current?.focus();
                }}
                className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
              >
                <X size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div data-wb-scroll className="flex-1 min-h-0 overflow-auto overscroll-contain px-2 pb-2">
        {!query.trim() ? (
          <p className="px-2 py-6 text-center text-sm text-muted">Find text in sticky notes, shapes, cards, frames and lines.</p>
        ) : !hits.length ? (
          <p className="px-2 py-6 text-center text-sm text-muted">No matches</p>
        ) : (
          <ul ref={listRef} className="flex flex-col gap-0.5" role="listbox" aria-label="Matches">
            {shown.map((h, i) => {
              const Icon = ICONS[h.type] ?? Type;
              const on = i === active;
              return (
                <li key={h.id} role="option" aria-selected={on}>
                  <button
                    type="button"
                    data-hit={i}
                    onClick={() => {
                      setActive(i);
                      reveal(h.id);
                      if (window.matchMedia("(max-width: 767px)").matches) onClose();
                    }}
                    className={cn(
                      "w-full min-h-10 flex items-start gap-2.5 px-2 py-2 rounded-md text-left transition-colors",
                      on ? "bg-accent-soft" : "hover:bg-inset",
                    )}
                  >
                    <Icon size={15} className={cn("mt-0.5 shrink-0", on ? "text-accent" : "text-subtle")} aria-label={TYPE_NAMES[h.type]} />
                    <span className="min-w-0 flex-1 text-sm text-muted line-clamp-2 break-words">
                      {h.before}
                      <mark className="bg-accent-soft text-ink font-semibold rounded-sm">{h.match}</mark>
                      {h.after}
                    </span>
                  </button>
                </li>
              );
            })}
            {hits.length > shown.length && <li className="px-2 py-2 text-xs text-subtle">Showing the first {MAX_RESULTS} matches</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
