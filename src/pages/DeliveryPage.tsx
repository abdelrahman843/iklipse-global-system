import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Building2, CheckCircle2, Clock, FolderInput, MessageSquare, MoreHorizontal, NotebookPen, Pencil, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BackButton } from "@/components/ui/BackButton";
import { PillTabs, type PillTab } from "@/components/ui/PillTabs";
import { Menu, MenuDivider, MenuItem } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { Heading, StateBadge, day, useRefreshDeliveries } from "@/components/deliveries/parts";
import { MoveDeliveryModal, NoteModal } from "@/components/deliveries/DeliveryModals";
import { FilesTab } from "@/components/deliveries/FilesTab";
import { FeedbackHistory } from "@/components/deliveries/FeedbackHistory";
import { LinksTab } from "@/components/deliveries/LinksTab";
import { deleteDelivery, getDelivery, linkLive, nextRound, updateDelivery, type Delivery } from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// One delivery: its files (what the client sees), the feedback rounds and, for
// managers, the links it goes out on. Everyone on its project can open it
// read-only. ?tab=feedback|links.
// -----------------------------------------------------------------------------

type Tab = "files" | "feedback" | "links";

export default function DeliveryPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const refresh = useRefreshDeliveries();
  const { canDeliver } = useAuth();
  const [params, setParams] = useSearchParams();
  const asked = params.get("tab") as Tab | null;

  const q = useQuery({ queryKey: ["delivery", id], queryFn: () => getDelivery(id), enabled: !!id, refetchInterval: 30_000 });
  const d = q.data;
  const manage = !!d?.manage;
  const tab: Tab = asked === "feedback" || (asked === "links" && manage) ? asked : "files";
  const setTab = (t: Tab) => setParams(t === "files" ? {} : { tab: t }, { replace: true });

  const [moving, setMoving] = useState(false);
  const [noting, setNoting] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const round = useMutation({
    mutationFn: (clear: boolean) => nextRound(id, clear),
    onSuccess: (n, clear) => {
      refresh();
      toast.push({ kind: "success", title: clear ? `Round ${n} is open` : "The round is open again", description: "The client can comment on the same link." });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change the round", description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteDelivery(id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["delivery", id] });
      void qc.invalidateQueries({ queryKey: ["deliveries"] });
      nav("/deliveries", { replace: true });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't delete the delivery", description: e.message }),
  });

  const counts = useMemo(() => {
    if (!d) return { files: 0, feedback: 0, links: 0 };
    return {
      files: d.items.filter((i) => !i.removed_at).length,
      feedback: d.comments.filter((c) => c.round === d.round && c.guest && !c.resolved_at).length,
      links: d.links.filter((l) => linkLive(l)).length,
    };
  }, [d]);

  if (q.isLoading) return <PageSpinner />;
  if (!d) {
    return (
      <div className="h-full grid place-items-center">
        <EmptyState
          icon={<AlertTriangle size={20} />}
          title="Delivery not found"
          description={(q.error as Error | null)?.message === "Delivery not found" ? "It was deleted, or you're not on its project." : (q.error as Error | null)?.message}
          action={<Button onClick={() => nav(canDeliver ? "/deliveries" : "/")}>{canDeliver ? "All deliveries" : "Home"}</Button>}
        />
      </div>
    );
  }

  const askNext = async () => {
    const ok = await confirm({
      title: `Start round ${d.round + 1}?`,
      message: `The client's comments from round ${d.round} move to the history, and the link opens clean for round ${d.round + 1}. Same links, nothing to resend.`,
      confirmLabel: `Start round ${d.round + 1}`,
    });
    if (ok) round.mutate(true);
  };
  const askReopen = async () => {
    const ok = await confirm({
      title: "Reopen this round?",
      message: `Round ${d.round} opens for more comments on the same link. What the client already sent stays in the feedback history.`,
      confirmLabel: "Reopen",
    });
    if (ok) round.mutate(false);
  };

  const tabs: PillTab<Tab>[] = [
    { value: "files", label: "Files", count: counts.files },
    { value: "feedback", label: "Feedback", count: counts.feedback },
    ...(manage ? [{ value: "links" as const, label: "Links", count: counts.links }] : []),
  ];

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="shrink-0 px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 pb-4 border-b border-border bg-surface flex flex-col gap-3">
        <BackButton fallback={canDeliver ? "/deliveries" : d.project_id ? `/projects/${d.project_id}?tab=deliveries` : "/"} label="Back" className="self-start" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <TitleEditor d={d} onDone={() => setRenaming(false)} />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {manage ? (
                  <button
                    type="button"
                    onClick={() => setRenaming(true)}
                    className="group text-left text-xl sm:text-2xl font-semibold text-ink tracking-tight break-words rounded-md -mx-1 px-1 hover:bg-inset"
                    title="Rename"
                  >
                    {d.title}
                    <Pencil size={14} className="inline ml-2 -mt-1 text-subtle opacity-0 group-hover:opacity-100" />
                  </button>
                ) : (
                  <h1 className="text-xl sm:text-2xl font-semibold text-ink tracking-tight break-words">{d.title}</h1>
                )}
                <StateBadge state={d.state} />
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              <span className="inline-flex items-center gap-1.5 min-w-0">
                <Building2 size={14} className="shrink-0" />
                {d.project_id ? (
                  <Link to={`/projects/${d.project_id}`} className="truncate text-ink hover:text-accent">
                    {d.project}
                  </Link>
                ) : (
                  "No project"
                )}
                {d.client && <span className="truncate">· {d.client}</span>}
              </span>
              <span className="font-medium text-ink">Round {d.round}</span>
            </div>
          </div>
          {manage && (
            <Menu
              align="right"
              trigger={
                <button type="button" aria-label="More" className="h-8 w-8 shrink-0 grid place-items-center rounded-md border border-border text-muted hover:text-ink hover:bg-inset">
                  <MoreHorizontal size={16} />
                </button>
              }
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => (close(), setRenaming(true))}>
                    <span className="inline-flex items-center gap-2">
                      <Pencil size={14} /> Rename
                    </span>
                  </MenuItem>
                  <MenuItem onClick={() => (close(), setMoving(true))}>
                    <span className="inline-flex items-center gap-2">
                      <FolderInput size={14} /> Move to a project
                    </span>
                  </MenuItem>
                  <MenuItem onClick={() => (close(), setNoting(true))}>
                    <span className="inline-flex items-center gap-2">
                      <NotebookPen size={14} /> {d.note ? "Edit the note" : "Add a note"}
                    </span>
                  </MenuItem>
                  {d.state === "open" && (
                    <MenuItem onClick={() => (close(), void askNext())}>
                      <span className="inline-flex items-center gap-2">
                        <RefreshCw size={14} /> Start next round
                      </span>
                    </MenuItem>
                  )}
                  <MenuDivider />
                  <MenuItem
                    destructive
                    onClick={async () => {
                      close();
                      const ok = await confirm({
                        title: `Delete ${d.title}?`,
                        message: "Its files, links and every round of feedback go too. The client's links stop working. This can't be undone.",
                        confirmLabel: "Delete",
                        danger: true,
                      });
                      if (ok) remove.mutate();
                    }}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Trash2 size={14} /> Delete delivery
                    </span>
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
        {d.note && <p className="text-base text-ink/80 whitespace-pre-wrap break-words max-w-prose">{d.note}</p>}
        <RoundCallout d={d} manage={manage} busy={round.isPending} onNext={askNext} onReopen={askReopen} onFeedback={() => setTab("feedback")} />
        <PillTabs value={tab} tabs={tabs} onChange={setTab} label="Delivery" className="self-start" />
      </header>

      <div className="flex-1 min-h-0 overflow-auto px-3 sm:px-4 md:px-6 py-5">
        {tab === "files" ? (
          <FilesTab delivery={d} onChanged={refresh} />
        ) : tab === "feedback" ? (
          <div className="max-w-4xl">
            <Heading title="Feedback rounds" count={d.rounds.length > 1 ? d.rounds.length : undefined} />
            <FeedbackHistory key={d.round} delivery={d} onChanged={refresh} />
          </div>
        ) : (
          <LinksTab delivery={d} onChanged={refresh} />
        )}
      </div>

      {moving && <MoveDeliveryModal delivery={d} onClose={() => setMoving(false)} />}
      {noting && <NoteModal delivery={d} onClose={() => setNoting(false)} />}
    </div>
  );
}

