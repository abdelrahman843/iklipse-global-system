import { AlertTriangle, AtSign, AudioLines, Bell, CalendarClock, CheckCircle2, Clock, Download, HardDrive, Mail, MessageCircle, MessageSquareQuote, NotebookPen, PackageCheck, PackageOpen, Receipt, Undo2, Upload, UserPlus, Zap } from "lucide-react";
import type { NotificationProduct } from "@/lib/pm/notificationsApi";

// -----------------------------------------------------------------------------
// What each kind of notification says, its icon and tone, and where it opens.
// Shared by the bell, the Notifications page and the Trello inbox.
// -----------------------------------------------------------------------------

// ------------------------------------------------------------------ rows --
export type Row = {
  kind: string;
  data: unknown;
  read_at: string | null;
  created_at: string;
  board_title: string | null;
  card_title: string | null;
  product?: NotificationProduct;
};

/** What happened, in plain words (and the comment text, when there is one). */
export function notificationText(n: Row): { head: string; detail: string | null } {
  const d = (n.data ?? {}) as { by?: unknown; excerpt?: unknown; doc_title?: unknown; text?: unknown; due?: unknown; account_email?: unknown };
  const by = typeof d.by === "string" && d.by ? d.by : null;
  const excerpt = typeof d.excerpt === "string" && d.excerpt.trim() ? d.excerpt.trim() : null;
  const card = n.card_title ?? "a card";
  const board = n.board_title ?? "a board";
  switch (n.kind) {
    case "mention":
      return { head: `You were mentioned on ${card}`, detail: null };
    case "assigned":
      return { head: `You were added to ${card}`, detail: null };
    case "comment":
      return { head: `New comment on ${card}`, detail: null };
    case "due_changed": {
      const due = typeof d.due === "string" && d.due ? new Date(d.due) : null;
      const when = due && !isNaN(due.getTime()) ? due.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
      return { head: `Due date changed on ${card}`, detail: when ? `Now due ${when}` : null };
    }
    case "due_completed":
      return { head: `${card} was marked complete`, detail: null };
    case "board_invited":
      return { head: `You were added to ${board}`, detail: null };
    case "automation":
      return { head: typeof d.text === "string" && d.text ? d.text : `A rule ran on ${card}`, detail: null };
    case "wb_mention":
      return { head: `${by ?? "Someone"} mentioned you in ${typeof d.doc_title === "string" && d.doc_title ? d.doc_title : board}`, detail: excerpt };
    case "wb_reply":
      return { head: `${by ?? "Someone"} replied on ${board}`, detail: excerpt };
    case "wb_guest_comment":
      return { head: `${by ?? "A client"} commented on ${board}`, detail: excerpt };
    case "mail_shared": {
      const who = by ?? "Someone";
      const what = typeof d.account_email === "string" && d.account_email ? d.account_email : "a Gmail account";
      return { head: `${who} shared ${what} with you`, detail: null };
    }
    case "mail_thread_shared":
      return { head: `${by ?? "Someone"} shared an email with you`, detail: excerpt };
    case "drive_shared": {
      const what = typeof d.account_email === "string" && d.account_email ? `the Drive ${d.account_email}` : "a Google Drive";
      return { head: `${by ?? "Someone"} shared ${what} with you`, detail: null };
    }
    case "drive_item_shared":
      return { head: `${by ?? "Someone"} shared a ${(d as { folder?: unknown }).folder ? "folder" : "file"} with you`, detail: excerpt };
    case "meeting_shared": {
      const t = (d as { title?: unknown }).title;
      return { head: `${by ?? "Someone"} shared a meeting with you${typeof t === "string" && t ? `: ${t}` : ""}`, detail: excerpt };
    }
    case "invoice_saved":
    case "refund_saved": {
      const v = d as { provider?: unknown; amount?: unknown; currency?: unknown; excerpt?: unknown };
      const what = n.kind === "refund_saved" ? "New refund" : "New invoice";
      const amount = typeof v.amount === "string" && v.amount ? ` · ${v.amount}${typeof v.currency === "string" && v.currency ? ` ${v.currency}` : ""}` : "";
      return { head: `${what}: ${typeof v.provider === "string" && v.provider ? v.provider : "Unknown"}${amount}`, detail: typeof v.excerpt === "string" ? v.excerpt : null };
    }
    case "invoice_needs_file": {
      const v = d as { provider?: unknown; excerpt?: unknown };
      return {
        head: `Invoice to download: ${typeof v.provider === "string" && v.provider ? v.provider : "Unknown"}`,
        detail: typeof v.excerpt === "string" ? v.excerpt : null,
      };
    }
    case "brief_submitted": {
      const who = typeof (d as { label?: unknown }).label === "string" ? (d as { label: string }).label : "Someone";
      return { head: `${who} sent their brief`, detail: null };
    }
    case "delivery_opened":
    case "delivery_feedback":
    case "delivery_approved":
      return deliveryText(n.kind, d as Record<string, unknown>, by, excerpt);
    case "project_added":
    case "project_due_soon":
    case "project_overdue":
    case "project_due_changed":
    case "project_delivery_done":
    case "project_note":
    case "project_file":
      return projectText(n.kind, d as Record<string, unknown>, by, excerpt);
    default:
      return { head: n.card_title ?? n.board_title ?? "Notification", detail: excerpt };
  }
}

