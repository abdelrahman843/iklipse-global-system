import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// DatesPanel — Trello's "Dates" popover: a month calendar, an optional start
// date, a due date + time, and Save / Remove. Clicking a day fills whichever
// field was focused last (due by default). Start is a calendar date (DB `date`),
// due is a timestamp.
// -----------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};
const mdy = (s: string) => {
  if (!s) return "";
  const d = fromYmd(s);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
};
// Accepts M/D/YYYY (what the field shows) or YYYY-MM-DD.
function parseTyped(v: string): string | null {
  const t = v.trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    return isNaN(d.getTime()) ? null : ymd(d);
  }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ymd(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
}

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function DatesPanel({
  startDate,
  dueDate,
  onSave,
  onRemove,
  saving,
}: {
  startDate: string | null;
  dueDate: string | null;
  onSave: (v: { start_date: string | null; due_date: string | null }) => void;
  onRemove: () => void;
  saving?: boolean;
}) {
  const initialDue = dueDate ? new Date(dueDate) : (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  })();

  const [startOn, setStartOn] = useState(!!startDate);
  const [start, setStart] = useState(startDate ? startDate.slice(0, 10) : ymd(new Date()));
  const [dueOn, setDueOn] = useState(dueDate ? true : !startDate);
  const [due, setDue] = useState(ymd(initialDue));
  const [time, setTime] = useState(`${pad(initialDue.getHours())}:${pad(initialDue.getMinutes())}`);
  const [focus, setFocus] = useState<"start" | "due">(startDate && !dueDate ? "start" : "due");
  const [cursor, setCursor] = useState(() => {
    const base = dueDate ? initialDue : startDate ? fromYmd(startDate.slice(0, 10)) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [startText, setStartText] = useState(mdy(start));
  const [dueText, setDueText] = useState(mdy(due));

  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const from = new Date(first);
    from.setDate(1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      return d;
    });
  }, [cursor]);

  const today = ymd(new Date());
  const shift = (months: number) => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + months, 1));

  const pick = (d: string) => {
    if (focus === "start") {
      setStartOn(true);
      setStart(d);
      setStartText(mdy(d));
    } else {
      setDueOn(true);
      setDue(d);
      setDueText(mdy(d));
    }
  };

  const save = () => {
    const [hh, mm] = time.split(":").map(Number);
    const dueDt = fromYmd(due);
    dueDt.setHours(hh ?? 12, mm ?? 0, 0, 0);
    onSave({
      start_date: startOn ? start : null,
      due_date: dueOn ? dueDt.toISOString() : null,
    });
  };

  const inRange = (d: string) => startOn && dueOn && d > start && d < due;

  return (
    <div className="w-[304px] max-w-full px-3 pb-3">
      {/* Month header */}
      <div className="flex items-center justify-between py-2">
        <div className="flex">
          <NavBtn label="Previous year" onClick={() => shift(-12)}>
            <ChevronsLeft size={16} />
          </NavBtn>
          <NavBtn label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </NavBtn>
        </div>
        <div className="text-sm font-semibold text-ink">
          {cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </div>
        <div className="flex">
          <NavBtn label="Next month" onClick={() => shift(1)}>
            <ChevronRight size={16} />
          </NavBtn>
          <NavBtn label="Next year" onClick={() => shift(12)}>
            <ChevronsRight size={16} />
          </NavBtn>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 text-center">
        {WEEK.map((w) => (
          <div key={w} className="py-1 text-[11px] font-semibold text-subtle">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const outside = d.getMonth() !== cursor.getMonth();
          const isDue = dueOn && key === due;
          const isStart = startOn && key === start;
          return (
            <button
              key={key}
              type="button"
              onClick={() => pick(key)}
              className={cn(
                "relative h-8 text-sm rounded-md transition-colors",
                outside ? "text-subtle/60" : "text-ink",
                isDue || isStart
                  ? "bg-accent text-white font-semibold"
                  : inRange(key)
                    ? "bg-accent-soft"
                    : "hover:bg-inset",
                key === today && !isDue && !isStart && "text-accent font-semibold",
              )}
            >
              {d.getDate()}
              {key === today && (
                <span className={cn("absolute left-1/2 -translate-x-1/2 bottom-1 h-0.5 w-4 rounded-full", isDue || isStart ? "bg-white" : "bg-accent")} />
              )}
            </button>
          );
        })}
      </div>

      {/* Start date */}
      <div className="mt-3">
        <div className="text-xs font-semibold text-subtle mb-1">Start date</div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-accent w-4 h-4"
            checked={startOn}
            onChange={(e) => {
              setStartOn(e.target.checked);
              if (e.target.checked) setFocus("start");
            }}
          />
          <input
            value={startOn ? startText : ""}
            placeholder="M/D/YYYY"
            disabled={!startOn}
            onFocus={() => setFocus("start")}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={() => {
              const p = parseTyped(startText);
              if (p) setStart(p);
              setStartText(mdy(p ?? start));
            }}
            className={cn(
              "w-28 h-9 rounded-md border bg-inset px-2 text-sm text-ink outline-none disabled:opacity-50",
              focus === "start" && startOn ? "border-accent" : "border-rule",
            )}
          />
        </div>
      </div>

      {/* Due date */}
      <div className="mt-3">
        <div className="text-xs font-semibold text-subtle mb-1">Due date</div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="accent-accent w-4 h-4"
            checked={dueOn}
            onChange={(e) => {
              setDueOn(e.target.checked);
              if (e.target.checked) setFocus("due");
            }}
          />
          <input
            value={dueOn ? dueText : ""}
            placeholder="M/D/YYYY"
            disabled={!dueOn}
            onFocus={() => setFocus("due")}
            onChange={(e) => setDueText(e.target.value)}
            onBlur={() => {
              const p = parseTyped(dueText);
              if (p) setDue(p);
              setDueText(mdy(p ?? due));
            }}
            className={cn(
              "w-28 h-9 rounded-md border bg-inset px-2 text-sm text-ink outline-none disabled:opacity-50",
              focus === "due" && dueOn ? "border-accent" : "border-rule",
            )}
          />
          <input
            type="time"
            value={time}
            disabled={!dueOn}
            onFocus={() => setFocus("due")}
            onChange={(e) => setTime(e.target.value || "12:00")}
            className="flex-1 min-w-0 h-9 rounded-md border border-rule bg-inset px-2 text-sm text-ink outline-none focus:border-accent disabled:opacity-50"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="mt-4 w-full h-9 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-60"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="mt-2 w-full h-9 rounded-md border border-rule text-sm text-muted hover:bg-inset hover:text-ink transition-colors"
      >
        Remove
      </button>
    </div>
  );
}

function NavBtn({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid place-items-center w-7 h-7 rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
    >
      {children}
    </button>
  );
}
