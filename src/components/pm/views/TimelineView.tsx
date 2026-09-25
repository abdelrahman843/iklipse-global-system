import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, differenceInCalendarDays, format, isSameDay, max, min, startOfDay } from "date-fns";
import { CalendarRange, Crosshair } from "lucide-react";
import type { Card, List } from "@/lib/database.types";
import { dueStatus } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { useIsNarrow } from "@/lib/useMediaQuery";

type Zoom = "day" | "week" | "month";
const ZOOM_PX: Record<Zoom, number> = { day: 40, week: 18, month: 6 };
const ZOOM_KEY = "timeline-zoom";

function readZoom(): Zoom {
  try {
    const z = localStorage.getItem(ZOOM_KEY);
    if (z === "day" || z === "week" || z === "month") return z;
  } catch {
    /* storage blocked */
  }
  return "day";
}

export function TimelineView({
  cards,
  lists,
  onOpenCard,
}: {
  cards: Card[];
  lists: List[];
  onOpenCard: (id: string) => void;
}) {
  const [zoom, setZoomState] = useState<Zoom>(readZoom);
  const setZoom = (z: Zoom) => {
    setZoomState(z);
    try {
      localStorage.setItem(ZOOM_KEY, z);
    } catch {
      /* ignore */
    }
  };
  const narrow = useIsNarrow();
  const NAME_W = narrow ? 140 : 220;
  const px = ZOOM_PX[zoom];
  const scroller = useRef<HTMLDivElement>(null);
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);

  const scheduled = useMemo(
    () =>
      cards
        .filter((c) => c.start_date || c.due_date)
        .sort((a, b) => ((a.start_date ?? a.due_date)! < (b.start_date ?? b.due_date)! ? -1 : 1)),
    [cards],
  );
  const unscheduled = cards.length - scheduled.length;

  // Range always includes today so the "today" marker is never off the map.
  const { rangeStart, days } = useMemo(() => {
    const today = startOfDay(new Date());
    const starts = [today, ...scheduled.map((c) => new Date(c.start_date ?? c.due_date!))];
    const ends = [today, ...scheduled.map((c) => new Date(c.due_date ?? c.start_date!))];
    const pad = zoom === "day" ? 3 : zoom === "week" ? 7 : 20;
    const s = startOfDay(addDays(min(starts), -pad));
    const e = startOfDay(addDays(max(ends), pad * 2));
    return { rangeStart: s, days: Math.max(differenceInCalendarDays(e, s) + 1, zoom === "day" ? 30 : zoom === "week" ? 70 : 180) };
  }, [scheduled, zoom]);

  const todayX = differenceInCalendarDays(new Date(), rangeStart) * px;

  const scrollToToday = (smooth: boolean) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: Math.max(0, todayX - (el.clientWidth - NAME_W) / 3), behavior: smooth ? "smooth" : "auto" });
  };
  // Land on today on first paint and whenever the scale changes.
  useLayoutEffect(() => scrollToToday(false), [zoom, rangeStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => addDays(rangeStart, i)), [rangeStart, days]);

  // Month spans for the top header row.
  const months = useMemo(() => {
    const out: { label: string; left: number; width: number }[] = [];
    dayList.forEach((d, i) => {
      const last = out.at(-1);
      const label = format(d, zoom === "month" ? "MMM yyyy" : "MMMM yyyy");
      if (last && last.label === label) last.width += px;
      else out.push({ label, left: i * px, width: px });
    });
    return out;
  }, [dayList, px, zoom]);

  const trackW = days * px;

  return (
    <div className="p-2 sm:p-4 h-full flex flex-col min-h-0">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="inline-flex items-center gap-1 rounded-lg bg-inset border border-line p-1">
          {(["day", "week", "month"] as Zoom[]).map((z) => (
            <button
              key={z}
              onClick={() => setZoom(z)}
              className={cn(
                "h-8 px-3 text-sm rounded-md font-medium capitalize transition-[background-color,color,box-shadow] duration-150",
                zoom === z ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
              )}
            >
              {z}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => scrollToToday(true)} iconLeft={<Crosshair size={14} />}>
          Today
        </Button>
        <div className="flex-1" />
        <div className="text-xs text-muted">
          <span className="font-semibold text-ink tabular-nums">{scheduled.length}</span> scheduled
          {unscheduled > 0 && (
            <>
              {" · "}
              <span className="font-semibold text-ink tabular-nums">{unscheduled}</span> without dates
            </>
          )}
        </div>
      </div>

      {scheduled.length === 0 ? (
        <div className="flex-1 grid place-items-center rounded-lg border border-dashed border-rule view-enter">
          <div className="text-center px-6">
            <div className="mx-auto mb-3 h-12 w-12 rounded-full bg-inset border border-line grid place-items-center text-muted">
              <CalendarRange size={22} />
            </div>
            <div className="text-base font-semibold text-ink">Nothing on the timeline yet</div>
            <p className="mt-1 text-sm text-muted max-w-sm">Give cards a start or due date and they'll appear here as bars.</p>
          </div>
        </div>
      ) : (
        <div ref={scroller} className="flex-1 min-h-0 overflow-auto rounded-lg border border-border bg-surface shadow-card">
          <div className="relative" style={{ width: NAME_W + trackW }}>
            {/* Header — sticky to the top; its first cell also sticks left. */}
            <div className="sticky top-0 z-20 flex bg-inset/95 backdrop-blur border-b border-border">
              <div
                className="sticky left-0 z-10 shrink-0 bg-inset px-3 flex items-end pb-2 text-[11px] uppercase text-muted font-semibold tracking-eyebrow border-r border-border"
                style={{ width: NAME_W }}
              >
                Card
              </div>
              <div className="relative shrink-0 h-12" style={{ width: trackW }}>
                {months.map((m) => (
                  <div
                    key={m.label + m.left}
                    className="absolute top-0 h-5 border-l border-line px-2 text-[11px] font-semibold text-ink truncate leading-5"
                    style={{ left: m.left, width: m.width }}
                  >
                    {m.label}
                  </div>
                ))}
                {zoom !== "month" &&
                  dayList.map((d, i) => {
                    const show = zoom === "day" || d.getDay() === 1;
                    if (!show) return null;
                    const today = isSameDay(d, new Date());
                    return (
                      <div
                        key={i}
                        className="absolute top-5 h-7 border-l border-line text-center"
                        style={{ left: i * px, width: zoom === "day" ? px : px * 7 }}
                      >
                        <div
                          className={cn(
                            "mx-auto mt-0.5 w-fit min-w-5 px-1 rounded-full text-[11px] font-medium tabular-nums leading-5",
                            today ? "bg-accent text-white" : "text-muted",
                            zoom === "week" && "ml-1",
                          )}
                        >
                          {zoom === "day" ? format(d, "d") : format(d, "MMM d")}
                        </div>
                        {zoom === "day" && <div className="text-[9px] uppercase text-subtle -mt-0.5">{format(d, "EEEEE")}</div>}
                      </div>
                    );
                  })}
              </div>
            </div>

            {/* Body */}
            <div className="relative">
              {/* Weekend shading + today line, drawn once behind all rows. */}
              <div className="absolute inset-y-0 pointer-events-none" style={{ left: NAME_W, width: trackW }}>
                {zoom !== "month" &&
                  dayList.map((d, i) =>
                    d.getDay() === 0 || d.getDay() === 6 ? (
                      <div key={i} className="absolute inset-y-0 bg-inset/60" style={{ left: i * px, width: px }} />
                    ) : null,
                  )}
                <div className="absolute inset-y-0 w-0.5 bg-accent z-[1]" style={{ left: todayX + px / 2 - 1 }} />
              </div>

              {scheduled.map((c, row) => {
                const s = startOfDay(new Date(c.start_date ?? c.due_date!));
                const e = startOfDay(new Date(c.due_date ?? c.start_date!));
                const from = s <= e ? s : e;
                const to = s <= e ? e : s;
                const left = differenceInCalendarDays(from, rangeStart) * px;
                const width = Math.max(px, (differenceInCalendarDays(to, from) + 1) * px) - 4;
                const status = dueStatus(c.due_date, c.due_completed);
                const list = listById.get(c.list_id);
                const barColor =
                  status === "completed"
                    ? "rgb(var(--c-success))"
                    : status === "overdue"
                      ? "rgb(var(--c-danger))"
                      : list?.color ?? "rgb(var(--c-accent))";
                return (
                  <div key={c.id} data-card-id={c.id} className="flex group" style={{ "--i": row } as React.CSSProperties}>
                    <button
                      className="sticky left-0 z-10 shrink-0 px-3 py-1.5 text-left bg-surface group-hover:bg-inset border-r border-b border-line transition-colors"
                      style={{ width: NAME_W }}
                      onClick={() => onOpenCard(c.id)}
                    >
                      <div className={cn("text-xs sm:text-sm font-medium truncate", c.due_completed ? "text-subtle line-through" : "text-ink")}>
                        {c.title}
                      </div>
                      <div className="text-[10px] text-subtle truncate flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: list?.color ?? "rgb(var(--c-rule))" }} />
                        {list?.title}
                      </div>
                    </button>
                    <div className="relative shrink-0 h-12 border-b border-line group-hover:bg-inset transition-colors" style={{ width: trackW }}>
                      <button
                        onClick={() => onOpenCard(c.id)}
                        title={`${c.title}\n${format(from, "MMM d")}${+from !== +to ? ` → ${format(to, "MMM d")}` : ""}`}
                        className="grow-x absolute top-2.5 h-7 rounded-md text-left text-white shadow-card hover:shadow-raise hover:brightness-110 transition-[box-shadow,filter] duration-150 overflow-hidden"
                        style={{ left: left + 2, width, background: barColor }}
                      >
                        <span className="block px-2 text-xs font-medium leading-7 truncate">
                          {width > 60 ? c.title : ""}
                        </span>
                      </button>
                      {width <= 60 && (
                        <span
                          className="absolute top-2.5 leading-7 text-xs text-muted whitespace-nowrap pointer-events-none"
                          style={{ left: left + width + 8 }}
                        >
                          {c.title}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