/** Deliveries sent to clients (0062): opened, feedback sent, approved. */
function deliveryText(kind: string, d: Record<string, unknown>, by: string | null, excerpt: string | null): { head: string; detail: string | null } {
  const title = typeof d.title === "string" && d.title ? d.title : "a delivery";
  const who = by ?? "The client";
  const round = typeof d.round === "number" && d.round > 1 ? ` (round ${d.round})` : "";
  if (kind === "delivery_opened") return { head: `${who} opened ${title}`, detail: typeof d.email === "string" ? d.email : null };
  if (kind === "delivery_approved") return { head: `${who} approved ${title}${round}`, detail: excerpt };
  const n = Number(d.comments ?? 0);
  return { head: `${who} sent feedback on ${title}${round}`, detail: excerpt ?? (n ? `${n} ${n === 1 ? "comment" : "comments"}` : null) };
}

/** The project notifications (0058): who, which project, which delivery, when. */
function projectText(kind: string, d: Record<string, unknown>, by: string | null, excerpt: string | null): { head: string; detail: string | null } {
  const s = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : null);
  const project = s("project") ?? "a project";
  const delivery = s("delivery");
  const when = s("when");
  const what = delivery ? `${delivery} · ${project}` : project;
  switch (kind) {
    case "project_added":
      return { head: `${by ?? "Someone"} added you to ${project}`, detail: s("role") ? `As ${s("role")}` : null };
    case "project_due_soon":
      return { head: `Due soon: ${what}`, detail: when ? `Due ${when}` : null };
    case "project_overdue":
      return { head: `Late: ${what}`, detail: when ? `Was due ${when}` : null };
    case "project_due_changed":
      return d.added
        ? { head: `New delivery on ${project}: ${delivery ?? ""}`, detail: when ? `Due ${when}` : null }
        : { head: `New date for ${what}`, detail: when ? `Now due ${when}` : null };
    case "project_delivery_done":
      return { head: `${by ?? "Someone"} delivered ${delivery ?? "a delivery"} on ${project}`, detail: null };
    case "project_note":
      return { head: `${by ?? "Someone"} wrote a note on ${project}`, detail: excerpt };
    default: {
      const count = typeof d.count === "number" ? d.count : 1;
      return { head: `${by ?? "Someone"} uploaded ${count > 1 ? `${count} files` : s("name") ?? "a file"} to ${project}`, detail: delivery ? `For ${delivery}` : null };
    }
  }
}

