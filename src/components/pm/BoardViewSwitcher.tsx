import { Kanban, Calendar, Table2, BarChart3, GanttChart, Archive } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PermissionKey } from "@/lib/database.types";

export type BoardView = "board" | "calendar" | "table" | "timeline" | "dashboard" | "archive";

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
  { key: "archive", label: "Archive", icon: <Archive size={14} />, perm: "pm.archive_card" },
];

export function BoardViewSwitcher({ value, onChange, can }: Props) {
  return (
    <div className="inline-flex items-center rounded-md border border-rule bg-inset p-0.5 shadow-inner">
      {VIEWS.filter((v) => !v.perm || can(v.perm)).map((v) => (
        <button
          key={v.key}
          onClick={() => onChange(v.key)}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded transition-colors duration-150 font-medium",
            value === v.key
              ? "bg-surface text-ink shadow-card border border-line"
              : "text-muted hover:text-ink hover:bg-surface/60",
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
