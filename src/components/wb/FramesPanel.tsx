import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Layers, Pencil, Presentation, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useWb, commit, patchItem, mergeItem, select, animateViewport, viewportFor } from "@/lib/wb/store";
import { geomBounds } from "@/lib/wb/geometry";
import { orderedFrames } from "@/lib/wb/frames";
import { cssColor, str, type WbItem } from "@/lib/wb/types";
import { PanelHeader } from "./PanelHeader";

// -----------------------------------------------------------------------------
// Frames panel (slide list: go to, rename, reorder) and presentation mode,
// which fits one frame at a time to the screen.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

function goToFrame(f: WbItem) {
  select([f.id]);
  animateViewport(viewportFor(geomBounds(f), 40, 4));
}

/** Write a new slide order (one undo step). */
function reorder(list: WbItem[], from: number, to: number) {
  if (to < 0 || to >= list.length || from === to) return;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  const changes: Record<string, WbItem> = {};
  next.forEach((f, i) => {
    if (f.data.order !== i) changes[f.id] = mergeItem(f, { data: { order: i } });
  });
  commit(changes);
}

export function FramesPanel({ onClose }: { onClose: () => void }) {
  const items = useWb((s) => s.items);
  const canEdit = useWb((s) => s.canEdit);
  const selection = useWb((s) => s.selection);
  const frames = useMemo(() => orderedFrames(items), [items]);
  // Content per frame, for the thumbnails.
  const kids = useMemo(() => {
    const m = new Map<string, WbItem[]>();
    for (const it of Object.values(items)) {
      if (!it.frame_id || it.type === "connector") continue;
      const list = m.get(it.frame_id);
      if (list) list.push(it);
      else m.set(it.frame_id, [it]);
    }
    return m;
  }, [items]);
  const current = selection.length === 1 ? selection[0] : null;

  return (
    <>
      <PanelHeader title="Frames" icon={<Layers size={16} />} onClose={onClose} />
      <div data-wb-scroll className="flex-1 overflow-auto overscroll-contain p-2">
        {frames.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Layers size={28} className="mx-auto text-subtle" />
            <p className="mt-3 text-sm font-medium text-ink">No frames yet</p>
            <p className="mt-1 text-sm text-muted">
              {canEdit ? "Add one with the Frame tool (F). Each frame becomes a slide." : "Frames on this board will show up here."}
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {frames.map((f, i) => (
              <FrameRow
                key={f.id}
                frame={f}
                index={i}
                count={frames.length}
                kids={kids.get(f.id)}
                canEdit={canEdit}
                active={current === f.id}
                onGo={() => {
                  goToFrame(f);
                  if (isPhone()) onClose();
                }}
                onMove={(dir) => reorder(frames, i, i + dir)}
              />
            ))}
          </ol>
        )}
      </div>
      <div className="shrink-0 p-3 border-t border-line">
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!frames.length}
          iconLeft={<Presentation size={16} />}
          onClick={() => set({ presenting: true, panel: null })}
        >
          Present
        </Button>
      </div>
    </>
  );
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-surface hover:text-ink transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
    >
      {children}
    </button>
  );
}

const FrameRow = memo(function FrameRow({
  frame,
  index,
  count,
  kids,
  canEdit,
  active,
  onGo,
  onMove,
}: {
  frame: WbItem;
  index: number;
  count: number;
  kids: WbItem[] | undefined;
  canEdit: boolean;
  active: boolean;
  onGo: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const title = str(frame.data.title, "Frame");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!renaming) setDraft(title);
  }, [title, renaming]);
  const canRename = canEdit && !frame.locked;
  const startRename = () => {
    if (!canRename) return;
    cancelled.current = false;
    setDraft(title);
    setRenaming(true);
  };
  const finish = () => {
    setRenaming(false);
    if (cancelled.current) return;
    const t = draft.trim().slice(0, 120);
    if (t && t !== title) patchItem(frame.id, { data: { title: t } });
  };

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-current={active || undefined}
        onClick={() => !renaming && onGo()}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onGo();
          } else if (e.key === "F2") {
            e.preventDefault();
            startRename();
          }
        }}
        className={cn(
          "flex items-center gap-2.5 p-1.5 pr-1 rounded-md cursor-pointer outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-ring",
          active ? "bg-accent-soft" : "hover:bg-inset",
        )}
      >
        <span className="relative shrink-0">
          <FrameThumb frame={frame} kids={kids} />
          <span className="absolute left-1 top-1 min-w-4 h-4 px-1 rounded-sm bg-surface/90 text-[10px] leading-none font-semibold text-ink grid place-items-center tabular-nums">
            {index + 1}
          </span>
        </span>
        <div className="flex-1 min-w-0">
          {renaming ? (
            <input
              autoFocus
              value={draft}
              maxLength={120}
              aria-label="Frame name"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  cancelled.current = true;
                  e.currentTarget.blur();
                }
              }}
              onBlur={finish}
              className="block w-full h-8 px-1.5 -ml-1.5 rounded-md border border-accent bg-surface text-lg sm:text-sm text-ink outline-none"
            />
          ) : (
            <div className={cn("text-sm font-medium truncate", active ? "text-accent" : "text-ink")} title={title} onDoubleClick={startRename}>
              {title}
            </div>
          )}
          <div className="text-xs text-subtle tabular-nums truncate">
            {Math.round(frame.w)} × {Math.round(frame.h)}
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center shrink-0">
            <IconBtn title="Rename" onClick={startRename} disabled={!canRename}>
              <Pencil size={15} />
            </IconBtn>
            <IconBtn title="Move up" onClick={() => onMove(-1)} disabled={index === 0}>
              <ChevronUp size={17} />
            </IconBtn>
            <IconBtn title="Move down" onClick={() => onMove(1)} disabled={index === count - 1}>
              <ChevronDown size={17} />
            </IconBtn>
          </div>
        )}
      </div>
    </li>
  );
});

