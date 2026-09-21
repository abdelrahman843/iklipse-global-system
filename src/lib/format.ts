import { formatDistanceToNowStrict, format, isPast, isToday } from "date-fns";

export function relativeTime(iso: string | Date) {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
}

export function shortDate(iso: string | Date) {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() ? format(d, "MMM d") : format(d, "MMM d, yyyy");
}

export function dueStatus(due: string | null, completed: boolean) {
  if (!due) return null;
  if (completed) return "completed" as const;
  const d = new Date(due);
  if (isPast(d) && !isToday(d)) return "overdue" as const;
  const in3 = new Date();
  in3.setDate(in3.getDate() + 3);
  if (d <= in3) return "soon" as const;
  return "later" as const;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}
