import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Inbox, X } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { listNotifications, markAllRead, markRead, unreadCount } from "@/lib/pm/notificationsApi";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";
import { kindLabel, kindTone } from "@/components/pm/NotificationBell";

export function useUnreadCount() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["notif-unread"], queryFn: unreadCount, refetchInterval: 60_000, enabled: !!user });
  return q.data ?? 0;
}

// Trello-style Inbox that slides in over the left edge of the board.
export function InboxPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  useNotificationsRealtime(user?.id);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const list = useQuery({ queryKey: ["notifications"], queryFn: () => listNotifications(100) });
  const unread = useUnreadCount();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector("[role=dialog]") && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["notif-unread"] });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const rows = (list.data ?? []).filter((n) => filter === "all" || !n.read_at);

  return (
    <aside className="absolute left-2 sm:left-4 top-2 sm:top-4 bottom-20 sm:bottom-24 z-20 w-[calc(100%-1rem)] sm:w-[360px] flex flex-col rounded-xl border border-border bg-surface shadow-raise animate-inbox-in overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <Inbox size={18} className="text-accent" />
        <h2 className="flex-1 text-base font-semibold text-ink">Inbox</h2>
        {unread > 0 && (
          <button
            onClick={async () => {
              await markAllRead();
              bump();
            }}
            className="text-xs font-medium text-accent hover:underline inline-flex items-center gap-1"
          >
            <CheckCheck size={13} /> Mark all read
          </button>
        )}
        <button onClick={onClose} className="p-1 rounded-md text-subtle hover:text-ink hover:bg-inset transition-colors" aria-label="Close inbox">
          <X size={16} />
        </button>
      </div>
      <div className="px-4 pb-2 flex gap-1 text-xs">
        {(["all", "unread"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={cn(
              "px-2.5 py-1 rounded-full font-medium capitalize transition-colors",
              filter === k ? "bg-accent-soft text-accent" : "text-muted hover:bg-inset hover:text-ink",
            )}
          >
            {k}
            {k === "unread" && unread > 0 && <span className="ml-1 tabular-nums">{unread}</span>}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto border-t border-line">
        {list.isLoading ? (
          <div className="py-10 grid place-items-center">
            <Spinner size={18} />
          </div>
        ) : rows.length === 0 ? (
          <div className="py-12 px-6 text-center">
            <Inbox size={26} className="mx-auto mb-2 text-subtle" />
            <div className="text-sm font-medium text-ink">You're all caught up</div>
            <div className="text-xs text-muted mt-1">Mentions, assignments and watched cards show up here.</div>
          </div>
        ) : (
          rows.map((n, i) => (
            <Link
              key={n.id}
              to={n.card_id && n.board_id ? `/pm/boards/${n.board_id}/cards/${n.card_id}` : n.board_id ? `/pm/boards/${n.board_id}` : "/pm/notifications"}
              onClick={async () => {
                if (!n.read_at) await markRead([n.id]);
                bump();
              }}
              style={{ "--i": i } as React.CSSProperties}
              className={cn(
                "rise relative block px-4 py-2.5 border-b border-line hover:bg-inset transition-colors",
                !n.read_at && "bg-accent-soft/30",
              )}
            >
              {!n.read_at && <span className="absolute left-1.5 top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-accent" />}
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={kindTone(n.kind)} className="text-[10px]">
                  {kindLabel(n.kind)}
                </Badge>
                <div className="flex-1 truncate font-medium text-ink">{n.card_title ?? n.board_title ?? "Notification"}</div>
              </div>
              <div className="text-xs text-subtle mt-0.5 truncate">
                {n.card_title && n.board_title ? `${n.board_title} · ` : ""}
                {relativeTime(n.created_at)}
              </div>
            </Link>
          ))
        )}
      </div>
      <Link to="/pm/notifications" className="px-4 py-2.5 text-center text-sm text-accent hover:bg-inset border-t border-line transition-colors">
        Open full inbox
      </Link>
    </aside>
  );
}
