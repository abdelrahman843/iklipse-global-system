import { Flame, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { NotificationRow, UnreadCounts } from "@/lib/pm/notificationsApi";
import { SOURCES, needsYou, type Filter } from "@/components/notifications/smart";

export type FilterCount = { value: Filter; label: string; icon?: LucideIcon; unread: number };

/** The filters worth showing: All, Needs you, and each source you actually get notifications from. */
export function useFilterCounts(rows: NotificationRow[], unread: UnreadCounts | undefined): FilterCount[] {
  const present = new Set(rows.map((n) => n.source));
  return [
    { value: "all", label: "All", unread: unread?.all ?? 0 },
    { value: "needs", label: "Needs you", icon: Flame, unread: rows.filter(needsYou).length },
    ...SOURCES.filter((s) => present.has(s.value) || (unread?.[s.value] ?? 0) > 0).map((s) => ({
      value: s.value,
      label: s.label,
      icon: s.icon,
      unread: unread?.[s.value] ?? 0,
    })),
  ];
}

/** The chips wrap onto a second line, so every filter is always in reach. */
export function FilterChips({ value, onChange, counts }: { value: Filter; onChange: (f: Filter) => void; counts: FilterCount[] }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Show notifications from">
      {counts.map((c) => {
        const on = c.value === value;
        const hot = c.value === "needs" && c.unread > 0;
        return (
          <button
            key={c.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(c.value)}
            className={cn(
              "h-7 shrink-0 rounded-full px-2.5 text-sm font-medium inline-flex items-center gap-1.5 border transition-colors",
              on ? "bg-ink text-surface border-ink" : "border-border text-muted hover:text-ink hover:bg-inset",
            )}
          >
            {c.icon && <c.icon size={13} className={cn(!on && hot && "text-warn")} />}
            {c.label}
            {c.unread > 0 && (
              <span className={cn("tabular-nums text-xs", on ? "opacity-80" : hot ? "text-warn font-semibold" : "text-accent font-semibold")}>
                {c.unread > 99 ? "99+" : c.unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
