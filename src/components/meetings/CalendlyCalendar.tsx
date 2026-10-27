import { useEffect, useMemo, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { addDays, cairoToday, dayText } from "@/lib/attendanceApi";
import type { CalendlyMeeting } from "@/lib/calendlyApi";

// -----------------------------------------------------------------------------
// The Calendly page as a calendar, like Google Calendar: a day, a week
// (Saturday to Friday) or a month. Every time is Cairo time, whatever the
// computer's own clock says: a meeting sits at its Cairo hour on its Cairo
// day, a long one runs to its end, meetings at the same time sit side by side,
// and a red line marks now. The day and week also show, in green, the times
// Calendly is open to book (its working hours, less what's busy on the
// calendars it's connected to: what the bot offers too). Clicking a meeting
// opens it; clicking an empty half hour books one then.
// -----------------------------------------------------------------------------

export type CalView = "day" | "week" | "month";

const TZ = "Africa/Cairo";
/** One hour's height in the day and week views. */
const HOUR = 48;
const DAY_MIN = 24 * 60;
const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const WEEKDAYS = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The Cairo day a moment falls on. */
const dayAt = (ms: number) => cairoToday(new Date(ms));
/** Minutes since Cairo midnight. */
const minuteAt = (ms: number) => {
  const [h, m] = hm.format(new Date(ms)).split(":").map(Number);
  return (h! % 24) * 60 + m!;
};
/** "3:00 PM" in Cairo. */
export const clockText = (ms: number) => clock.format(new Date(ms)).replace(/[  ]/g, " ");
/** 0 Sunday ... 6 Saturday, for a "2026-10-20" day. */
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const parts = (day: string) => day.split("-").map(Number) as [number, number, number];

/** The Saturday on or before a day (the week starts on Saturday). */
export const weekStart = (day: string) => addDays(day, -((weekdayOf(day) + 1) % 7));

/** The days a view shows around a day. */
export function daysOf(view: CalView, anchor: string): string[] {
  if (view === "day") return [anchor];
  if (view === "week") {
    const s = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }
  const s = weekStart(`${anchor.slice(0, 8)}01`);
  return Array.from({ length: 42 }, (_, i) => addDays(s, i));
}

/** The next or previous day, week or month. */
export function shiftDay(view: CalView, anchor: string, n: number) {
  if (view === "day") return addDays(anchor, n);
  if (view === "week") return addDays(anchor, 7 * n);
  const [y, m] = parts(anchor);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

/** "Tuesday 20 October", "18 to 24 October 2026", "October 2026". */
export function titleOf(view: CalView, anchor: string) {
  const [y, m] = parts(anchor);
  if (view === "day") return dayText(anchor);
  if (view === "month") return `${MONTHS[m - 1]} ${y}`;
  const days = daysOf("week", anchor);
  const [y1, m1, d1] = parts(days[0]!);
  const [y2, m2, d2] = parts(days[6]!);
  if (m1 === m2) return `${d1} to ${d2} ${MONTHS[m2 - 1]} ${y2}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} to ${d2} ${MONTHS[m2 - 1]} ${y2}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} to ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

/** The meetings on a Cairo day (a meeting past midnight shows on both days). */
function onDay(ms: CalendlyMeeting[], day: string) {
  return ms.filter((m) => dayAt(Date.parse(m.start)) <= day && dayAt(Date.parse(m.end) - 1) >= day);
}

interface Placed {
  m: CalendlyMeeting;
  /** Minutes from Cairo midnight, cut to this day. */
  from: number;
  to: number;
  col: number;
  cols: number;
}

/** Where each meeting sits in a day's column: meetings that overlap share its width. */
function placed(ms: CalendlyMeeting[], day: string): Placed[] {
  const items = ms
    .map((m) => {
      const s = Date.parse(m.start);
      const e = Date.parse(m.end);
      const from = dayAt(s) < day ? 0 : minuteAt(s);
      const to = dayAt(e - 1) > day ? DAY_MIN : minuteAt(e) || DAY_MIN;
      return { m, from, to: Math.max(to, from + 15) };
    })
    .sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Placed[] = [];
  let group: (typeof items[number] & { col: number })[] = [];
  let ends: number[] = [];
  let groupEnd = -1;
  const close = () => {
    for (const g of group) out.push({ ...g, cols: ends.length });
    group = [];
    ends = [];
    groupEnd = -1;
  };
  for (const it of items) {
    if (group.length && it.from >= groupEnd) close();
    let col = ends.findIndex((end) => end <= it.from);
    if (col < 0) {
      col = ends.length;
      ends.push(it.to);
    } else ends[col] = it.to;
    group.push({ ...it, col });
    groupEnd = Math.max(groupEnd, it.to);
  }
  close();
  return out;
}

/** Now, a minute at a time. */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const hourLabel = (h: number) => (h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`);
const pad = (n: number) => String(n).padStart(2, "0");

export function CalendlyCalendar({
  view,
  anchor,
  meetings,
  free = [],
  freeMinutes = 30,
  onOpen,
  onBook,
  onPickDay,
}: {
  view: CalView;
  anchor: string;
  meetings: CalendlyMeeting[];
  /** The open start times (ISO) Calendly has in the days shown. */
  free?: string[];
  /** How long a meeting from those times lasts. */
  freeMinutes?: number;
  onOpen: (m: CalendlyMeeting) => void;
  /** An empty half hour clicked: that day and time (HH:MM, Cairo). */
  onBook: (day: string, time: string) => void;
  /** A day picked in the month view. */
  onPickDay: (day: string) => void;
}) {
  const days = useMemo(() => daysOf(view, anchor), [view, anchor]);
  if (view === "month") return <MonthGrid anchor={anchor} days={days} meetings={meetings} onOpen={onOpen} onPickDay={onPickDay} />;
  return <TimeGrid days={days} meetings={meetings} free={free} freeMinutes={freeMinutes} onOpen={onOpen} onBook={onBook} onPickDay={onPickDay} />;
}

/** A day's open times as stretches (minutes from Cairo midnight): a time and the next ones that run on from it. */
function openStretches(free: number[], day: string, minutes: number) {
  const out: { from: number; to: number }[] = [];
  for (const t of free.filter((x) => dayAt(x) === day).sort((a, b) => a - b)) {
    const from = minuteAt(t);
    const to = Math.min(DAY_MIN, from + minutes);
    const last = out[out.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else out.push({ from, to });
  }
  return out;
}

function TimeGrid({
  days,
  meetings,
  free,
  freeMinutes,
  onOpen,
  onBook,
  onPickDay,
}: {
  days: string[];
  meetings: CalendlyMeeting[];
  free: string[];
  freeMinutes: number;
  onOpen: (m: CalendlyMeeting) => void;
  onBook: (day: string, time: string) => void;
  onPickDay: (day: string) => void;
}) {
  const now = useNow();
  const today = dayAt(now);
  const scroller = useRef<HTMLDivElement>(null);
  const cols = `3.5rem repeat(${days.length}, minmax(0, 1fr))`;
  const byDay = useMemo(() => days.map((d) => placed(onDay(meetings, d), d)), [days, meetings]);
  const openByDay = useMemo(() => {
    const starts = free.map((x) => Date.parse(x)).filter((x) => !Number.isNaN(x));
    return days.map((d) => openStretches(starts, d, freeMinutes));
  }, [days, free, freeMinutes]);

  // Opens on the working day: from 8 AM, or the first meeting from 6 AM when it's earlier.
  useEffect(() => {
    const first = Math.min(8 * 60, ...byDay.flat().map((p) => p.from).filter((m) => m >= 6 * 60));
    scroller.current?.scrollTo({ top: Math.max(0, (first / 60) * HOUR - HOUR / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days[0]]);

  // Fills the space it's given; the hours scroll inside it, never the page.
  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border bg-surface overflow-hidden">
      <div className="shrink-0 grid border-b border-border" style={{ gridTemplateColumns: cols }}>
        <div className="text-[10px] text-subtle self-end px-1 pb-1">Cairo</div>
        {days.map((d) => {
          const isToday = d === today;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onPickDay(d)}
              className="py-2 flex flex-col items-center gap-0.5 border-l border-border hover:bg-hover transition-colors"
            >
              <span className={cn("text-xs uppercase tracking-wide", isToday ? "text-accent font-semibold" : "text-subtle")}>{WEEKDAYS[(weekdayOf(d) + 1) % 7]}</span>
              <span
                className={cn(
                  "h-8 min-w-8 px-1 grid place-items-center rounded-full text-lg font-semibold tabular-nums",
                  isToday ? "bg-accent text-white" : "text-ink",
                )}
              >
                {parts(d)[2]}
              </span>
            </button>
          );
        })}
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="grid relative" style={{ gridTemplateColumns: cols, height: 24 * HOUR }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <div key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-subtle tabular-nums whitespace-nowrap" style={{ top: h * HOUR }}>
                {hourLabel(h)}
              </div>
            ))}
          </div>
          {days.map((d, i) => (
            <div
              key={d}
              className={cn("relative border-l border-border cursor-pointer", d < today && "bg-inset/40")}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const half = Math.max(0, Math.min(47, Math.floor(((e.clientY - r.top) / HOUR) * 2)));
                onBook(d, `${pad(Math.floor(half / 2))}:${half % 2 ? "30" : "00"}`);
              }}
              title="Book a meeting here"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="absolute inset-x-0 border-t border-border/60" style={{ top: h * HOUR }} />
              ))}
              {openByDay[i]!.map((o) => (
                <div
                  key={o.from}
                  className="absolute inset-x-0 pointer-events-none bg-success/10 border-l-2 border-success/60"
                  style={{ top: (o.from / 60) * HOUR, height: ((o.to - o.from) / 60) * HOUR }}
                >
                  {(o.to - o.from) / 60 >= 0.5 && <span className="absolute right-1 top-0.5 text-[10px] font-semibold text-success/90">Open</span>}
                </div>
              ))}
              {byDay[i]!.map((p) => (
                <Block key={`${p.m.id}:${d}`} p={p} past={Date.parse(p.m.end) < now} onOpen={onOpen} />
              ))}
              {d === today && (
                <div className="absolute inset-x-0 z-10 pointer-events-none" style={{ top: (minuteAt(now) / 60) * HOUR }}>
                  <div className="relative h-0.5 bg-danger">
                    <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-danger" />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Block({ p, past, onOpen }: { p: Placed; past: boolean; onOpen: (m: CalendlyMeeting) => void }) {
  const height = ((p.to - p.from) / 60) * HOUR;
  const short = height < 34;
  const wa = !!p.m.whatsapp;
  const time = `${clockText(Date.parse(p.m.start))} to ${clockText(Date.parse(p.m.end))}`;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(p.m);
      }}
      title={`${p.m.name}\n${time}${p.m.with ? `\nWith ${p.m.with}` : ""}`}
      className={cn(
        "absolute z-[5] rounded-md border-l-[3px] px-1.5 text-left text-xs leading-tight overflow-hidden transition-colors",
        wa ? "bg-success/15 border-success hover:bg-success/25" : "bg-accent/15 border-accent hover:bg-accent/25",
        short ? "py-0 flex items-center gap-1" : "py-1",
        past && "opacity-60",
      )}
      style={{
        top: (p.from / 60) * HOUR + 1,
        height: Math.max(height - 2, 16),
        left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
        width: `calc(${100 / p.cols}% - 4px)`,
      }}
    >
      {short ? (
        <span className="truncate text-ink">
          <span className="font-semibold">{p.m.name}</span> <span className="text-muted">{clockText(Date.parse(p.m.start))}</span>
        </span>
      ) : (
        <>
          <div className="font-semibold text-ink truncate flex items-center gap-1">
            {wa && <MessageCircle size={10} className="shrink-0 text-success" />}
            <span className="truncate">{p.m.name}</span>
          </div>
          <div className="text-muted truncate tabular-nums">{time}</div>
          {p.m.with && height >= 60 && <div className="text-muted truncate">With {p.m.with}</div>}
        </>
      )}
    </button>
  );
}

