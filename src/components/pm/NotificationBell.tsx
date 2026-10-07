import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Menu } from "@/components/ui/Menu";
import { Badge } from "@/components/ui/Badge";
import { relativeTime } from "@/lib/format";
import { listNotifications, markAllRead, markRead, unreadCount } from "@/lib/pm/notificationsApi";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";

export function NotificationBell() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  useNotificationsRealtime(user?.id);

  const unread = useQuery({ queryKey: ["notif-unread"], queryFn: unreadCount, refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ["notifications"], queryFn: () => listNotifications(20) });

  const count = unread.data ?? 0;

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const markAll = useMutation({
    mutationFn: markAllRead,
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
        <div className="w-80 max-w-[85vw]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line">
            <div className="text-sm font-semibold text-ink">Notifications</div>
            {count > 0 && (
              <button
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="-my-1.5 py-1.5 text-xs text-accent hover:underline inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed disabled:no-underline"
              >
                <CheckCheck size={12} /> Mark all read
              </button>
            )}
          </div>

          {/* Short screens (phone landscape): cap the list so the header and
              "See all" footer stay in view instead of scrolling away. */}
          <div className="max-h-[min(24rem,50dvh)] overflow-auto">
            {list.isLoading ? (
              <div className="px-3 py-6 text-center text-sm text-subtle">Loading…</div>
            ) : list.error ? (
              <div className="px-3 py-6 text-center text-sm text-danger">Couldn't load notifications.</div>
            ) : (list.data ?? []).length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-subtle">You're all caught up.</div>
            ) : (
              (list.data ?? []).map((n) => (
                <Link
                  key={n.id}
                  to={notificationHref(n, "/pm/notifications")}
                  onClick={async () => {
                    if (!n.read_at) await markRead([n.id]);
                    bump();
                    close();
                  }}
                  className={
                    "block px-3 py-2 border-b border-line hover:bg-inset transition-colors duration-100" +
                    (!n.read_at ? " bg-accent-soft/40" : "")
                  }
                >
                  <div className="flex items-center gap-2 text-sm">
                    <Badge tone={kindTone(n.kind)} className="text-[10px]">
                      {kindLabel(n.kind)}
                    </Badge>
                    <div className="flex-1 truncate font-medium text-ink">
                      {n.card_title ?? n.board_title ?? "Notification"}
                    </div>
                  </div>
                  {ruleText(n) && <div className="text-xs text-muted mt-0.5 line-clamp-2">{ruleText(n)}</div>}
                  {wbExcerpt(n) && <div className="text-xs text-muted mt-0.5 line-clamp-2 break-words">{wbExcerpt(n)}</div>}
                  <div className="text-xs text-subtle mt-0.5">{relativeTime(n.created_at)}</div>
                </Link>
              ))
            )}
          </div>

          <div className="px-3 py-2 text-center border-t border-line">
            <Link to="/pm/notifications" className="inline-block -my-1.5 py-1.5 text-sm text-accent hover:underline" onClick={close}>
              See all notifications
            </Link>
          </div>
        </div>
      )}
    </Menu>
  );
}

const WB_KINDS = new Set(["wb_mention", "wb_reply"]);

/** Where a notification opens. Whiteboard comments open their thread on the canvas, doc mentions the doc. */
export function notificationHref(
  n: { kind: string; board_id: string | null; card_id: string | null; data: unknown },
  fallback: string,
): string {
  if (n.board_id && WB_KINDS.has(n.kind)) {
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
