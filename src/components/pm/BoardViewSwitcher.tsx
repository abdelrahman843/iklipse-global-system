import { Kanban, Calendar, Table2, BarChart3, GanttChart } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PermissionKey } from "@/lib/database.types";

export type BoardView = "board" | "calendar" | "table" | "timeline" | "dashboard";

interface Props {
  value: BoardView;
  onChange: (v: BoardView) => void;
  can: (perm: PermissionKey) => boolean;
}

const VIEWS: { key: BoardView; label: string; icon: React.ReactNode; perm?: PermissionKey }[] = [
  { key: "board", label: "Board", icon: <Kanban size={14} /> },
  { key: "calendar", label: "Calendar", icon: <Calendar size={14} />, perm: "pm.calendar_view" },
  { key: "table", label: "Table", icon: <Table2 size={14} />, perm: "pm.table_view" },
  { key: "timeline", label: "Timeline", icon: <GanttChart size={14} />, perm: "pm.timeline_view" },
  { key: "dashboard", label: "Dashboard", icon: <BarChart3 size={14} />, perm: "pm.dashboard_view" },
];

export function BoardViewSwitcher({ value, onChange, can }: Props) {
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-white p-0.5">
      {VIEWS.filter((v) => !v.perm || can(v.perm)).map((v) => (
        <button
          key={v.key}
          onClick={() => onChange(v.key)}
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 text-sm rounded",
            value === v.key ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface",
          )}
          aria-pressed={value === v.key}
          title={v.label}
        >
          {v.icon}
          <span className="hidden md:inline">{v.label}</span>
        </button>
      ))}
    </div>
  );
}
