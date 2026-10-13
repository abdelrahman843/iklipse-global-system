import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, Maximize2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Menu } from "@/components/ui/Menu";
import { PushStrip } from "@/components/PushSettings";
import { LogoLoader } from "@/components/ui/Spinner";
import { listNotifications, markAllRead, markRead, unreadCounts } from "@/lib/pm/notificationsApi";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/ui/Toast";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";
import { NotificationFeed } from "@/components/notifications/NotificationFeed";
import { FilterChips, useFilterCounts } from "@/components/notifications/FilterChips";
import { applyFilter, type Filter } from "@/components/notifications/smart";

// What a notification says, its icon and where it opens (kept here for older imports).
export * from "@/components/notifications/kinds";

export function NotificationBell() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  useNotificationsRealtime(user?.id);

  const [filter, setFilter] = useState<Filter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const unread = useQuery({ queryKey: ["notif-unread", "split"], queryFn: unreadCounts, refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ["notifications"], queryFn: () => listNotifications(150) });

  const rows = list.data ?? [];
  const count = unread.data?.all ?? 0;
  const counts = useFilterCounts(rows, unread.data);
  const shown = applyFilter(rows, filter, unreadOnly).slice(0, 60);
  const unreadShown = applyFilter(rows, filter, true);

  const bump = () => {
    void qc.invalidateQueries({ queryKey: ["notif-unread"] });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const markAll = useMutation({
    mutationFn: () => (filter === "all" ? markAllRead() : markRead(unreadShown.map((n) => n.id))),
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
        <div className="w-[420px] max-w-[94vw] flex flex-col max-h-[min(72vh,36rem,var(--menu-max,100vh))]">
          <div className="shrink-0 px-4 pt-3 pb-2 border-b border-line space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="text-lg font-semibold text-ink">Notifications</div>
              {count > 0 && <span className="rounded-full bg-accent-soft text-accent text-xs font-semibold px-2 py-0.5 tabular-nums">{count} new</span>}
              <div className="ml-auto flex items-center gap-0.5">
                {unreadShown.length > 0 && (
                  <button
                    type="button"
                    onClick={() => markAll.mutate()}
                    disabled={markAll.isPending}
                    title={filter === "all" ? "Mark all as read" : "Mark these as read"}
                    aria-label={filter === "all" ? "Mark all as read" : "Mark these as read"}
                    className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink disabled:opacity-60"
                  >
                    <CheckCheck size={16} />
                  </button>
                )}
                <Link
                  to={filter === "all" ? "/notifications" : `/notifications?from=${filter}`}
                  onClick={close}
                  title="Open all notifications"
                  aria-label="Open all notifications"
                  className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
                >
                  <Maximize2 size={15} />
                </Link>
              </div>
            </div>
            <FilterChips value={filter} onChange={setFilter} counts={counts} />
          </div>

          <PushStrip />
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-2">
            {list.isLoading ? (
              <div className="px-4 py-10 flex justify-center">
                <LogoLoader width={72} />
              </div>
            ) : list.error ? (
              <div className="px-4 py-10 text-center text-base text-danger">Couldn't load notifications.</div>
            ) : (
              <NotificationFeed
                rows={shown}
                filter={filter}
                onNavigate={close}
                onSeeNeeds={() => setFilter("needs")}
                empty={unreadOnly ? "No unread notifications here." : filter === "needs" ? "Nothing needs you right now." : undefined}
              />
            )}
          </div>

          <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-t border-line">
            <label className="inline-flex items-center gap-1.5 text-sm text-muted cursor-pointer select-none">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              Unread only
            </label>
            <Link to="/notifications" className="ml-auto text-base text-accent hover:underline" onClick={close}>
              See all
            </Link>
          </div>
        </div>
      )}
    </Menu>
  );
}
