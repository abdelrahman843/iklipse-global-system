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

      <div className="grid grid-cols-7 text-xs text-subtle mb-1">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="px-2 py-1 font-medium">{d}</div>
        ))}
      </div>

      <div className="flex-1 grid grid-cols-7 auto-rows-fr gap-px bg-border rounded overflow-hidden">
        {grid.map((d) => {
          const key = format(d, "yyyy-MM-dd");
          const dayCards = byDay.get(key) ?? [];
          const inMonth = isSameMonth(d, cursor);
          const today = isSameDay(d, new Date());
          return (
            <div
              key={key}
              className={cn(
                "bg-white p-1.5 min-h-[92px] text-xs flex flex-col gap-1 overflow-hidden",
                !inMonth && "bg-surface/50 text-subtle",
              )}
            >
              <div className={cn("text-[11px]", today && "font-bold text-accent")}>{format(d, "d")}</div>
              {dayCards.slice(0, 4).map((c) => (
                <button
                  key={c.id}
                  className="text-left truncate rounded px-1.5 py-0.5 bg-accent-soft text-accent hover:bg-accent/20"
                  onClick={() => onOpenCard(c.id)}
                >
                  {c.title}
                </button>
              ))}
              {dayCards.length > 4 && (
                <div className="text-[10px] text-subtle">+{dayCards.length - 4} more</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