/** Where the round is: waiting for the client, or their feedback is in and what to do next. */
function RoundCallout({
  d,
  manage,
  busy,
  onNext,
  onReopen,
  onFeedback,
}: {
  d: Delivery;
  manage: boolean;
  busy: boolean;
  onNext: () => void;
  onReopen: () => void;
  onFeedback: () => void;
}) {
  const r = d.rounds.find((x) => x.number === d.round);
  const comments = d.comments.filter((c) => c.round === d.round && c.guest).length;
  const live = d.links.filter((l) => linkLive(l)).length;

  if (d.state === "open") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span className="inline-flex items-center gap-1.5 font-medium text-ink">
          <Clock size={14} className="text-accent" /> Waiting for the client
        </span>
        <span>
          {comments ? `${comments} ${comments === 1 ? "comment" : "comments"} so far, not sent yet` : manage && !live ? "Make a link in Links and send it to them." : "No comments yet."}
        </span>
      </div>
    );
  }

  const approved = d.state === "approved";
  const who = r?.submitted_name || "The client";
  const when = r?.submitted_at ? day(r.submitted_at) : null;
  return (
    <div className={cn("rounded-lg px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between", approved ? "bg-success/10" : "bg-warn/10")}>
      <div className="min-w-0">
        <div className={cn("flex items-center gap-2 text-base font-semibold", approved ? "text-success" : "text-ink")}>
          {approved ? <CheckCircle2 size={16} /> : <MessageSquare size={16} className="text-warn" />}
          {approved
            ? `${who} approved it${when ? ` on ${when}` : ""}`
            : `${who} sent feedback${when ? ` on ${when}` : ""}: ${comments} ${comments === 1 ? "comment" : "comments"}`}
        </div>
        <div className="mt-0.5 text-sm text-muted">
          {approved
            ? "The link is read only now."
            : manage
              ? `Fix what they asked for, then start round ${d.round + 1}. The link stays read only until then.`
              : "The link is read only until the team starts the next round."}
          {!approved && (
            <>
              {" "}
              <button type="button" onClick={onFeedback} className="font-medium text-accent hover:underline">
                See the feedback
              </button>
            </>
          )}
        </div>
      </div>
      {manage && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button size="sm" iconLeft={<RotateCcw size={14} />} disabled={busy} onClick={onReopen}>
            Reopen this round
          </Button>
          <Button size="sm" variant="primary" iconLeft={<RefreshCw size={14} />} loading={busy} onClick={onNext}>
            Start round {d.round + 1}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The title, edited in place: Enter or leaving the field saves, Esc cancels. */
function TitleEditor({ d, onDone }: { d: Delivery; onDone: () => void }) {
  const toast = useToast();
  const refresh = useRefreshDeliveries();
  const [v, setV] = useState(d.title);
  // Esc closes the field, and the blur that follows must not save.
  const cancelled = useRef(false);
  const save = useMutation({
    mutationFn: () => updateDelivery(d.id, { title: v.trim() }),
    onSuccess: () => {
      refresh();
      onDone();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't rename it", description: e.message }),
  });
  useEffect(() => {
    if (save.isError) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.isError]);
  const commit = () => {
    if (cancelled.current) return;
    if (!v.trim() || v.trim() === d.title) onDone();
    else if (!save.isPending) save.mutate();
  };
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      autoFocus
      maxLength={120}
      aria-label="Title"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onDone();
        }
      }}
      className="block w-full min-w-0 rounded-md border border-accent bg-surface px-2 py-0.5 -mx-1 text-xl sm:text-2xl font-semibold text-ink tracking-tight outline-none"
    />
  );
}
