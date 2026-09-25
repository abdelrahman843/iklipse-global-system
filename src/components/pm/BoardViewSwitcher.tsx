import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Kanban, Calendar, Table2, BarChart3, GanttChart, Archive, Check, ChevronUp, Inbox, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PermissionKey } from "@/lib/database.types";

export type BoardView = "board" | "calendar" | "table" | "timeline" | "dashboard" | "archive";

export const BOARD_VIEWS: BoardView[] = ["board", "calendar", "table", "timeline", "dashboard", "archive"];

const VIEWS: { key: BoardView; label: string; hint: string; icon: React.ReactNode; perm?: PermissionKey }[] = [
  { key: "board", label: "Board", hint: "Lists and cards", icon: <Kanban size={16} /> },
  { key: "calendar", label: "Calendar", hint: "Cards by due date", icon: <Calendar size={16} />, perm: "pm.calendar_view" },
  { key: "table", label: "Table", hint: "Sortable spreadsheet", icon: <Table2 size={16} />, perm: "pm.table_view" },
  { key: "timeline", label: "Timeline", hint: "Start → due bars", icon: <GanttChart size={16} />, perm: "pm.timeline_view" },
  { key: "dashboard", label: "Dashboard", hint: "Charts and stats", icon: <BarChart3 size={16} />, perm: "pm.dashboard_view" },
];
const ARCHIVE_PERM: PermissionKey = "pm.archive_card";

export function viewAllowed(v: BoardView, can: (perm: PermissionKey) => boolean) {
  if (v === "archive") return can(ARCHIVE_PERM);
  const perm = VIEWS.find((x) => x.key === v)?.perm;
  return !perm || can(perm);
}

// Last view per board survives reloads and card-modal navigation.
const viewKey = (boardId: string) => `board-view:${boardId}`;
export function readBoardView(boardId: string): BoardView {
  try {
    const v = localStorage.getItem(viewKey(boardId)) as BoardView | null;
    if (v && BOARD_VIEWS.includes(v)) return v;
  } catch {
    /* storage blocked */
  }
  return "board";
}
export function saveBoardView(boardId: string, v: BoardView) {
  try {
    localStorage.setItem(viewKey(boardId), v);
  } catch {
    /* ignore */
  }
}

interface DockProps {
  value: BoardView;
  onChange: (v: BoardView) => void;
  can: (perm: PermissionKey) => boolean;
  /** Link target for the Automation button; omitted when the viewer can't see it. */
  automationHref?: string;
  inboxOpen?: boolean;
  onToggleInbox?: () => void;
  unread?: number;
}

// Trello-style floating dock pinned to the bottom of the board: a drop-up
// view picker, Archive, and Automation.
export function BoardDock({ value, onChange, can, automationHref, inboxOpen, onToggleInbox, unread = 0 }: DockProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const views = VIEWS.filter((v) => !v.perm || can(v.perm));
  const current = VIEWS.find((v) => v.key === value);
  const inViews = !!current;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = current ?? VIEWS[0]!;

  return (
    <div
      ref={root}
      className="pointer-events-auto relative flex items-center gap-1 rounded-xl border border-border bg-surface/90 backdrop-blur-md p-1.5 shadow-raise animate-slide-up"
    >
      {/* Drop-up menu */}
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 w-60 rounded-md border border-border bg-surface p-1 shadow-pop origin-bottom-left animate-scale-in"
        >
          <div className="px-3 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">Views</div>
          {views.map((v) => {
            const active = v.key === value;
            return (
              <button
                key={v.key}
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onChange(v.key);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-3 rounded-md px-3 py-1.5 text-sm text-left transition-colors",
                  active ? "bg-accent-soft text-accent" : "text-ink hover:bg-inset",
                )}
              >
                <span className={cn("shrink-0", active ? "text-accent" : "text-muted")}>{v.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium">{v.label}</span>
                  <span className="block text-xs text-subtle">{v.hint}</span>
                </span>
                {active && <Check size={15} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}

      {onToggleInbox && (
        <DockButton active={!!inboxOpen} onClick={onToggleInbox} title="Inbox">
          <span className="relative">
            <Inbox size={16} />
            {unread > 0 && (
              <span
                key={unread}
                className="absolute -top-1.5 -right-2 h-4 min-w-4 px-1 rounded-full bg-danger text-white text-[10px] font-semibold grid place-items-center animate-scale-in"
              >
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </span>
          <span className="hidden sm:inline">Inbox</span>
        </DockButton>
      )}

      <DockButton
        active={inViews}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch view"
      >
        {shown.icon}
        <span>{shown.label}</span>
        <ChevronUp size={14} className={cn("transition-transform duration-200", !open && "rotate-180")} />
      </DockButton>

      {can(ARCHIVE_PERM) && (
        <DockButton active={value === "archive"} onClick={() => onChange(value === "archive" ? "board" : "archive")} title="Archived cards and lists">
          <Archive size={16} />
          <span className="hidden sm:inline">Archive</span>
        </DockButton>
      )}

      {automationHref && (
        <>
          <span className="mx-1 h-6 w-px bg-line" aria-hidden />
          <Link
            to={automationHref}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg text-sm font-medium text-ink hover:bg-inset transition-colors active:scale-[0.97]"
          >
            <Zap size={16} className="text-warn" />
            <span className="hidden sm:inline">Automation</span>
          </Link>
        </>
      )}
    </div>
  );
}

function DockButton({ active, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      {...rest}
      className={cn(
        "relative inline-flex items-center gap-2 h-9 px-3 rounded-lg text-sm font-medium transition-colors active:scale-[0.97]",
        active ? "bg-accent-soft text-accent" : "text-ink hover:bg-inset",
        className,
      )}
    >
      {children}
      {/* Trello-style underline on the active item */}
      <span
        aria-hidden
        className={cn(
          "absolute left-1/2 -translate-x-1/2 bottom-0.5 h-0.5 rounded-full bg-accent transition-all duration-300 ease-pop",
          active ? "w-4 opacity-100" : "w-0 opacity-0",
        )}
      />
    </button>
  );
}
