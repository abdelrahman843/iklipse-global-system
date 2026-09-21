import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { Menu } from "@/components/ui/Menu";
import { Badge } from "@/components/ui/Badge";
import { relativeTime } from "@/lib/format";
import { listNotifications, markAllRead, markRead, unreadCount } from "@/lib/pm/notificationsApi";
import { useAuth } from "@/lib/auth";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";

export function NotificationBell() {
  const qc = useQueryClient();
  const { user } = useAuth();
  useNotificationsRealtime(user?.id);

  const unread = useQuery({ queryKey: ["notif-unread"], queryFn: unreadCount, refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ["notifications"], queryFn: () => listNotifications(20) });

  const count = unread.data ?? 0;

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  return (
    <Menu
      align="right"
      trigger={
        <button
          className="relative rounded-md p-1.5 text-muted hover:bg-surface hover:text-ink"
          aria-label={`Notifications${count ? ` (${count} unread)` : ""}`}
        >
          <Bell size={16} />
          {count > 0 && (
            <span className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-semibold inline-flex items-center justify-center">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      }
    >
      {(close) => (
        <div className="w-80 max-w-[85vw]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line">
            <div className="text-sm font-semibold">Notifications</div>
            {count > 0 && (
              <button
                onClick={async () => {
                  await markAllRead();
                  bump();
                }}
                className="text-xs text-accent hover:underline inline-flex items-center gap-1"
              >
                <CheckCheck size={12} /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-auto">
            {list.isLoading ? (
              <div className="px-3 py-6 text-center text-sm text-subtle">Loading…</div>
            ) : (list.data ?? []).length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-subtle">You're all caught up.</div>
            ) : (
              (list.data ?? []).map((n) => (
                <Link
                  key={n.id}
                  to={
                    n.card_id && n.board_id
                      ? `/pm/boards/${n.board_id}/cards/${n.card_id}`
                      : n.board_id
                        ? `/pm/boards/${n.board_id}`
                        : "/pm/notifications"
                  }
                  onClick={async () => {
                    if (!n.read_at) await markRead([n.id]);
                    bump();
                    close();
                  }}
                  className={
                    "block px-3 py-2 border-b border-line hover:bg-surface" +
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
                  <div className="text-xs text-subtle mt-0.5">{relativeTime(n.created_at)}</div>
                </Link>
              ))
            )}
          </div>

          <div className="px-3 py-2 text-center border-t border-line">
            <Link to="/pm/notifications" className="text-sm text-accent hover:underline" onClick={close}>
              See all notifications
            </Link>
          </div>
        </div>
      )}
    </Menu>
  );
}

function kindTone(kind: string): "accent" | "success" | "warn" | "neutral" | "danger" {
  switch (kind) {
    case "mention":
      return "accent";
    case "assigned":
      return "success";
    case "due_changed":
    case "due_completed":
      return "warn";
    case "board_invited":
      return "accent";
    default:
      return "neutral";
  }
}
function kindLabel(kind: string): string {
  switch (kind) {
    case "mention":
      return "Mention";
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
    default:
      return kind;
  }
}
