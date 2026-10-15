import { AudioLines, BellRing, FolderKanban, Kanban, NotebookPen, PackageCheck, Receipt, Share2, Shapes, type LucideIcon } from "lucide-react";
import type { NotificationRow, NotificationSource } from "@/lib/pm/notificationsApi";

// -----------------------------------------------------------------------------
// What makes the notifications "smart": where each one comes from, how much it
// needs you, which ones are about the same thing (bundled into one row), and
// alerts that no longer apply (resolved by the server, 0061).
// -----------------------------------------------------------------------------

export const SOURCES: { value: NotificationSource; label: string; icon: LucideIcon }[] = [
  { value: "alerts", label: "Alerts", icon: BellRing },
  { value: "projects", label: "Projects", icon: FolderKanban },
  { value: "deliveries", label: "Deliveries", icon: PackageCheck },
  { value: "boards", label: "Trello", icon: Kanban },
  { value: "whiteboards", label: "Miro", icon: Shapes },
  { value: "meetings", label: "Meetings", icon: AudioLines },
  { value: "shared", label: "Mail & Drive", icon: Share2 },
  { value: "invoices", label: "Invoices", icon: Receipt },
  { value: "briefs", label: "Briefs", icon: NotebookPen },
];
export const sourceMeta = (s: NotificationSource) => SOURCES.find((x) => x.value === s)!;

export type Priority = "urgent" | "high" | "normal" | "low";

export const isResolved = (n: { data: unknown }) => (n.data as { resolved?: unknown } | null)?.resolved === true;

const HIGH = new Set([
  "mention",
  "wb_mention",
  "assigned",
  "project_due_soon",
  "project_added",
  "invoice_needs_file",
  "wb_guest_comment",
  "brief_submitted",
  "delivery_feedback",
  "delivery_approved",
  "board_invited",
  "meeting_shared",
  "mail_thread_shared",
  "drive_item_shared",
]);
const LOW = new Set(["automation", "due_completed", "invoice_saved", "refund_saved"]);

/** Late things first, then what's addressed to you, then updates, then FYIs. */
export function priorityOf(n: { kind: string; data: unknown }): Priority {
  if (isResolved(n)) return "low";
  if (n.kind === "project_overdue" || n.kind === "watch_alert") return "urgent";
  if (HIGH.has(n.kind)) return "high";
  if (LOW.has(n.kind)) return "low";
  return "normal";
}

/** Unread and asking for you: the "Needs you" list. */
export const needsYou = (n: NotificationRow) => !n.read_at && (priorityOf(n) === "urgent" || priorityOf(n) === "high");

const str = (d: unknown, k: string) => {
  const v = (d as Record<string, unknown> | null)?.[k];
  return typeof v === "string" && v ? v : null;
};

/** Notifications about the same thing share a key (one card, one project, one meeting…). */
function bundleKey(n: NotificationRow): string {
  if (n.card_id) return `card:${n.card_id}`;
  if (n.source === "projects") return `project:${str(n.data, "project_id") ?? n.id}`;
  if (n.source === "deliveries") return `delivery:${str(n.data, "folder_id") ?? n.id}`;
  if (n.source === "whiteboards" && n.board_id) return `wb:${n.board_id}`;
  if (n.source === "meetings") return `meeting:${str(n.data, "meeting_id") ?? n.id}`;
  if (n.kind === "invoice_saved" || n.kind === "refund_saved") return "invoices";
  if (n.kind === "invoice_needs_file") return "invoice-files";
  if (n.kind === "watch_alert") return `alert:${str(n.data, "alert_id") ?? n.id}`;
  if (n.kind === "board_invited" && n.board_id) return `board:${n.board_id}`;
  return n.id;
}

export interface Bundle {
  key: string;
  /** Newest first; the first is the one shown. */
  items: NotificationRow[];
  unread: number;
  priority: Priority;
}

const RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Rows (newest first) into bundles, in order of each bundle's newest row. */
export function bundle(rows: NotificationRow[]): Bundle[] {
  const map = new Map<string, Bundle>();
  for (const n of rows) {
    const key = bundleKey(n);
    let b = map.get(key);
    if (!b) map.set(key, (b = { key, items: [], unread: 0, priority: "low" }));
    b.items.push(n);
    if (!n.read_at) b.unread++;
    const p = priorityOf(n);
    if (RANK[p] < RANK[b.priority]) b.priority = p;
  }
  return [...map.values()];
}

export type Bucket = "Today" | "Yesterday" | "This week" | "Earlier";

export function bucketOf(iso: string, now = new Date()): Bucket {
  const d = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return "Today";
  if (t >= start - 86400000) return "Yesterday";
  if (t >= start - 6 * 86400000) return "This week";
  return "Earlier";
}

/** Bundles grouped by day, newest first. */
export function byDay(bundles: Bundle[]): [Bucket, Bundle[]][] {
  const out = new Map<Bucket, Bundle[]>();
  for (const b of bundles) {
    const k = bucketOf(b.items[0]!.created_at);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(b);
  }
  return [...out.entries()];
}

/** What a bundle is about, for its "3 updates on …" line. */
export function bundleSubject(b: Bundle): string | null {
  const n = b.items[0]!;
  if (n.card_title) return n.card_title;
  if (n.source === "projects") return str(n.data, "project");
  if (n.source === "meetings" || n.source === "deliveries") return str(n.data, "title");
  if (n.board_title) return n.board_title;
  if (b.key === "invoices") return "invoices";
  return null;
}

/** Where it's from, said once: the project, the board (for card rows), the account. */
export function contextOf(n: NotificationRow): string | null {
  if (n.source === "projects") return str(n.data, "project");
  if (n.source === "deliveries") return str(n.data, "project") ?? str(n.data, "title");
  if (n.card_title && n.board_title) return n.board_title;
  if (n.source === "shared" || n.source === "meetings") return str(n.data, "account_email");
  if (n.source === "alerts") return str(n.data, "group");
  return null;
}

export type Filter = "all" | "needs" | NotificationSource;

export function applyFilter(rows: NotificationRow[], f: Filter, unreadOnly: boolean, query = ""): NotificationRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (n) =>
      (f === "all" || (f === "needs" ? needsYou(n) : n.source === f)) &&
      (!unreadOnly || !n.read_at) &&
      (!q || JSON.stringify([n.card_title, n.board_title, n.data]).toLowerCase().includes(q)),
  );
}
