import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isWeekend,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { CalendarClock, Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Card, Label as LabelT, List } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { dueStatus } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useIsNarrow } from "@/lib/useMediaQuery";

interface Props {
  cards: Card[];
  lists: List[];
  labelsById: Map<string, LabelT>;
  cardLabelsByCard: Map<string, string[]>;
  onOpenCard: (id: string) => void;
  /** Present only when the viewer may change dates — enables drag to reschedule. */
  onReschedule?: (cardId: string, due: string) => void;
}

// Week starts Monday so the grid lines up with the Mon…Sun header.
const WEEK = { weekStartsOn: 1 as const };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView({ cards, lists, labelsById, cardLabelsByCard, onOpenCard, onReschedule }: Props) {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [dir, setDir] = useState<"next" | "prev">("next");
  const [dropKey, setDropKey] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [more, setMore] = useState<{ key: string; rect: DOMRect } | null>(null);
  const narrow = useIsNarrow();
  const perCell = narrow ? 2 : 3;

  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);

  const go = (delta: number) => {
    setDir(delta > 0 ? "next" : "prev");
    setCursor((d) => (delta > 0 ? addMonths(d, 1) : subMonths(d, 1)));
    setMore(null);
  };
  const goToday = () => {
    const t = startOfMonth(new Date());
    setDir(t > cursor ? "next" : "prev");
    setCursor(t);
    setMore(null);
  };

  const grid = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), WEEK);
    const end = endOfWeek(endOfMonth(cursor), WEEK);
    const days: Date[] = [];
    for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
    return days;
  }, [cursor]);

  const byDay = useMemo(() => {
    const m = new Map<string, Card[]>();
    for (const c of cards) {
      if (!c.due_date) continue;
      const key = format(new Date(c.due_date), "yyyy-MM-dd");
      const arr = m.get(key) ?? [];
      arr.push(c);
      m.set(key, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1));
    return m;
  }, [cards]);

  const monthCount = useMemo(
    () => cards.filter((c) => c.due_date && isSameMonth(new Date(c.due_date), cursor)).length,
    [cards, cursor],
  );
  const undated = useMemo(() => cards.filter((c) => !c.due_date).length, [cards]);

  // Arrow keys page months when nothing editable has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable=true], [role=dialog]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function drop(day: Date, cardId: string) {
    setDropKey(null);
    setDragId(null);
    const card = cards.find((c) => c.id === cardId);
    if (!card || !onReschedule) return;
    const next = new Date(day);
    if (card.due_date) {
      const old = new Date(card.due_date);
      if (isSameDay(old, day)) return;
      next.setHours(old.getHours(), old.getMinutes(), 0, 0);
    } else {
      next.setHours(12, 0, 0, 0);
    }
    onReschedule(cardId, next.toISOString());
  }

  const chip = (c: Card, inPopover = false) => {
    const status = dueStatus(c.due_date, c.due_completed);
    const labelIds = cardLabelsByCard.get(c.id) ?? [];
    const stripe = labelsById.get(labelIds[0] ?? "")?.color ?? listById.get(c.list_id)?.color ?? null;
    return (
      <button
        key={c.id}
        draggable={!!onReschedule}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/card-id", c.id);
          e.dataTransfer.effectAllowed = "move";
          setDragId(c.id);
        }}
        onDragEnd={() => {
          setDragId(null);
          setDropKey(null);
        }}
        onClick={() => {
          setMore(null);
          onOpenCard(c.id);
        }}
        title={`${c.title}${c.due_date ? ` · ${format(new Date(c.due_date), "p")}` : ""}`}
        className={cn(
          "group/chip relative w-full text-left flex items-center gap-1 rounded-md pl-2 pr-1.5 py-[3px] font-medium overflow-hidden",
          "border transition-[background-color,box-shadow,transform,opacity] duration-150 hover:-translate-y-px hover:shadow-pop",
          inPopover ? "text-sm py-1.5" : "text-[10px] sm:text-xs",
          status === "completed"
            ? "bg-success/10 border-success/25 text-success"
            : status === "overdue"
              ? "bg-danger/10 border-danger/25 text-danger"
              : "bg-surface border-line text-ink hover:border-rule",
          onReschedule && "cursor-grab active:cursor-grabbing",
          dragId === c.id && "opacity-40",
        )}
      >
        {stripe && <span className="absolute left-0 inset-y-0 w-[3px]" style={{ background: stripe }} />}
        {status === "completed" && <Check size={11} className="shrink-0" />}
        <span className={cn("truncate flex-1", status === "completed" && "line-through opacity-80")}>{c.title}</span>
        {inPopover && c.due_date && <span className="text-xs text-subtle tabular-nums">{format(new Date(c.due_date), "p")}</span>}
      </button>
    );
  };

  const moreCards = more ? byDay.get(more.key) ?? [] : [];

  return (
    <div className="p-2 sm:p-4 h-full flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex items-center rounded-md border border-border bg-surface shadow-card">
          <button
            className="h-8 w-8 grid place-items-center text-muted hover:text-ink hover:bg-inset rounded-l-md transition-colors"
            onClick={() => go(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="w-32 sm:w-40 text-center text-sm sm:text-base font-semibold text-ink tabular-nums select-none">
            {format(cursor, "MMMM yyyy")}
          </div>
          <button
            className="h-8 w-8 grid place-items-center text-muted hover:text-ink hover:bg-inset rounded-r-md transition-colors"
            onClick={() => go(1)}
            aria-label="Next month"
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <Button size="sm" variant="secondary" onClick={goToday} disabled={isSameMonth(cursor, new Date())}>
          Today
        </Button>
        <div className="flex-1" />
        <div className="flex items-center gap-3 text-xs text-muted">
          <span>
            <span className="font-semibold text-ink tabular-nums">{monthCount}</span> due this month
          </span>
          {undated > 0 && (
            <span className="hidden sm:inline">
              <span className="font-semibold text-ink tabular-nums">{undated}</span> without a date
            </span>
          )}
          {onReschedule && <span className="hidden lg:inline text-subtle">Drag a card to another day to reschedule</span>}
        </div>
      </div>

      <div className="grid grid-cols-7 text-[10px] text-subtle mb-1 uppercase tracking-[0.3px]">
        {DAY_NAMES.map((d, i) => (
          <div key={d} className={cn("px-1 sm:px-2 py-1 font-semibold text-center", i >= 5 && "text-subtle/70")}>
            <span className="sm:hidden">{d[0]}</span>
            <span className="hidden sm:inline">{d}</span>
          </div>
        ))}
      </div>

      <div
        key={format(cursor, "yyyy-MM")}
        className={cn(
          "flex-1 min-h-0 grid grid-cols-7 auto-rows-fr gap-px bg-border rounded-lg overflow-hidden border border-border shadow-card",
          dir === "next" ? "month-next" : "month-prev",
        )}
      >
        {grid.map((d) => {
          const key = format(d, "yyyy-MM-dd");
          const dayCards = byDay.get(key) ?? [];
          const inMonth = isSameMonth(d, cursor);
          const today = isSameDay(d, new Date());
          const hidden = dayCards.length - perCell;
          return (
            <div
              key={key}
              onDragOver={(e) => {
                if (!onReschedule || !dragId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dropKey !== key) setDropKey(key);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropKey((k) => (k === key ? null : k));
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/card-id");
                if (id) drop(d, id);
              }}
              className={cn(
                "relative p-1 sm:p-1.5 min-h-[56px] sm:min-h-[96px] flex flex-col gap-0.5 sm:gap-1 overflow-hidden transition-colors duration-150",
                inMonth ? (isWeekend(d) ? "bg-surface/80" : "bg-surface") : "bg-inset/70",
                dropKey === key && "bg-accent-soft ring-2 ring-inset ring-accent",
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "inline-grid place-items-center h-5 min-w-5 px-1 rounded-full text-[10px] sm:text-[11px] font-medium tabular-nums",
                    today ? "bg-accent text-white font-bold pulse-ring" : inMonth ? "text-muted" : "text-subtle/70",
                  )}
                >
                  {format(d, "d")}
                </span>
                {dayCards.length > 0 && !narrow && (
                  <span className="text-[10px] text-subtle tabular-nums">{dayCards.length}</span>
                )}
              </div>
              {dayCards.slice(0, perCell).map((c) => chip(c))}
              {hidden > 0 && (
                <button
                  className="text-left text-[10px] sm:text-[11px] text-muted hover:text-ink font-medium px-1 rounded hover:bg-inset transition-colors"
                  onClick={(e) => setMore({ key, rect: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect() })}
                >
                  +{hidden} more
                </button>
              )}
            </div>
          );
        })}
      </div>

      {more && <DayPopover date={new Date(more.key + "T00:00")} rect={more.rect} onClose={() => setMore(null)}>{moreCards.map((c) => chip(c, true))}</DayPopover>}
    </div>
  );
}

// Floating list of every card due on one day, anchored over its cell.
function DayPopover({ date, rect, onClose, children }: { date: Date; rect: DOMRect; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const width = Math.max(240, rect.width + 24);
  const left = Math.min(Math.max(8, rect.left - 12), window.innerWidth - width - 8);
  const top = Math.min(rect.top - 8, window.innerHeight - 320);
  return (
    <div
      ref={ref}
      className="fixed z-50 rounded-lg border border-border bg-surface shadow-raise p-2 animate-scale-in"
      style={{ left, top: Math.max(8, top), width }}
    >
      <div className="flex items-center gap-2 px-1 pb-2">
        <CalendarClock size={14} className="text-muted" />
        <div className="flex-1 text-sm font-semibold text-ink">{format(date, "EEEE, MMM d")}</div>
        <button onClick={onClose} className="p-1 rounded text-subtle hover:text-ink hover:bg-inset" aria-label="Close">
          <X size={14} />
        </button>
      </div>
      <div className="space-y-1 max-h-72 overflow-y-auto">{children}</div>
    </div>
  );
}
