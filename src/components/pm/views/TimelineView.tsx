import { useMemo } from "react";
import { addDays, differenceInCalendarDays, format, max, min, startOfDay } from "date-fns";
import type { Card } from "@/lib/database.types";

const DAY_PX = 36;

export function TimelineView({
  cards,
  onOpenCard,
}: {
  cards: Card[];
  onOpenCard: (id: string) => void;
}) {
  const scheduled = useMemo(
    () => cards.filter((c) => c.start_date || c.due_date),
    [cards],
  );

  const { rangeStart, days } = useMemo(() => {
    if (scheduled.length === 0) {
      const today = startOfDay(new Date());
      return { rangeStart: today, days: 15 };
    }
    const startCandidates = scheduled.map(
      (c) => new Date(c.start_date ?? c.due_date ?? new Date()),
    );
    const endCandidates = scheduled.map(
      (c) => new Date(c.due_date ?? c.start_date ?? new Date()),
    );
    const s = startOfDay(addDays(min(startCandidates), -2));
    const e = startOfDay(addDays(max(endCandidates), 3));
    return { rangeStart: s, days: differenceInCalendarDays(e, s) + 1 };
  }, [scheduled]);

  if (scheduled.length === 0) {
    return <div className="p-6 text-sm text-subtle">No cards have start or due dates yet.</div>;
  }

  return (
    <div className="p-4 overflow-auto h-full">
      <div style={{ width: days * DAY_PX + 260, minWidth: "100%" }}>
        <div className="flex sticky top-0 bg-surface/60 backdrop-blur z-10 border-b border-border">
          <div className="w-64 shrink-0 px-3 py-2 text-xs uppercase text-subtle font-semibold">
            Card
          </div>
          <div className="relative flex-1 h-8">
            {Array.from({ length: days }, (_, i) => {
              const d = addDays(rangeStart, i);
              return (
                <div
                  key={i}
                  className="absolute top-0 h-full border-l border-line text-[10px] text-subtle px-1"
                  style={{ left: i * DAY_PX, width: DAY_PX }}
                >
                  {format(d, "d MMM")}
                </div>
              );
            })}
          </div>
        </div>

        {scheduled.map((c) => {
          const s = c.start_date ? new Date(c.start_date) : new Date(c.due_date!);
          const e = c.due_date ? new Date(c.due_date) : s;
          const left = Math.max(0, differenceInCalendarDays(s, rangeStart)) * DAY_PX;
          const width = Math.max(1, differenceInCalendarDays(e, s) + 1) * DAY_PX - 4;
          return (
            <div key={c.id} className="flex items-center border-b border-line">
              <button
                className="w-64 shrink-0 px-3 py-2 text-left text-sm text-ink truncate hover:bg-surface"
                onClick={() => onOpenCard(c.id)}
              >
                {c.title}
              </button>
              <div className="relative flex-1 h-9">
                <div
                  className="absolute top-1.5 h-6 rounded bg-accent-soft border border-accent/30 hover:bg-accent/20 cursor-pointer"
                  style={{ left, width }}
                  onClick={() => onOpenCard(c.id)}
                  title={c.title}
                >
                  <div className="text-xs text-accent px-2 leading-6 truncate">{c.title}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
