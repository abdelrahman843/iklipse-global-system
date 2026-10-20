import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Files, Link2, MessageSquare, PackageCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { SearchField } from "@/components/ui/SearchField";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { StateBadge } from "@/components/deliveries/parts";
import { NewDeliveryModal } from "@/components/deliveries/DeliveryModals";
import { listDeliveries, type DeliveryRow, type DeliveryState } from "@/lib/deliveriesApi";
import { PageTitle, plural } from "@/components/ui/PageTitle";
import { LIVE_FALLBACK } from "@/lib/live";

// -----------------------------------------------------------------------------
// Deliveries: what we send clients for review, like shared folders with
// previews. Each one goes out on links; the client comments and sends their
// feedback, round after round. ?filter=open|submitted|approved.
// -----------------------------------------------------------------------------

type Filter = "all" | DeliveryState;

export default function DeliveriesPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("filter") as Filter | null;
  const filter: Filter = asked === "open" || asked === "submitted" || asked === "approved" ? asked : "all";
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const list = useQuery({ queryKey: ["deliveries"], queryFn: listDeliveries, refetchInterval: LIVE_FALLBACK });
  const folders = useMemo(() => [...(list.data?.folders ?? [])].sort((a, b) => b.last_activity.localeCompare(a.last_activity)), [list.data]);
  const needle = q.trim().toLowerCase();

  const shown = useMemo(
    () =>
      folders.filter(
        (f) => (filter === "all" || f.state === filter) && (!needle || [f.title, f.project, f.client].filter(Boolean).some((x) => x!.toLowerCase().includes(needle))),
      ),
    [folders, filter, needle],
  );
  const count = (s: DeliveryState) => folders.filter((f) => f.state === s).length;

  const tabs: LineTab<Filter>[] = [
    { value: "all", label: "All", count: folders.length },
    { value: "open", label: "Waiting for feedback", count: count("open") },
    { value: "submitted", label: "Feedback in", count: count("submitted") },
    { value: "approved", label: "Approved", count: count("approved") },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <PageTitle count={list.data && plural(folders.length, "delivery", "deliveries")}>Deliveries</PageTitle>
            <p className="text-sm text-muted mt-1 hidden sm:block">Send work to clients on a link. They watch, comment and approve, round after round.</p>
          </div>
          <Button size="sm" variant="primary" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)} className="shrink-0 max-sm:h-10">
            New delivery
          </Button>
        </div>
        <div className="mb-5 flex flex-col-reverse gap-3 lg:flex-row lg:items-end border-b border-border">
          <LineTabs value={filter} tabs={tabs} onChange={(f) => setParams(f === "all" ? {} : { filter: f }, { replace: true })} label="Filter" bare />
          <SearchField value={q} onChange={setQ} placeholder="Search deliveries" className="lg:ml-auto lg:mb-2 lg:w-64" />
        </div>

        <div key={filter} className="view-enter">
        {list.isLoading ? (
          <PageSpinner />
        ) : list.error && !list.data ? (
          <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the deliveries" description={(list.error as Error).message} />
        ) : !shown.length ? (
          <EmptyState
            icon={<PackageCheck size={20} />}
            title={needle ? "Nothing matches" : filter !== "all" ? "Nothing here" : "No deliveries yet"}
            description={
              needle || filter !== "all"
                ? undefined
                : "Make a delivery, upload the work and send the client a link. Their comments and approval come back here."
            }
            action={
              !needle && filter === "all" ? (
                <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
                  New delivery
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {shown.map((f, i) => (
              <DeliveryRowItem key={f.id} i={i} f={f} />
            ))}
          </ul>
        )}
        </div>
      </div>

      {creating && <NewDeliveryModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function DeliveryRowItem({ f, i }: { f: DeliveryRow; i: number }) {
  // Client comments waiting on the team after they sent their feedback.
  const waiting = f.open_comments > 0 && f.state === "submitted";
  return (
    <li style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise">
      <Link
        to={`/deliveries/${f.id}`}
        className="group -mx-3 px-3 py-3 flex flex-col gap-2 rounded-md hover:bg-inset sm:flex-row sm:items-center sm:gap-4 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-semibold text-ink break-words group-hover:text-accent transition-colors">{f.title}</span>
            <StateBadge state={f.state} />
          </div>
          <div className="mt-0.5 text-sm text-muted truncate">
            {[f.project ?? "No project", f.client, `Round ${f.round}`].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted sm:justify-end shrink-0">
          <span className="inline-flex items-center gap-1.5 tabular-nums" title="Files">
            <Files size={14} /> {f.items}
          </span>
          <span className={cn("inline-flex items-center gap-1.5 tabular-nums", !f.links && "text-subtle")} title="Live links">
            <Link2 size={14} /> {f.links}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 tabular-nums",
              waiting ? "rounded-full bg-warn/10 px-2 py-0.5 font-medium text-warn" : !f.open_comments && "text-subtle",
            )}
            title="Open client comments"
          >
            <MessageSquare size={14} /> {f.open_comments}
          </span>
          <span className="w-24 text-xs text-subtle sm:text-right">{relativeTime(f.last_activity)}</span>
        </div>
      </Link>
    </li>
  );
}
