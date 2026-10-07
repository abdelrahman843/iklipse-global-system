import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Columns3, Copy, Download, Ellipsis, GalleryVerticalEnd, NotebookPen, Plus, Presentation, Rows3, Trash2, X } from "lucide-react";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useWb, commit, mergeItem, deleteItems, animateViewport, worldToScreen } from "@/lib/wb/store";
import { orderedFrames } from "@/lib/wb/frames";
import { geomBounds } from "@/lib/wb/geometry";
import { cssColor, str, type WbItem } from "@/lib/wb/types";
import { LAYOUTS, addSlide, arrangeSlides, duplicateSlide, moveSlide, slideNotes, slideViewport, type LayoutKey } from "@/lib/wb/slides";
import { exportSlidesPdf } from "@/lib/wb/exportImage";
import { ItemRender } from "../ItemView";

// -----------------------------------------------------------------------------
// Slides view (Miro's presentation format). The canvas stays live and editable
// but locks onto one frame at a time; a rail lists the slides (drag to
// reorder) and the speaker notes sit under the slide.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

/** Space the rail, notes and toolbar take, so the slide fits in what's left. */
function insets(notesOpen: boolean) {
  if (isPhone()) return { left: 12, right: 12, top: 132, bottom: 64 + 104 + (notesOpen ? 132 : 0) + 12 };
  return { left: 236 + 60, right: 24, top: 76, bottom: notesOpen ? 168 : 24 };
}

export function exitSlides() {
  set({ slideMode: false, slideId: null });
}

/** Open the slides view on the selected frame (or the frame around the selection). */
export function enterSlides() {
  const s = S();
  const frames = orderedFrames(s.items);
  let id: string | null = null;
  for (const sel of s.selection) {
    const it = s.items[sel];
    const fid = it?.type === "frame" ? it.id : it?.frame_id;
    if (fid && s.items[fid]) {
      id = fid;
      break;
    }
  }
  set({ slideMode: true, slideId: id ?? frames[0]?.id ?? null, panel: null, selection: [] });
}

export function SlidesView({ title }: { title: string }) {
  const slideMode = useWb((s) => s.slideMode);
  const presenting = useWb((s) => s.presenting);
  if (!slideMode || presenting) return null;
  return <Slides title={title} />;
}

