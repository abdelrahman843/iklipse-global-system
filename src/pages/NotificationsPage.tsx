import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { BackButton } from "@/components/ui/BackButton";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { SearchField } from "@/components/ui/SearchField";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { listNotifications, markAllRead, markRead, unreadCounts } from "@/lib/pm/notificationsApi";
import { useAuth } from "@/lib/auth";
import { useNotificationsRealtime } from "@/lib/pm/useBoardRealtime";
import { NotificationFeed } from "@/components/notifications/NotificationFeed";
import { SeenNow } from "@/components/pm/NotificationBell";
import { FilterChips, useFilterCounts } from "@/components/notifications/FilterChips";
import { applyFilter, isResolved, SOURCES, type Filter } from "@/components/notifications/smart";
import { notificationText } from "@/components/notifications/kinds";
import { PageTitle } from "@/components/ui/PageTitle";

const FILTERS = new Set<string>(["all", "needs", ...SOURCES.map((s) => s.value)]);

export function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  useNotificationsRealtime(user?.id);
  const [params, setParams] = useSearchParams();
  const asked = params.get("from") ?? "all";
  const filter: Filter = FILTERS.has(asked) ? (asked as Filter) : "all";
  const setFilter = (f: Filter) => setParams(f === "all" ? {} : { from: f }, { replace: true });
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [query, setQuery] = useState("");

  const { data, isLoading, error } = useQuery({ queryKey: ["notifications"], queryFn: () => listNotifications(300) });
  const unread = useQuery({ queryKey: ["notif-unread", "split"], queryFn: unreadCounts, refetchInterval: 60_000 });
  const rows = data ?? [];
  const counts = useFilterCounts(rows, unread.data);

  const q = query.trim().toLowerCase();
  const shown = applyFilter(rows, filter, unreadOnly).filter((n) => {
    if (!q) return true;
    const t = notificationText(n);
    return [t.head, t.detail, n.board_title, n.card_title].some((s) => s?.toLowerCase().includes(q));
  });
  const unreadShown = applyFilter(rows, filter, true);

  // One line that says what's going on, before any list.
  const late = rows.filter((n) => !n.read_at && n.kind === "project_overdue" && !isResolved(n)).length;
  const soon = rows.filter((n) => !n.read_at && n.kind === "project_due_soon" && !isResolved(n)).length;
  const mentions = rows.filter((n) => !n.read_at && (n.kind === "mention" || n.kind === "wb_mention")).length;
  const summary = [
    late && `${late} late ${late === 1 ? "delivery" : "deliveries"}`,
    soon && `${soon} due soon`,
    mentions && `${mentions} ${mentions === 1 ? "mention" : "mentions"}`,
  ].filter(Boolean) as string[];

  const markAll = useMutation({
    mutationFn: () => (filter === "all" ? markAllRead() : markRead(unreadShown.map((n) => n.id))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
      void qc.invalidateQueries({ queryKey: ["notif-unread"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't mark all as read", description: e.message }),
  });

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load notifications" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="p-3 sm:p-4 md:p-6">
      <SeenNow />
      <div className="flex items-start sm:items-center gap-3 mb-5">
        <BackButton fallback="/" />
        <div className="flex-1 min-w-0">
          <PageTitle>Notifications</PageTitle>
          <p className="text-base text-muted mt-1">
            {summary.length ? (
              <span className="text-warn font-medium">{summary.join(" · ")}</span>
            ) : (unread.data?.all ?? 0) > 0 ? (
              `${unread.data!.all} unread, nothing urgent.`
            ) : (
              "You're all caught up."
            )}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<CheckCheck size={14} />}
          onClick={() => markAll.mutate()}
          loading={markAll.isPending}
          disabled={!unreadShown.length}
          className="shrink-0 max-sm:h-10"
        >
          <span className="hidden sm:inline">{filter === "all" ? "Mark all read" : "Mark these read"}</span>
          <span className="sr-only min-[360px]:not-sr-only sm:hidden">Read all</span>
        </Button>
      </div>

      <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)] items-start">
        {/* Desktop: sources down the side. Phone: chips. */}
        <nav className="hidden md:block md:sticky md:top-4" aria-label="Show notifications from">
          <ul className="space-y-0.5">
            {counts.map((c) => (
              <li key={c.value}>
                <button
                  type="button"
                  onClick={() => setFilter(c.value)}
                  aria-current={filter === c.value}
                  className={cn(
                    "w-full h-9 px-3 rounded-lg flex items-center gap-2.5 text-base transition-colors",
                    filter === c.value ? "bg-accent-soft text-accent font-medium" : "text-muted hover:bg-inset hover:text-ink",
                  )}
                >
                  {c.icon ? <c.icon size={15} className={cn(c.value === "needs" && c.unread > 0 && filter !== c.value && "text-warn")} /> : <span className="w-[15px]" />}
                  <span className="flex-1 text-left truncate">{c.label}</span>
                  {c.unread > 0 && <span className={cn("text-xs tabular-nums font-semibold", c.value === "needs" ? "text-warn" : "")}>{c.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          <div className="md:hidden mb-3">
            <FilterChips value={filter} onChange={setFilter} counts={counts} />
          </div>
          <div className="flex items-center gap-3 mb-3">
            <SearchField value={query} onChange={setQuery} placeholder="Search notifications" className="flex-1" />
            <label className="inline-flex items-center gap-1.5 text-sm text-muted cursor-pointer select-none shrink-0">
              <input type="checkbox" className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
              <span className="sm:hidden">Unread</span>
              <span className="hidden sm:inline">Unread only</span>
            </label>
          </div>
          <div key={filter} className="view-enter -mx-3 sm:-mx-4 pb-2">
            <NotificationFeed
              rows={shown}
              filter={filter}
              pin={!q}
              attentionMax={5}
              onSeeNeeds={() => setFilter("needs")}
              empty={q ? "Nothing matches that search." : unreadOnly ? "No unread notifications here." : filter === "needs" ? "Nothing needs you right now." : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
