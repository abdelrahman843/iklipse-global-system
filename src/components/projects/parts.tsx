import { AlertTriangle, CheckCircle2, Clock, Flag } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/cn";
import {
  dueIn,
  dueText,
  dueTone,
  priorityLabel,
  statusLabel,
  type ProjectMember,
  type ProjectPriority,
  type ProjectStatus,
} from "@/lib/projectsApi";

const PRIORITY_TONE = { urgent: "danger", high: "warn", medium: "accent", low: "neutral" } as const;
const STATUS_TONE = { active: "accent", on_hold: "warn", delivered: "success", cancelled: "neutral" } as const;

export function PriorityBadge({ priority }: { priority: ProjectPriority }) {
  return (
    <Badge tone={PRIORITY_TONE[priority]}>
      <Flag size={11} /> {priorityLabel(priority)}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{statusLabel(status)}</Badge>;
}

/** A due date with how far it is: red when late, amber within two days. */
export function DueLabel({ due, done, className, short }: { due: string | null; done?: boolean; className?: string; short?: boolean }) {
  const tone = dueTone(due, !!done);
  if (!due || !tone) return <span className={cn("text-xs text-subtle", className)}>No date</span>;
  const Icon = tone === "done" ? CheckCircle2 : tone === "late" ? AlertTriangle : Clock;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs tabular-nums",
        tone === "late" ? "text-danger font-medium" : tone === "soon" ? "text-warn font-medium" : tone === "done" ? "text-success" : "text-muted",
        className,
      )}
      title={dueText(due)}
    >
      <Icon size={12} className="shrink-0" />
      <span className="truncate">
        {short ? dueText(due) : `${dueText(due)}${tone === "done" ? "" : ` · ${dueIn(due)}`}`}
      </span>
    </span>
  );
}

/** Overlapping faces of the team (up to `max`, then +N). */
export function TeamFaces({ members, max = 4, size = 24 }: { members: ProjectMember[]; max?: number; size?: number }) {
  if (!members.length) return <span className="text-xs text-subtle">No team yet</span>;
  const shown = members.slice(0, max);
  const more = members.length - shown.length;
  return (
    <span className="inline-flex items-center -space-x-1.5" title={members.map((m) => m.name).join(", ")}>
      {shown.map((m) => (
        <Avatar key={m.user_id} src={m.avatar_url} name={m.name} size={size} className="ring-2 ring-surface" />
      ))}
      {more > 0 && (
        <span
          className="grid place-items-center rounded-full bg-inset text-[10px] font-medium text-muted ring-2 ring-surface"
          style={{ width: size, height: size }}
        >
          +{more}
        </span>
      )}
    </span>
  );
}

/** Done of total, as a thin bar. */
export function Progress({ done, total }: { done: number; total: number }) {
  if (!total) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted tabular-nums">
      <span className="h-1.5 w-16 rounded-full bg-inset overflow-hidden" aria-hidden>
        <span className={cn("block h-full rounded-full", pct === 100 ? "bg-success" : "bg-accent")} style={{ width: `${pct}%` }} />
      </span>
      {done}/{total}
    </span>
  );
}
