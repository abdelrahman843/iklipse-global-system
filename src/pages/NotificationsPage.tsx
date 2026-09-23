import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { relativeTime } from "@/lib/format";
import {
  listNotifications,
  markAllRead,
  markRead,
} from "@/lib/pm/notificationsApi";
import { useAuth } from "@/lib/auth";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";

export function NotificationsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  useNotificationsRealtime(user?.id);

  const { data, isLoading, error } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => listNotifications(200),
  });

  const markAll = useMutation({
    mutationFn: markAllRead,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notif-unread"] });
    },
  });

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load notifications" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-start sm:items-center gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-subtle mb-1">Inbox</div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Notifications</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">Everything you're mentioned in, assigned to, or watching.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<CheckCheck size={14} />}
          onClick={() => markAll.mutate()}
          loading={markAll.isPending}
          className="shrink-0"
        >
          <span className="hidden sm:inline">Mark all read</span>
          <span className="sm:hidden">Read all</span>
        </Button>
      </div>

      {(data ?? []).length === 0 ? (
        <EmptyState title="You're all caught up." description="No notifications to show." />
      ) : (
        <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
          {(data ?? []).map((n) => (
            <Link
              key={n.id}
              to={
                n.card_id && n.board_id
                  ? `/pm/boards/${n.board_id}/cards/${n.card_id}`
                  : n.board_id
                    ? `/pm/boards/${n.board_id}`
                    : "#"
              }
              onClick={async () => {
                if (!n.read_at) {
                  await markRead([n.id]);
                  qc.invalidateQueries({ queryKey: ["notifications"] });
                  qc.invalidateQueries({ queryKey: ["notif-unread"] });
                }
              }}
              className={"block px-3 sm:px-4 py-3 hover:bg-inset transition-colors " + (!n.read_at ? "bg-accent-soft/40 border-l-2 border-accent" : "")}
            >
              <div className="flex items-center gap-2 text-sm">
                <Badge tone="neutral">{n.kind}</Badge>
                <div className="flex-1 truncate font-medium text-ink">
                  {n.card_title ?? n.board_title ?? "Notification"}
                </div>
                <div className="text-xs text-subtle">{relativeTime(n.created_at)}</div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
