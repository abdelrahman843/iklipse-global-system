import { useState } from "react";
import { BackButton } from "@/components/ui/BackButton";
import { Segmented } from "@/components/ui/Controls";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { NotificationItem, notificationHref } from "@/components/pm/NotificationBell";
import {
  listNotifications,
  markAllRead,
  markRead,
  type NotificationProduct,
} from "@/lib/pm/notificationsApi";
import { useAuth } from "@/lib/auth";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";

export function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user, trelloRole, miroRole } = useAuth();
  useNotificationsRealtime(user?.id);
  // Trello and Miro notifications are kept apart (All shows both).
  const both = !!trelloRole && !!miroRole;
  const [picked, setPicked] = useState<NotificationProduct | "all">("all");
  const product: NotificationProduct | "all" = both ? picked : miroRole && !trelloRole ? "whiteboard" : "kanban";

  const { data, isLoading, error } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => listNotifications(200),
  });

  const markAll = useMutation({
    mutationFn: () => markAllRead(product === "all" ? undefined : product),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["notif-unread"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't mark all as read", description: e.message }),
  });

  const rows = (data ?? []).filter((n) => product === "all" || n.product === product);

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
        <BackButton fallback="/" />
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
          className="shrink-0 max-sm:h-10 max-sm:min-w-10"
        >
          <span className="hidden sm:inline">Mark all read</span>
          {/* Icon only under 360px so "Notifications" keeps its line. */}
          <span className="sr-only min-[360px]:not-sr-only sm:hidden">Read all</span>
        </Button>
      </div>

      {both && (
        <div className="mb-4">
          <Segmented<NotificationProduct | "all">
            value={picked}
            onChange={setPicked}
            options={[
              { value: "all", label: "All" },
              { value: "kanban", label: "Trello" },
              { value: "whiteboard", label: "Miro" },
            ]}
          />
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="You're all caught up." description="No notifications to show." />
      ) : (
        <div className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
          {rows.map((n) => (
            <NotificationItem
              key={n.id}
              n={n}
              showProduct={product === "all"}
              to={notificationHref(n, "#")}
              onOpen={async () => {
                if (!n.read_at) {
                  await markRead([n.id]);
                  qc.invalidateQueries({ queryKey: ["notifications"] });
                  qc.invalidateQueries({ queryKey: ["notif-unread"] });
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