function Slides({ title }: { title: string }) {
  const toast = useToast();
  const items = useWb((s) => s.items);
  const slideId = useWb((s) => s.slideId);
  const canEdit = useWb((s) => s.canEdit);
  const canCopy = useWb((s) => s.canCopy);
  const sw = useWb((s) => s.screen.w);
  const sh = useWb((s) => s.screen.h);
  const frames = useMemo(() => orderedFrames(items), [items]);
  const [notesOpen, setNotesOpen] = useState(() => !isPhone());
  const [exporting, setExporting] = useState(false);
  const cur = frames.find((f) => f.id === slideId) ?? frames[0];

  // Content per slide, for the thumbnails.
  const kids = useMemo(() => {
    const m = new Map<string, WbItem[]>();
    for (const it of Object.values(items)) {
      if (!it.frame_id) continue;
      const list = m.get(it.frame_id);
      if (list) list.push(it);
      else m.set(it.frame_id, [it]);
    }
    for (const list of m.values()) list.sort((a, b) => a.z - b.z);
    return m;
  }, [items]);

  // Keep a valid slide picked (deleted, or none yet).
  useEffect(() => {
    if (cur && cur.id !== slideId) set({ slideId: cur.id });
  }, [cur, slideId]);

  // Fit the slide whenever it changes, moves or the screen does.
  const fitKey = cur ? `${cur.id}:${cur.x}:${cur.y}:${cur.w}:${cur.h}` : "";
  useEffect(() => {
    if (!cur) return;
    animateViewport(slideViewport(cur, insets(notesOpen)), 280);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, sw, sh, notesOpen]);

  const go = (id: string) => set({ slideId: id, selection: [], editing: null });

  // Page Up / Page Down step through slides when nothing is selected (arrows stay for nudging).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // With something selected the keys keep their canvas meaning (bring to front / send to back).
      if ((e.key !== "PageDown" && e.key !== "PageUp") || S().selection.length) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
      const list = orderedFrames(S().items);
      const i = list.findIndex((f) => f.id === S().slideId);
      const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === "PageDown" ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        e.stopPropagation();
        go(next.id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = frames.findIndex((f) => f.id === e.active.id);
    const to = frames.findIndex((f) => f.id === e.over!.id);
    if (from >= 0 && to >= 0) moveSlide(from, to);
  };

  const doExport = async () => {
    setExporting(true);
    try {
      await exportSlidesPdf({ title });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't export", description: (e as Error).message });
    } finally {
      setExporting(false);
    }
  };

  const present = () => frames.length && set({ presenting: true });

  return (
    <>
      <aside
        data-wb-ui
        aria-label="Slides"
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "absolute z-20 bg-surface border border-border rounded-lg shadow-pop flex overflow-hidden animate-slide-up",
          "md:left-3 md:top-[4.25rem] md:bottom-3 md:w-[212px] md:flex-col",
          "max-md:left-2 max-md:right-2 max-md:bottom-[4rem] max-md:h-[100px] max-md:flex-row",
        )}
      >
        <div className="shrink-0 flex md:items-center max-md:flex-col max-md:justify-center gap-1 p-1.5 md:pl-3 md:border-b max-md:border-r border-line">
          <span className="max-md:hidden flex-1 text-sm font-semibold text-ink">
            Slides <span className="text-xs font-normal text-subtle tabular-nums">{frames.length}</span>
          </span>
          {canEdit && <AddSlideMenu after={cur?.id ?? null} />}
          <Menu
            align="right"
            trigger={
              <button className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" title="More" aria-label="More slide options">
                <Ellipsis size={16} />
              </button>
            }
          >
            {(close) => (
              <div className="min-w-[210px]">
                <MenuItem disabled={!frames.length} onClick={() => (present(), close())}>
                  <span className="inline-flex items-center gap-2">
                    <Presentation size={14} /> Present
                  </span>
                </MenuItem>
                {canCopy && (
                  <MenuItem disabled={!frames.length || exporting} onClick={() => (void doExport(), close())}>
                    <span className="inline-flex items-center gap-2">
                      <Download size={14} /> {exporting ? "Exporting…" : "Export slides as PDF"}
                    </span>
                  </MenuItem>
                )}
                <MenuItem onClick={() => (setNotesOpen((o) => !o), close())}>
                  <span className="inline-flex items-center gap-2">
                    <NotebookPen size={14} /> {notesOpen ? "Hide notes" : "Show notes"}
                  </span>
                </MenuItem>
                {canEdit && frames.length > 1 && (
                  <>
                    <MenuDivider />
                    <MenuItem onClick={() => (arrangeSlides("row"), close())}>
                      <span className="inline-flex items-center gap-2">
                        <Columns3 size={14} /> Line up side by side
                      </span>
                    </MenuItem>
                    <MenuItem onClick={() => (arrangeSlides("column"), close())}>
                      <span className="inline-flex items-center gap-2">
                        <Rows3 size={14} /> Stack under each other
                      </span>
                    </MenuItem>
                  </>
                )}
                <MenuDivider />
                <MenuItem onClick={() => (exitSlides(), close())}>
                  <span className="inline-flex items-center gap-2">
                    <X size={14} /> Back to board
                  </span>
                </MenuItem>
              </div>
            )}
          </Menu>
        </div>

        {frames.length === 0 ? (
          <div className="flex-1 grid place-items-center p-4 text-center">
            <div>
              <GalleryVerticalEnd size={26} className="mx-auto text-subtle max-md:hidden" />
              <p className="md:mt-2 text-sm font-medium text-ink">No slides yet</p>
              <p className="mt-1 text-xs text-muted max-md:hidden">{canEdit ? "Add one with the + button. Every frame is a slide too." : "Frames on this board show up here."}</p>
            </div>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={frames.map((f) => f.id)} strategy={rectSortingStrategy}>
              <ol data-wb-scroll className="flex-1 min-h-0 min-w-0 flex md:flex-col gap-1.5 p-2 overflow-auto overscroll-contain [scrollbar-width:thin]">
                {frames.map((f, i) => (
                  <SlideRow key={f.id} frame={f} index={i} kids={kids.get(f.id)} active={f.id === cur?.id} canEdit={canEdit} onGo={() => go(f.id)} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}

        <div className="shrink-0 p-2 md:border-t max-md:border-l border-line max-md:flex max-md:items-center">
          <button
            onClick={present}
            disabled={!frames.length}
            className="w-full h-10 max-md:w-10 inline-flex items-center justify-center gap-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover disabled:opacity-50 active:scale-[0.97] transition-transform"
            title="Present"
          >
            <Presentation size={16} />
            <span className="max-md:hidden">Present</span>
          </button>
        </div>
      </aside>

      {cur && <NotesPanel frame={cur} open={notesOpen} onToggle={() => setNotesOpen((o) => !o)} canEdit={canEdit} />}
    </>
  );
}

// ------------------------------------------------------------- add slide --
function AddSlideMenu({ after }: { after: string | null }) {
  return (
    <Menu
      align="right"
      trigger={
        <button className="h-8 w-8 grid place-items-center rounded-md bg-accent-soft text-accent hover:bg-accent hover:text-white transition-colors" title="Add slide" aria-label="Add slide">
          <Plus size={17} />
        </button>
      }
    >
      {(close) => (
        <div className="w-[264px] p-1">
          <div className="px-2 pt-1 pb-2 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">New slide</div>
          <div className="grid grid-cols-2 gap-1.5">
            {LAYOUTS.map((l) => (
              <button
                key={l.key}
                role="menuitem"
                onClick={() => {
                  addSlide(l.key, after);
                  close();
                }}
                className="group rounded-md p-1.5 text-left hover:bg-inset focus-visible:bg-inset outline-none"
              >
                <LayoutSketch k={l.key} />
                <span className="block mt-1 text-xs text-ink truncate">{l.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Menu>
  );
}

/** Small drawing of a layout for the picker. */
function LayoutSketch({ k }: { k: LayoutKey }) {
  const bar = (x: number, y: number, w: number, h = 5, o = 1) => <rect x={x} y={y} width={w} height={h} rx={1.5} style={{ fill: k === "section" ? "#ffffff" : "rgb(var(--c-ink))", opacity: o }} />;
  return (
    <svg viewBox="0 0 112 63" className="block w-full rounded border border-border group-hover:border-accent transition-colors" aria-hidden>
      <rect x={0} y={0} width={112} height={63} style={{ fill: k === "section" ? "#0055cc" : "rgb(var(--c-surface))" }} />
      {k === "title" && (
        <>
          {bar(26, 22, 60, 7)}
          {bar(36, 35, 40, 4, 0.4)}
        </>
      )}
      {k === "content" && (
        <>
          {bar(10, 9, 50, 6)}
          {bar(10, 23, 70, 3, 0.4)}
          {bar(10, 31, 64, 3, 0.4)}
          {bar(10, 39, 68, 3, 0.4)}
        </>
      )}
      {k === "two" && (
        <>
          {bar(10, 9, 50, 6)}
          {bar(10, 24, 40, 4, 0.7)}
          {bar(10, 33, 38, 3, 0.4)}
          {bar(10, 40, 34, 3, 0.4)}
          {bar(60, 24, 40, 4, 0.7)}
          {bar(60, 33, 38, 3, 0.4)}
          {bar(60, 40, 34, 3, 0.4)}
        </>
      )}
      {k === "media" && (
        <>
          {bar(10, 14, 38, 6)}
          {bar(10, 27, 40, 3, 0.4)}
          {bar(10, 35, 36, 3, 0.4)}
          <rect x={60} y={9} width={42} height={45} rx={3} style={{ fill: "#8590a2", opacity: 0.25 }} />
        </>
      )}
      {k === "section" && (
        <>
          {bar(10, 24, 60, 8)}
          {bar(10, 37, 40, 4, 0.7)}
        </>
      )}
      {k === "quote" && (
        <>
          {bar(22, 20, 68, 6, 0.85)}
          {bar(30, 30, 52, 6, 0.85)}
          {bar(42, 44, 28, 3, 0.4)}
        </>
      )}
    </svg>
  );
}

// ----------------------------------------------------------- slide rows --
interface RowProps {
  frame: WbItem;
  index: number;
  kids: WbItem[] | undefined;
  active: boolean;
  canEdit: boolean;
  onGo: () => void;
}

const SlideRow = memo(function SlideRow({ frame, index, kids, active, canEdit, onGo }: RowProps) {
  const confirm = useConfirm();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: frame.id, disabled: !canEdit });
  const title = str(frame.data.title, "Slide");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const cancelled = useRef(false);
  const ref = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const finish = () => {
    setRenaming(false);
    const t = draft.trim().slice(0, 120);
    if (!cancelled.current && t && t !== title) {
      const it = useWb.getState().items[frame.id];
      if (it) commit({ [frame.id]: mergeItem(it, { data: { title: t } }) });
    }
  };

  const remove = async () => {
    const ok = await confirm({ title: "Delete slide?", message: `"${title}" and everything on it will be deleted.`, confirmLabel: "Delete", danger: true });
    if (ok) deleteItems([frame.id]);
  };

  return (
    <li
      ref={(el) => {
        setNodeRef(el);
        ref.current = el;
      }}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined }}
      className={cn("group shrink-0 max-md:w-[132px] relative", isDragging && "opacity-80")}
    >
      <div
        aria-current={active || undefined}
        aria-label={`Slide ${index + 1}: ${title}`}
        onClick={() => !renaming && onGo()}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onGo();
          }
        }}
        {...attributes}
        {...listeners}
        className={cn(
          "rounded-md p-1 outline-none cursor-pointer transition-colors focus-visible:ring-2 focus-visible:ring-accent-ring",
          active ? "bg-accent-soft" : "hover:bg-inset",
        )}
      >
        <div className="flex items-start gap-1.5">
          <span className={cn("w-4 pt-0.5 text-[11px] font-semibold tabular-nums text-right shrink-0", active ? "text-accent" : "text-subtle")}>{index + 1}</span>
          <SlideThumb frame={frame} kids={kids} active={active} />
        </div>
        <div className="pl-[22px] mt-1 min-w-0">
          {renaming ? (
            <input
              autoFocus
              value={draft}
              maxLength={120}
              aria-label="Slide name"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
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
              className="block w-full h-7 px-1.5 rounded-md border border-accent bg-surface text-lg sm:text-xs text-ink outline-none"
            />
          ) : (
            <div
              className={cn("text-xs truncate", active ? "text-accent font-medium" : "text-ink")}
              title={canEdit ? `${title} (double-click to rename)` : title}
              onDoubleClick={() => {
                if (!canEdit || frame.locked) return;
                cancelled.current = false;
                setDraft(title);
                setRenaming(true);
              }}
            >
              {title}
            </div>
          )}
        </div>
      </div>
      {canEdit && !renaming && (
        <div className="absolute right-1.5 top-1.5 hidden group-hover:flex group-focus-within:flex gap-0.5">
          <RowBtn title="Duplicate slide" onClick={() => duplicateSlide(frame.id)}>
            <Copy size={13} />
          </RowBtn>
          {!frame.locked && (
            <RowBtn title="Delete slide" onClick={() => void remove()}>
              <Trash2 size={13} />
            </RowBtn>
          )}
        </div>
      )}
    </li>
  );
}, sameRow);

function sameRow(a: RowProps, b: RowProps) {
  if (a.frame !== b.frame || a.index !== b.index || a.active !== b.active || a.canEdit !== b.canEdit) return false;
  const ka = a.kids ?? [];
  const kb = b.kids ?? [];
  return ka.length === kb.length && ka.every((x, i) => x === kb[i]);
}

function RowBtn({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="h-6 w-6 grid place-items-center rounded bg-surface/95 border border-border text-muted hover:text-ink shadow-card"
    >
      {children}
    </button>
  );
}

/** The slide as it looks, scaled down (real item rendering, no interaction). */
function SlideThumb({ frame, kids, active }: { frame: WbItem; kids: WbItem[] | undefined; active: boolean }) {
  const W = 160;
  const k = W / Math.max(frame.w, 1);
  const H = Math.max(24, Math.round(frame.h * k));
  return (
    <div
      className={cn("relative overflow-hidden rounded-[3px] border pointer-events-none flex-1 min-w-0", active ? "border-accent ring-1 ring-accent" : "border-border")}
      style={{ height: H, maxWidth: W, background: cssColor(str(frame.data.fill, "surface")) }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${k}) translate(${-frame.x}px, ${-frame.y}px)`, ["--wb-zoom" as string]: k }}>
        {(kids ?? []).slice(0, 200).map((it) => (
          <ItemRender key={it.id} it={it} still />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- notes --
function NotesPanel({ frame, open, onToggle, canEdit }: { frame: WbItem; open: boolean; onToggle: () => void; canEdit: boolean }) {
  const stored = slideNotes(frame);
  const [draft, setDraft] = useState(stored);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(stored);
  }, [stored, frame.id]);

  const save = (t: string) => {
    const it = S().items[frame.id];
    if (!it) return;
    commit({ [frame.id]: mergeItem(it, { data: { notes: t ? t.slice(0, 5000) : undefined } }) }, { key: `notes:${frame.id}` });
  };

  return (
    <section
      data-wb-ui
      aria-label="Speaker notes"
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "absolute z-20 bg-surface border border-border rounded-lg shadow-pop flex flex-col overflow-hidden",
        "md:left-[296px] md:right-3 md:bottom-3",
        "max-md:left-2 max-md:right-2 max-md:bottom-[calc(4rem+108px)]",
        open ? "md:h-[144px] max-md:h-[124px]" : "h-9",
      )}
    >
      <button onClick={onToggle} className="shrink-0 h-9 flex items-center gap-2 px-3 text-left text-sm text-ink hover:bg-inset" aria-expanded={open}>
        <NotebookPen size={14} className="text-subtle" />
        <span className="font-medium">Notes</span>
        <span className="text-xs text-subtle truncate">{str(frame.data.title, "Slide")}</span>
        <ChevronDown size={14} className={cn("ml-auto text-subtle transition-transform", !open && "rotate-180")} />
      </button>
      {open &&
        (canEdit ? (
          <textarea
            value={draft}
            maxLength={5000}
            placeholder="Add speaker notes. Only you see them while presenting."
            aria-label="Speaker notes"
            onFocus={() => (focused.current = true)}
            onBlur={() => (focused.current = false)}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              setDraft(e.target.value);
              save(e.target.value);
            }}
            className="flex-1 min-h-0 resize-none px-3 pb-2 bg-transparent text-lg sm:text-sm text-ink placeholder:text-subtle outline-none"
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-auto px-3 pb-2 text-sm text-ink whitespace-pre-wrap">{stored || <span className="text-subtle">No notes on this slide.</span>}</div>
        ))}
    </section>
  );
}

// ----------------------------------------------------------------- mask --
/** Dims the board around the slide being edited (inside the canvas, under its UI). */
export function SlideMask() {
  const on = useWb((s) => s.slideMode && !s.presenting);
  const frame = useWb((s) => (s.slideId ? s.items[s.slideId] : undefined));
  const vp = useWb((s) => s.viewport);
  if (!on || !frame) return null;
  const b = geomBounds(frame);
  const a = worldToScreen({ x: b.x, y: b.y }, vp);
  return (
    <div
      aria-hidden
      className="absolute pointer-events-none rounded-[2px]"
      style={{
        left: a.x,
        top: a.y,
        width: b.w * vp.zoom,
        height: b.h * vp.zoom,
        boxShadow: "0 0 0 1px rgb(var(--c-border)), 0 0 0 200vmax rgb(var(--c-bg) / 0.82)",
      }}
    />
  );
}