/** Tiny sketch of a frame and the things inside it. */
function FrameThumb({ frame, kids }: { frame: WbItem; kids: WbItem[] | undefined }) {
  const list = (kids ?? []).slice().sort((a, b) => a.z - b.z).slice(0, 300);
  return (
    <svg
      viewBox={`0 0 ${Math.max(frame.w, 1)} ${Math.max(frame.h, 1)}`}
      preserveAspectRatio="xMidYMid meet"
      className="block h-10 w-16 rounded-sm border border-border bg-inset"
      aria-hidden
    >
      <rect x={0} y={0} width={frame.w} height={frame.h} style={{ fill: cssColor(str(frame.data.fill, "surface")) }} />
      {list.map((it) => {
        const b = geomBounds(it);
        const fill =
          it.type === "sticky"
            ? str(it.data.fill, "#f5cd47")
            : it.type === "shape"
              ? str(it.data.fill, "surface") === "none"
                ? str(it.data.stroke, "ink")
                : str(it.data.fill, "surface")
              : it.type === "card"
                ? str(it.data.fill, "#579dff")
                : it.type === "text" || it.type === "pen"
                  ? str(it.data.color, "ink")
                  : "#8590a2";
        const faint = it.type === "text" || it.type === "pen" || (it.type === "shape" && str(it.data.fill, "surface") === "none");
        return (
          <rect
            key={it.id}
            x={b.x - frame.x}
            y={b.y - frame.y}
            width={Math.max(b.w, 2)}
            height={Math.max(b.h, 2)}
            style={{ fill: cssColor(fill), opacity: faint ? 0.4 : it.type === "shape" ? 0.85 : 1 }}
          />
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------- presenting --
export function PresentMode() {
  const presenting = useWb((s) => s.presenting);
  if (!presenting) return null;
  return <Presenter />;
}

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

/** Slide to open on: the selected frame (or the frame around the selection), else the first. */
function startIndex(): number {
  const s = S();
  const list = orderedFrames(s.items);
  for (const id of s.selection) {
    const it = s.items[id];
    const fid = it?.type === "frame" ? it.id : it?.frame_id;
    const i = fid ? list.findIndex((f) => f.id === fid) : -1;
    if (i >= 0) return i;
  }
  return 0;
}

function Presenter() {
  const items = useWb((s) => s.items);
  const sw = useWb((s) => s.screen.w);
  const sh = useWb((s) => s.screen.h);
  const frames = useMemo(() => orderedFrames(items), [items]);
  const [idx, setIdx] = useState(startIndex);
  const barRef = useRef<HTMLDivElement>(null);
  const count = frames.length;
  const i = Math.min(idx, Math.max(0, count - 1));
  const cur = frames[i];

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
  return (
    <div
      ref={barRef}
      data-wb-ui
      role="toolbar"
      aria-label="Presentation"
      className="absolute z-40 left-1/2 -translate-x-1/2 bottom-4 max-w-[calc(100%-24px)] flex items-center gap-1 p-1 bg-surface border border-border rounded-lg shadow-raise animate-slide-up"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" className={btn} onClick={() => go(i - 1)} disabled={i === 0} title="Previous (Left arrow)" aria-label="Previous frame">
        <ChevronLeft size={20} />
      </button>
      <div className="min-w-0 px-2 text-center">
        <div className="text-sm font-semibold text-ink tabular-nums whitespace-nowrap" aria-live="polite">
          {count ? i + 1 : 0} of {count}
        </div>
        {cur && <div className="max-w-[220px] max-sm:max-w-[120px] truncate text-xs text-subtle">{str(cur.data.title, "Frame")}</div>}
      </div>
      <button type="button" className={btn} onClick={() => go(i + 1)} disabled={i >= count - 1} title="Next (Right arrow)" aria-label="Next frame">
        <ChevronRight size={20} />
      </button>
      <span className="w-px h-6 bg-line mx-0.5 shrink-0" />
      <button type="button" className={btn} onClick={exit} title="Exit (Esc)" aria-label="Exit presentation">
        <X size={18} />
      </button>
    </div>
  );
}
