import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, NotebookPen, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useWb, animateViewport, viewportFor } from "@/lib/wb/store";
import { geomBounds } from "@/lib/wb/geometry";
import { orderedFrames } from "@/lib/wb/frames";
import { slideNotes } from "@/lib/wb/slides";
import { str } from "@/lib/wb/types";

// -----------------------------------------------------------------------------
// Presenting: one slide (frame) at a time, fitted to the screen, full screen.
// The presenter bar has the slide count, elapsed time and speaker notes.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

export function PresentMode() {
  const presenting = useWb((s) => s.presenting);
  if (!presenting) return null;
  return <Presenter />;
}

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

/** Slide to open on: the slides view's slide, the selected frame (or the frame around the selection), else the first. */
function startIndex(): number {
  const s = S();
  const list = orderedFrames(s.items);
  const ids = s.slideMode && s.slideId ? [s.slideId] : s.selection;
  for (const id of ids) {
    const it = s.items[id];
    const fid = it?.type === "frame" ? it.id : it?.frame_id;
    const i = fid ? list.findIndex((f) => f.id === fid) : -1;
    if (i >= 0) return i;
  }
  return 0;
}

function clock(ms: number) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function Presenter() {
  const items = useWb((s) => s.items);
  const sw = useWb((s) => s.screen.w);
  const sh = useWb((s) => s.screen.h);
  const frames = useMemo(() => orderedFrames(items), [items]);
  const [idx, setIdx] = useState(startIndex);
  const [notes, setNotes] = useState(false);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const barRef = useRef<HTMLDivElement>(null);
  const count = frames.length;
  const i = Math.min(idx, Math.max(0, count - 1));
  const cur = frames[i];
  const next = frames[i + 1];

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Enter: read-only canvas (hand tool, nothing selected), full screen. Leave: undo both.
  useEffect(() => {
    set({ selection: [], tool: "hand", editing: null, hover: null, following: null, draftComment: null, openThread: null });
    // The board itself goes full screen (falls back to the whole page).
    const target = barRef.current?.parentElement ?? document.documentElement;
    let wentFull = false;
    let live = true;
    const onFs = () => {
      if (document.fullscreenElement) wentFull = true;
      else if (wentFull) set({ presenting: false });
    };
    document.addEventListener("fullscreenchange", onFs);
    if (document.fullscreenEnabled && !document.fullscreenElement && target.requestFullscreen) {
      target.requestFullscreen().catch(() => {
        if (live && !document.fullscreenElement && target !== document.documentElement) {
          document.documentElement.requestFullscreen?.().catch(() => undefined);
        }
      });
    }
    // No edits while presenting: swallow the canvas menu and clipboard pastes.
    const block = (e: Event) => {
      if (isTyping(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const evs = ["contextmenu", "paste", "cut", "drop"] as const;
    for (const ev of evs) window.addEventListener(ev, block, true);
    return () => {
      live = false;
      document.removeEventListener("fullscreenchange", onFs);
      for (const ev of evs) window.removeEventListener(ev, block, true);
      set({ tool: "select" });
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  // Nothing left to show.
  useEffect(() => {
    if (!count) set({ presenting: false });
  }, [count]);

  // The slides view follows along, so leaving lands on the slide you stopped at.
  useEffect(() => {
    if (cur && S().slideMode) set({ slideId: cur.id });
  }, [cur]);

  // Fit the current frame (again when it moves or the screen changes size).
  const fitKey = cur ? `${cur.id}:${cur.x}:${cur.y}:${cur.w}:${cur.h}:${cur.rotation}` : "";
  useEffect(() => {
    if (!cur) return;
    animateViewport(viewportFor(geomBounds(cur), 0, 8), 420);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, sw, sh]);

  const go = (n: number) => setIdx(Math.max(0, Math.min(count - 1, n)));
  const exit = () => set({ presenting: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      // A focused bar button handles its own Space / Enter.
      if ((e.key === " " || e.key === "Enter") && (e.target as HTMLElement | null)?.closest?.("button")) return;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
        case "Enter":
          setIdx((v) => Math.min(count - 1, v + 1));
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
        case "Backspace":
          setIdx((v) => Math.max(0, v - 1));
          break;
        case "Home":
          setIdx(0);
          break;
        case "End":
          setIdx(Math.max(0, count - 1));
          break;
        case "n":
        case "N":
          setNotes((o) => !o);
          break;
        case "Escape":
          set({ presenting: false });
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  const btn =
    "h-10 w-10 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted";
  const text = slideNotes(cur);
  return (
    <>
      {/* Progress along the top edge. */}
      <div data-wb-ui className="absolute z-40 top-0 inset-x-0 h-1 bg-line/60 pointer-events-none">
        <div className="h-full bg-accent transition-[width] duration-300 ease-pop" style={{ width: count ? `${((i + 1) / count) * 100}%` : 0 }} />
      </div>

      {notes && (
        <div
          data-wb-ui
          className="absolute z-40 left-3 right-3 sm:left-auto sm:w-[380px] bottom-[5.25rem] max-h-[45%] flex flex-col bg-surface border border-border rounded-lg shadow-raise animate-slide-up"
          style={{ marginBottom: "env(safe-area-inset-bottom)" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="shrink-0 flex items-center gap-2 px-3 h-10 border-b border-line">
            <NotebookPen size={14} className="text-subtle" />
            <span className="text-sm font-semibold text-ink">Notes</span>
            <span className="ml-auto text-xs text-subtle tabular-nums">{clock(now - started)}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-3 py-2 text-sm text-ink whitespace-pre-wrap">
            {text || <span className="text-subtle">No notes on this slide.</span>}
          </div>
          {next && (
            <div className="shrink-0 px-3 py-2 border-t border-line text-xs text-subtle truncate">
              Next: <span className="text-ink">{str(next.data.title, "Slide")}</span>
            </div>
          )}
        </div>
      )}

      <div
        ref={barRef}
        data-wb-ui
        role="toolbar"
        aria-label="Presentation"
        className="absolute z-40 left-1/2 -translate-x-1/2 bottom-4 max-w-[calc(100%-24px)] flex items-center gap-1 p-1 bg-surface border border-border rounded-lg shadow-raise animate-slide-up"
        style={{ marginBottom: "env(safe-area-inset-bottom)" }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" className={btn} onClick={() => go(i - 1)} disabled={i === 0} title="Previous (Left arrow)" aria-label="Previous slide">
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0 px-2 text-center">
          <div className="text-sm font-semibold text-ink tabular-nums whitespace-nowrap" aria-live="polite">
            {count ? i + 1 : 0} of {count}
          </div>
          {cur && <div className="max-w-[220px] max-sm:max-w-[110px] truncate text-xs text-subtle">{str(cur.data.title, "Slide")}</div>}
        </div>
        <button type="button" className={btn} onClick={() => go(i + 1)} disabled={i >= count - 1} title="Next (Right arrow)" aria-label="Next slide">
          <ChevronRight size={20} />
        </button>
        <span className="w-px h-6 bg-line mx-0.5 shrink-0" />
        <span className="px-1.5 text-xs text-subtle tabular-nums max-sm:hidden" title="Time presenting">
          {clock(now - started)}
        </span>
        <button
          type="button"
          className={cn(btn, notes && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent")}
          onClick={() => setNotes((o) => !o)}
          title="Speaker notes (N)"
          aria-label="Speaker notes"
          aria-pressed={notes}
        >
          <NotebookPen size={17} />
        </button>
        <button type="button" className={btn} onClick={exit} title="Exit (Esc)" aria-label="Exit presentation">
          <X size={18} />
        </button>
      </div>
    </>
  );
}
