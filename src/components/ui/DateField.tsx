import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { inputClass } from "@/components/ui/Input";

// -----------------------------------------------------------------------------
// DateField: the app's one date picker, in the style of the Trello card's
// Dates popover (month grid, today underlined, the picked day filled). Drop-in
// for <input type="date"> and <input type="datetime-local">: the value is the
// same string those inputs use ("YYYY-MM-DD" / "YYYY-MM-DDTHH:mm", "" = none).
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

/** How a value reads on the field: "Thu, 15 Oct 2026" (and ", 12:49" with a time). */
function label(value: string, withTime: boolean): string {
  const [day, time] = value.split("T");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const d = fromYmd(day);
  const date = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return withTime && time ? `${date}, ${time.slice(0, 5)}` : date;
}

export function DateField({
  value,
  onChange,
  withTime,
  id,
  min,
  max,
  placeholder,
  disabled,
  clearable = true,
  align = "left",
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Pick a time too (datetime-local value). */
  withTime?: boolean;
  id?: string;
  /** Earliest / latest day, "YYYY-MM-DD". */
  min?: string;
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  align?: "left" | "right";
  className?: string;
  "aria-label"?: string;
}) {
  const shown = label(value, !!withTime);
  return (
    <Menu
      align={align}
      className={cn("w-full", className)}
      trigger={
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(inputClass, "flex items-center gap-2 text-left cursor-pointer disabled:cursor-not-allowed", !shown && "text-subtle")}
        >
          <CalendarDays size={15} className="shrink-0 text-muted" />
          <span className="flex-1 min-w-0 truncate">{shown || placeholder || (withTime ? "Pick a date and time" : "Pick a date")}</span>
        </button>
      }
    >
      {(close) => (
        <DatePanel
          value={value}
          withTime={!!withTime}
          min={min}
          max={max}
          clearable={clearable}
          onDone={(v) => {
            onChange(v);
            close();
          }}
          onPick={withTime ? undefined : (v) => (onChange(v), close())}
        />
      )}
    </Menu>
  );
}

/** The calendar on its own, for a menu that already exists (whiteboard due dates). */
export function DatePanel({
  value,
  withTime,
  min,
  max,
  clearable,
  onPick,
  onDone,
}: {
  value: string;
  withTime: boolean;
  min?: string;
  max?: string;
  clearable: boolean;
  /** Date only: a click on a day is the answer. */
  onPick?: (v: string) => void;
  onDone: (v: string) => void;
}) {
  const [day0, time0] = value.split("T");
  const has = !!day0 && /^\d{4}-\d{2}-\d{2}$/.test(day0);
  const [day, setDay] = useState(has ? day0! : "");
  const [time, setTime] = useState(time0?.slice(0, 5) || "12:00");
  const [text, setText] = useState(has ? mdy(day0!) : "");
  const [cursor, setCursor] = useState(() => {
    const base = has ? fromYmd(day0!) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

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
  const allowed = (d: string) => (!min || d >= min) && (!max || d <= max);
  const out = (d: string) => (withTime ? `${d}T${time}` : d);

  const pick = (d: string) => {
    if (!allowed(d)) return;
    if (onPick) return onPick(d);
    setDay(d);
    setText(mdy(d));
  };

  return (
    <div className="w-[304px] max-w-full px-3 pb-3" role="dialog" aria-label="Pick a date">
      <div className="flex items-center justify-between gap-1 py-2">
        <div className="flex shrink-0">
          <NavBtn label="Previous year" onClick={() => shift(-12)}>
            <ChevronsLeft size={16} />
          </NavBtn>
          <NavBtn label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </NavBtn>
        </div>
        <div className="min-w-0 text-center text-sm font-semibold text-ink">{cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div>
        <div className="flex shrink-0">
          <NavBtn label="Next month" onClick={() => shift(1)}>
            <ChevronRight size={16} />
          </NavBtn>
          <NavBtn label="Next year" onClick={() => shift(12)}>
            <ChevronsRight size={16} />
          </NavBtn>
        </div>
      </div>

      <div className="grid grid-cols-7 text-center">
        {WEEK.map((w) => (
          <div key={w} className="py-1 text-[11px] font-semibold text-subtle">
            {w}
          </div>
        ))}
        {days.map((d) => {
          const key = ymd(d);
          const outside = d.getMonth() !== cursor.getMonth();
          const on = key === day;
          const ok = allowed(key);
          return (
            <button
              key={key}
              type="button"
              disabled={!ok}
              aria-pressed={on}
              aria-label={d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
              onClick={() => pick(key)}
              className={cn(
                "relative h-9 sm:h-8 text-sm rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed",
                outside ? "text-subtle" : "text-ink",
                on ? "bg-accent text-white font-semibold" : ok && "hover:bg-hover",
                key === today && !on && "text-accent font-semibold",
              )}
            >
              {d.getDate()}
              {key === today && <span className={cn("absolute left-1/2 -translate-x-1/2 bottom-1 h-0.5 w-4 rounded-full", on ? "bg-white" : "bg-accent")} />}
            </button>
          );
        })}
      </div>

      {withTime ? (
        <>
          <div className="mt-3 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle mb-1">Date and time</div>
          <div className="flex items-center gap-2">
            <input
              value={text}
              placeholder="M/D/YYYY"
              aria-label="Date"
              onChange={(e) => setText(e.target.value)}
              onBlur={() => {
                const p = parseTyped(text);
                if (p && allowed(p)) {
                  setDay(p);
                  const d = fromYmd(p);
                  setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
                }
                setText(mdy(p && allowed(p) ? p : day));
              }}
              className="w-28 h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring transition-[border-color,box-shadow] duration-150"
            />
            <input
              type="time"
              value={time}
              aria-label="Time"
              onChange={(e) => setTime(e.target.value || "12:00")}
              className="flex-1 min-w-0 h-9 rounded-md border border-border bg-surface px-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring transition-[border-color,box-shadow] duration-150"
            />
          </div>
          <Button type="button" variant="primary" size="sm" disabled={!day} onClick={() => onDone(out(day))} className="mt-4 w-full">
            Save
          </Button>
          {clearable && (
            <Button type="button" variant="secondary" size="sm" onClick={() => onDone("")} className="mt-2 w-full">
              Remove
            </Button>
          )}
        </>
      ) : (
        <div className="mt-2 pt-2 border-t border-line flex items-center justify-between">
          {clearable ? (
            <button type="button" onClick={() => onDone("")} className="h-8 px-2 -ml-2 rounded-md text-sm text-muted hover:text-ink hover:bg-hover inline-flex items-center gap-1.5">
              <X size={14} /> Clear
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            disabled={!allowed(today)}
            onClick={() => onDone(today)}
            className="h-8 px-2 -mr-2 rounded-md text-sm font-medium text-accent hover:bg-hover disabled:opacity-40"
          >
            Today
          </button>
        </div>
      )}
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
      className="grid place-items-center w-9 h-9 sm:w-7 sm:h-7 rounded-md text-muted hover:bg-hover hover:text-ink transition-colors"
    >
      {children}
    </button>
  );
}