function MonthGrid({
  anchor,
  days,
  meetings,
  onOpen,
  onPickDay,
}: {
  anchor: string;
  days: string[];
  meetings: CalendlyMeeting[];
  onOpen: (m: CalendlyMeeting) => void;
  onPickDay: (day: string) => void;
}) {
  const now = useNow();
  const today = dayAt(now);
  const month = anchor.slice(0, 7);
  // The weeks share the height it's given; when they can't fit, they scroll inside it.
  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border bg-surface overflow-hidden">
      <div className="shrink-0 grid grid-cols-7 border-b border-border">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-2 text-center text-xs uppercase tracking-wide text-subtle">
            {w}
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="grid grid-cols-7 h-full auto-rows-[minmax(6.5rem,1fr)]">
          {days.map((d, i) => {
            // A month shows each meeting on the day it starts.
            const list = meetings.filter((m) => dayAt(Date.parse(m.start)) === d).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
            const out = d.slice(0, 7) !== month;
            return (
              <div key={d} className={cn("p-1 border-border", i % 7 && "border-l", i >= 7 && "border-t", out && "bg-inset/40")}>
                <button
                  type="button"
                  onClick={() => onPickDay(d)}
                  className={cn(
                    "mx-auto mb-1 h-7 min-w-7 px-1 grid place-items-center rounded-full text-sm tabular-nums transition-colors",
                    d === today ? "bg-accent text-white font-semibold" : out ? "text-subtle hover:bg-hover" : "text-ink hover:bg-hover",
                  )}
                  aria-label={dayText(d)}
                >
                  {parts(d)[2]}
                </button>
                <div className="space-y-0.5">
                  {list.slice(0, 3).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onOpen(m)}
                      title={`${m.name}\n${clockText(Date.parse(m.start))} to ${clockText(Date.parse(m.end))}`}
                      className={cn(
                        "w-full flex items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-hover",
                        Date.parse(m.end) < now && "opacity-60",
                      )}
                    >
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", m.whatsapp ? "bg-success" : "bg-accent")} />
                      <span className="text-muted tabular-nums shrink-0">{clockText(Date.parse(m.start))}</span>
                      <span className="truncate text-ink">{m.name}</span>
                    </button>
                  ))}
                  {list.length > 3 && (
                    <button type="button" onClick={() => onPickDay(d)} className="w-full px-1 text-left text-xs font-semibold text-muted hover:text-ink">
                      {list.length - 3} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
