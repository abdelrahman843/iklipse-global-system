import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bell, BellOff, CheckCheck, CheckCircle2, Clock, Kanban, MessageCircle, MessageSquareQuote, Shapes, UserPlus, Zap } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Menu } from "@/components/ui/Menu";
import { relativeTime } from "@/lib/format";
import { listNotifications, markAllRead, markRead, unreadCounts, type NotificationProduct } from "@/lib/pm/notificationsApi";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";

export function NotificationBell() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, trelloRole, miroRole } = useAuth();
  const loc = useLocation();
  useNotificationsRealtime(user?.id);

  // Trello and Miro notifications are kept apart; the bell opens on the one you're in.
  const both = !!trelloRole && !!miroRole;
  const here: Tab = loc.pathname.startsWith("/wb") ? "whiteboard" : loc.pathname.startsWith("/pm") ? "kanban" : "all";
  const [picked, setTab] = useState<Tab | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const tab: Tab = !both ? (miroRole && !trelloRole ? "whiteboard" : "kanban") : (picked ?? here);
  const unread = useQuery({ queryKey: ["notif-unread", "split"], queryFn: unreadCounts, refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ["notifications"], queryFn: () => listNotifications(60) });

  const counts = unread.data ?? { all: 0, kanban: 0, whiteboard: 0 };
  const count = counts.all;
  const shown = (list.data ?? []).filter((n) => (tab === "all" || n.product === tab) && (!unreadOnly || !n.read_at)).slice(0, 25);
  const groups: [string, typeof shown][] = [
    ["New", shown.filter((n) => !n.read_at)],
    ["Earlier", shown.filter((n) => n.read_at)],
  ];
  const tabCount = tab === "all" ? counts.all : counts[tab];

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const markAll = useMutation({
    mutationFn: () => markAllRead(tab === "all" ? undefined : tab),
    onSuccess: bump,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't mark all as read", description: e.message }),
  });

  return (
    <Menu
      align="right"
      trigger={
        <button
          className="relative h-10 w-10 md:h-8 md:w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150"
          aria-label={`Notifications${count ? ` (${count} unread)` : ""}`}
        >
          <Bell size={16} />
          {count > 0 && (
            <span
              key={count}
              className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold inline-flex items-center justify-center animate-scale-in"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      }
    >
      {(close) => (
        <div className="w-[400px] max-w-[92vw] flex flex-col max-h-[min(60vh,30rem)]">
          <div className="shrink-0 px-4 pt-3 pb-3 border-b border-line space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-ink">Notifications</div>
              <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
                Unread only
              </label>
            </div>
            {both && (
              <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-inset" role="tablist" aria-label="Notifications from">
                {(
                  [
                    ["all", "All", counts.all],
                    ["kanban", "Trello", counts.kanban],
                    ["whiteboard", "Miro", counts.whiteboard],
                  ] as const
                ).map(([t, label, n]) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "h-8 rounded-md text-sm font-medium inline-flex items-center justify-center gap-1.5 transition-colors",
                      tab === t ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
                    )}
                  >
                    {label}
                    {n > 0 && <span className={cn("text-xs tabular-nums", tab === t ? "text-accent" : "text-subtle")}>{n > 99 ? "99+" : n}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-1">
            {list.isLoading ? (
              <div className="px-4 py-10 text-center text-sm text-subtle">Loading…</div>
            ) : list.error ? (
              <div className="px-4 py-10 text-center text-sm text-danger">Couldn't load notifications.</div>
            ) : shown.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto h-11 w-11 rounded-full bg-inset grid place-items-center text-subtle">
                  <BellOff size={20} />
                </div>
                <div className="mt-2 text-sm font-medium text-ink">You're all caught up</div>
                <div className="text-xs text-subtle">{unreadOnly ? "No unread notifications here." : "Nothing here yet."}</div>
              </div>
            ) : (
              groups.map(([title, rows]) =>
                rows.length ? (
                  <section key={title}>
                    <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-eyebrow text-subtle">{title}</div>
                    {rows.map((n) => (
                      <NotificationItem
                        key={n.id}
                        n={n}
                        showProduct={tab === "all"}
                        to={notificationHref(n, "/pm/notifications")}
                        onOpen={async () => {
                          if (!n.read_at) await markRead([n.id]);
                          bump();
                          close();
                        }}
                      />
                    ))}
                  </section>
                ) : null,
              )
            )}
          </div>

          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-t border-line">
            <Link to="/pm/notifications" className="text-sm text-accent hover:underline" onClick={close}>
              See all
            </Link>
            {tabCount > 0 && (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="ml-auto h-8 px-2 -mr-2 rounded-md text-sm text-muted hover:bg-inset hover:text-ink inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                <CheckCheck size={14} /> Mark all as read
              </button>
            )}
          </div>
        </div>
      )}
    </Menu>
  );
}

type Tab = NotificationProduct | "all";

// ------------------------------------------------------------------ rows --
type Row = {
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
  const d = (n.data ?? {}) as { by?: unknown; excerpt?: unknown; doc_title?: unknown; text?: unknown; due?: unknown };
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
    default:
      return { head: n.card_title ?? n.board_title ?? "Notification", detail: excerpt };
  }
}

const KIND_ICON: Record<string, typeof Bell> = {
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
};
const TONE_TEXT = { accent: "text-accent", success: "text-success", warn: "text-warn", danger: "text-danger", neutral: "text-muted" } as const;

/** One notification: icon, what happened, the comment text, where and when; a dot while unread. */
export function NotificationItem({ n, to, onOpen, showProduct }: { n: Row; to: string; onOpen: () => void; showProduct?: boolean }) {
  const { head, detail } = notificationText(n);
  const Icon = KIND_ICON[n.kind] ?? Bell;
  const unread = !n.read_at;
  // Card notifications also say which board (Miro ones already name it).
  const context = n.card_title && n.board_title ? n.board_title : null;
  return (
    <Link to={to} onClick={onOpen} className="group flex gap-3 px-4 py-2.5 hover:bg-inset transition-colors duration-100">
      <span className={cn("mt-0.5 h-8 w-8 shrink-0 rounded-full bg-inset grid place-items-center group-hover:bg-surface", TONE_TEXT[kindTone(n.kind)])}>
        <Icon size={15} />
      </span>
      <div className="flex-1 min-w-0">
        <div className={cn("text-sm leading-snug break-words line-clamp-2", unread ? "text-ink font-medium" : "text-muted")}>{head}</div>
        {detail && <div className="mt-1 text-[13px] text-muted leading-snug line-clamp-2 break-words border-l-2 border-line pl-2">{detail}</div>}
        <div className="mt-1 flex items-center gap-1.5 text-xs text-subtle min-w-0">
          {showProduct && n.product && (
            <span className="inline-flex items-center gap-1 shrink-0">
              {n.product === "whiteboard" ? <Shapes size={12} /> : <Kanban size={12} />}
              {n.product === "whiteboard" ? "Miro" : "Trello"}
              <span aria-hidden>·</span>
            </span>
          )}
          {context && (
            <>
              <span className="truncate">{context}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="shrink-0">{relativeTime(n.created_at)}</span>
        </div>
      </div>
      {unread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
    </Link>
  );
}

const WB_KINDS = new Set(["wb_mention", "wb_reply", "wb_guest_comment"]);

/** Where a notification opens. Whiteboard comments open their thread on the canvas, doc mentions the doc. */
export function notificationHref(
  n: { kind: string; board_id: string | null; card_id: string | null; data: unknown; product?: NotificationProduct },
  fallback: string,
): string {
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
    default:
      return kind;
  }
}