export const KIND_ICON: Record<string, typeof Bell> = {
  mention: AtSign,
  wb_mention: AtSign,
  assigned: UserPlus,
  board_invited: UserPlus,
  comment: MessageCircle,
  wb_reply: MessageCircle,
  wb_guest_comment: MessageSquareQuote,
  due_changed: Clock,
  due_completed: CheckCircle2,
  automation: Zap,
  brief_submitted: NotebookPen,
  mail_shared: Mail,
  mail_thread_shared: Mail,
  drive_shared: HardDrive,
  drive_item_shared: HardDrive,
  meeting_shared: AudioLines,
  invoice_saved: Receipt,
  refund_saved: Undo2,
  invoice_needs_file: Download,
  delivery_opened: PackageOpen,
  delivery_feedback: MessageSquareQuote,
  delivery_approved: PackageCheck,
  project_added: UserPlus,
  project_due_soon: Clock,
  project_overdue: AlertTriangle,
  project_due_changed: CalendarClock,
  project_delivery_done: CheckCircle2,
  project_note: MessageCircle,
  project_file: Upload,
};
export const TONE_TEXT = { accent: "text-accent", success: "text-success", warn: "text-warn", danger: "text-danger", neutral: "text-muted" } as const;

const WB_KINDS = new Set(["wb_mention", "wb_reply", "wb_guest_comment"]);
export const isBriefKind = (kind: string) => kind.startsWith("brief_");
/** Not about a Trello / Miro board (briefs, shared mail and Drive): shown on every tab. */
export const isInvoiceKind = (kind: string) => kind === "invoice_saved" || kind === "refund_saved" || kind === "invoice_needs_file";
export const isProjectKind = (kind: string) => kind.startsWith("project_");
export const isDeliveryKind = (kind: string) => kind.startsWith("delivery_");
export const isAppKind = (kind: string) =>
  isBriefKind(kind) || kind.startsWith("mail_") || kind.startsWith("drive_") || isInvoiceKind(kind) || isProjectKind(kind) || isDeliveryKind(kind) || kind === "meeting_shared";

/** Where a notification opens. Whiteboard comments open their thread on the canvas, doc mentions the doc. */
export function notificationHref(
  n: { kind: string; board_id: string | null; card_id: string | null; data: unknown; product?: NotificationProduct },
  fallback: string,
): string {
  if (n.kind.startsWith("mail_")) return "/shared?tab=mail";
  if (n.kind.startsWith("drive_")) return "/shared?tab=drive";
  if (n.kind === "meeting_shared") {
    const id = (n.data as { meeting_id?: unknown } | null)?.meeting_id;
    return typeof id === "string" && id ? `/meetings?tab=shared&m=${id}` : "/meetings?tab=shared";
  }
  if (n.kind === "invoice_needs_file") return "/invoices?tab=files";
  if (isProjectKind(n.kind)) {
    const id = (n.data as { project_id?: unknown } | null)?.project_id;
    return typeof id === "string" && id ? `/projects/${id}${n.kind === "project_file" ? "?tab=files" : ""}` : "/projects";
  }
  if (isDeliveryKind(n.kind)) {
    const id = (n.data as { folder_id?: unknown } | null)?.folder_id;
    return typeof id === "string" && id ? `/deliveries/${id}${n.kind === "delivery_opened" ? "?tab=links" : "?tab=feedback"}` : "/deliveries";
  }
  if (isInvoiceKind(n.kind)) {
    const m = (n.data as { month?: unknown } | null)?.month;
    return typeof m === "string" && /^\d{4}-\d{2}/.test(m) ? `/invoices?month=${m.slice(0, 7)}` : "/invoices";
  }
  if (isBriefKind(n.kind)) {
    const id = (n.data as { link_id?: unknown } | null)?.link_id;
    return typeof id === "string" && id ? `/briefs/${id}` : "/briefs";
  }
  if (n.board_id && (WB_KINDS.has(n.kind) || n.product === "whiteboard")) {
    const doc = (n.data as { doc_id?: unknown } | null)?.doc_id;
    if (typeof doc === "string" && doc) return `/wb/${n.board_id}?doc=${doc}`;
    const t = (n.data as { thread_id?: unknown } | null)?.thread_id;
    return `/wb/${n.board_id}${typeof t === "string" && t ? `?comment=${t}` : ""}`;
  }
  if (n.card_id && n.board_id) return `/pm/boards/${n.board_id}/cards/${n.card_id}`;
  return n.board_id ? `/pm/boards/${n.board_id}` : fallback;
}

