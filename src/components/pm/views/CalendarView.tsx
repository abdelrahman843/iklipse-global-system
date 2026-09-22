import { useMemo, useState } from "react";
import { addDays, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths, addMonths } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Card, List } from "@/lib/database.types";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

interface Props {
  cards: Card[];
  lists: List[];
  onOpenCard: (id: string) => void;
}

export function CalendarView({ cards, onOpenCard }: Props) {
  const [cursor, setCursor] = useState(new Date());

  const grid = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor));
    const end = endOfWeek(endOfMonth(cursor));
    const days: Date[] = [];
    let d = start;
    while (d <= end) {
      days.push(d);
      d = addDays(d, 1);
    }
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
    return m;
  }, [cards]);

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3">
        <Button size="sm" variant="ghost" onClick={() => setCursor((d) => subMonths(d, 1))} aria-label="Previous month">
          <ChevronLeft size={14} />
        </Button>
        <div className="text-sm font-semibold text-ink w-40 text-center">{format(cursor, "MMMM yyyy")}</div>
        <Button size="sm" variant="ghost" onClick={() => setCursor((d) => addMonths(d, 1))} aria-label="Next month">
          <ChevronRight size={14} />
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setCursor(new Date())}>
          Today
        </Button>
      </div>

      <div className="grid grid-cols-7 text-[10px] text-subtle mb-1 uppercase tracking-[0.3px]">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-2 py-1.5 font-semibold">{d}</div>
        ))}
      </div>

      <div className="flex-1 grid grid-cols-7 auto-rows-fr gap-px bg-border rounded-lg overflow-hidden border border-border shadow-card">
        {grid.map((d) => {
          const key = format(d, "yyyy-MM-dd");
          const dayCards = byDay.get(key) ?? [];
          const inMonth = isSameMonth(d, cursor);
          const today = isSameDay(d, new Date());
          return (
            <div
              key={key}
              className={cn(
                "p-1.5 min-h-[92px] text-xs flex flex-col gap-1 overflow-hidden transition-colors",
                inMonth ? "bg-surface" : "bg-inset text-subtle",
                today && "ring-2 ring-inset ring-accent",
              )}
            >
              <div
                className={cn(
                  "text-[11px] font-medium",
                  today ? "text-accent font-bold" : inMonth ? "text-muted" : "text-subtle",
                )}
              >
                {format(d, "d")}
              </div>
              {dayCards.slice(0, 4).map((c) => (
                <button
                  key={c.id}
                  className="text-left truncate rounded px-1.5 py-0.5 bg-accent-soft text-accent-hover hover:bg-accent hover:text-white transition-colors font-medium"
                  onClick={() => onOpenCard(c.id)}
                >
                  {c.title}
                </button>
              ))}
              {dayCards.length > 4 && (
                <div className="text-[10px] text-subtle font-medium">+{dayCards.length - 4} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