/** Whiteboard comment notifications: who wrote it and a short excerpt. */
export function wbExcerpt(n: { kind: string; data: unknown }): string | null {
  if (!WB_KINDS.has(n.kind)) return null;
  const d = n.data as { by?: unknown; excerpt?: unknown; doc_title?: unknown } | null;
  const text = typeof d?.excerpt === "string" ? d.excerpt.trim() : "";
  const where = typeof d?.doc_title === "string" && d.doc_title ? ` in ${d.doc_title}` : "";
  if (!text) return where && typeof d?.by === "string" ? `${d.by}${where}` : null;
  return typeof d?.by === "string" && d.by ? `${d.by}${where}: ${text}` : text;
}

/** Message an automation rule sent ("notify card members"), if any. */
export function ruleText(n: { kind: string; data: unknown }): string | null {
  const t = (n.data as { text?: unknown } | null)?.text;
  return n.kind === "automation" && typeof t === "string" && t ? t : null;
}

export function kindTone(kind: string): "accent" | "success" | "warn" | "neutral" | "danger" {
  switch (kind) {
    case "mention":
    case "wb_mention":
      return "accent";
    case "wb_guest_comment":
      return "warn";
    case "assigned":
      return "success";
    case "due_changed":
    case "due_completed":
      return "warn";
    case "board_invited":
    case "automation":
      return "accent";
    case "brief_submitted":
      return "success";
    case "mail_shared":
    case "mail_thread_shared":
    case "drive_shared":
    case "drive_item_shared":
    case "meeting_shared":
      return "accent";
    case "invoice_saved":
      return "success";
    case "refund_saved":
    case "invoice_needs_file":
      return "warn";
    case "project_overdue":
      return "danger";
    case "delivery_feedback":
      return "warn";
    case "delivery_approved":
      return "success";
    case "delivery_opened":
      return "accent";
    case "project_due_soon":
    case "project_due_changed":
      return "warn";
    case "project_added":
    case "project_delivery_done":
      return "success";
    case "project_note":
    case "project_file":
      return "accent";
    default:
      return "neutral";
  }
}
export function kindLabel(kind: string): string {
  switch (kind) {
    case "mention":
    case "wb_mention":
      return "Mention";
    case "wb_reply":
      return "Reply";
    case "wb_guest_comment":
      return "Client";
    case "assigned":
      return "Assigned";
    case "comment":
      return "Comment";
    case "due_changed":
      return "Due";
    case "due_completed":
      return "Done";
    case "board_invited":
      return "Board";
    case "automation":
      return "Rule";
    case "brief_submitted":
      return "Brief";
    case "mail_shared":
    case "mail_thread_shared":
      return "Mail";
    case "drive_shared":
    case "drive_item_shared":
      return "Drive";
    case "meeting_shared":
      return "Meeting";
    case "invoice_saved":
      return "Invoice";
    case "refund_saved":
      return "Refund";
    case "invoice_needs_file":
      return "Invoice";
    case "project_overdue":
      return "Late";
    case "project_due_soon":
    case "project_due_changed":
      return "Due";
    default:
      return kind.startsWith("project_") ? "Project" : kind.startsWith("delivery_") ? "Delivery" : kind;
  }
}
