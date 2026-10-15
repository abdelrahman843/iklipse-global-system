import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, AudioLines, ExternalLink, Play, RefreshCw, Share2, Users, Video } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { MeetingView } from "@/components/meetings/MeetingView";
import { ShareMeetingModal } from "@/components/meetings/ShareMeetingModal";
import {
  fetchMeeting,
  fetchMeetingsOverview,
  fetchMeetingsSharedWithMe,
  loadTranscript,
  meetingMedia,
  minutes,
  syncFireflies,
  unshareMeeting,
  type MeetingRow,
} from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// Meetings: every meeting my Fireflies accounts were in (newest first), and
// the ones people shared with me. The list on the left, the meeting on the
// right (on a phone, one then the other). ?m=<id> opens a meeting,
// ?tab=shared the shared ones (notifications link there).
// -----------------------------------------------------------------------------

type Tab = "mine" | "shared";
const PAGE = 150;

export default function MeetingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const open = params.get("m");
  const [q, setQ] = useState("");
  const [account, setAccount] = useState("");
  const [shown, setShown] = useState(PAGE);

  const mine = useQuery({ queryKey: ["meetings"], queryFn: fetchMeetingsOverview, refetchInterval: 60_000 });
  const shared = useQuery({ queryKey: ["meetings-shared"], queryFn: fetchMeetingsSharedWithMe, refetchInterval: 60_000 });
  const accounts = mine.data?.accounts ?? [];
  const tab: Tab = params.get("tab") === "shared" || (!accounts.length && mine.isSuccess && (shared.data?.length ?? 0) > 0) ? "shared" : "mine";
  const go = (next: { tab?: Tab; m?: string | null }) => {
    const t = next.tab ?? tab;
    const m = next.m === undefined ? open : next.m;
    const out: Record<string, string> = {};
    if (t === "shared") out.tab = "shared";
    if (m) out.m = m;
    setParams(out, { replace: !next.m });
  };

  const sync = useMutation({
    mutationFn: () => syncFireflies(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      void qc.invalidateQueries({ queryKey: ["connections"] });
      if (r.errors.length) toast.push({ kind: "error", title: "Some accounts didn't sync", description: r.errors.join(" ") });
      else toast.push({ kind: "success", title: "Up to date" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't sync", description: e.message }),
  });

  const rows = tab === "shared" ? shared.data ?? [] : mine.data?.meetings ?? [];
  const needle = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter(
        (m) =>
          (tab === "shared" || !account || m.account_id === account) &&
          (!needle ||
            [m.title, m.short_summary, m.organizer_email, m.owner_name, ...m.participants, ...m.speakers]
              .filter(Boolean)
              .some((x) => x!.toLowerCase().includes(needle))),
      ),
    [rows, tab, account, needle],
  );

  const loading = tab === "shared" ? shared.isLoading : mine.isLoading;
  const error = tab === "shared" ? shared.error : mine.error;
  const problem = accounts.find((a) => a.last_error);
  const backfilling = accounts.some((a) => a.syncing);

  const tabs: LineTab<Tab>[] = [
    { value: "mine", label: "My meetings", count: mine.data?.meetings.length },
    { value: "shared", label: "Shared with me", count: shared.data?.length },
  ];

  const list = (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 px-3 sm:px-4 pt-4 pb-3 space-y-3 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="eyebrow text-subtle mb-1">Workspace</div>
            <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Meetings</h1>
          </div>
          {accounts.length > 0 && (
            <Button size="sm" variant="ghost" iconLeft={<RefreshCw size={14} />} loading={sync.isPending} onClick={() => sync.mutate()}>
              Sync
            </Button>
          )}
        </div>
        <LineTabs value={tab} tabs={tabs} onChange={(t) => go({ tab: t, m: null })} label="Meetings" />
        <div className="flex gap-2">
          <SearchField value={q} onChange={setQ} placeholder="Search meetings" className="flex-1" />
          {tab === "mine" && accounts.length > 1 && (
            <Select
              value={account}
              onChange={setAccount}
              size="md"
              className="w-36"
              aria-label="Account"
              options={[{ value: "", label: "All accounts" }, ...accounts.map((a) => ({ value: a.id, label: a.email ?? a.name ?? "Fireflies" }))]}
            />
          )}
        </div>
        {tab === "mine" && problem && (
          <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2 text-xs text-ink">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
            <span className="min-w-0 break-words">
              {problem.email}: {problem.last_error}{" "}
              <Link to="/connections" className="font-medium text-accent hover:underline">
                Connected accounts
              </Link>
            </span>
          </div>
        )}
        {tab === "mine" && backfilling && !problem && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={12} /> Bringing in older meetings, a few hundred every 15 minutes.
          </div>
        )}
      </div>
      <div key={`${tab}:${account}`} className="view-enter flex-1 min-h-0 overflow-auto">
        {loading ? (
          <PageSpinner />
        ) : error && !rows.length ? (
          <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the meetings" description={(error as Error).message} />
        ) : tab === "mine" && !accounts.length ? (
          <EmptyState
            icon={<AudioLines size={20} />}
            title="Connect Fireflies"
            description="Add your Fireflies account in Connected accounts to see every meeting you were in, with its summary and transcript."
            action={
              <Link to="/connections">
                <Button variant="primary">Connected accounts</Button>
              </Link>
            }
          />
        ) : !filtered.length ? (
          <EmptyState
            icon={<AudioLines size={20} />}
            title={needle ? "Nothing matches" : tab === "shared" ? "Nothing shared with you yet" : "No meetings yet"}
            description={needle ? undefined : tab === "shared" ? "Meetings people share with you show up here." : "They show up after Fireflies records them."}
          />
        ) : (
          <MeetingList rows={filtered.slice(0, shown)} open={open} onOpen={(id) => go({ m: id })} shared={tab === "shared"} more={filtered.length > shown ? () => setShown((n) => n + PAGE) : null} />
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full flex min-h-0">
      <div className={cn("w-full lg:w-[24rem] lg:shrink-0 lg:border-r border-border bg-surface min-h-0", open && "hidden lg:block")}>{list}</div>
      <div className={cn("flex-1 min-w-0 min-h-0 overflow-auto", !open && "hidden lg:block")}>
        {open ? (
          <MeetingPane id={open} onBack={() => go({ m: null })} onGone={() => go({ m: null })} />
        ) : (
          <div className="h-full grid place-items-center text-sm text-muted">Pick a meeting</div>
        )}
      </div>
    </div>
  );
}

function dayLabel(iso: string | null) {
  if (!iso) return "No date";
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function MeetingList({
  rows,
  open,
  onOpen,
  shared,
  more,
}: {
  rows: MeetingRow[];
  open: string | null;
  onOpen: (id: string) => void;
  shared: boolean;
  more: (() => void) | null;
}) {
  const groups: { label: string; items: MeetingRow[] }[] = [];
  for (const m of rows) {
    const label = dayLabel(m.started_at);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(m);
  }
  let n = 0;
  return (
    <div className="pb-4">
      {groups.map((g) => (
        <section key={g.label + g.items[0].id}>
          <h2 className="sticky top-0 z-[1] bg-surface/95 backdrop-blur px-3 sm:px-4 pt-4 pb-1.5 text-sm font-semibold text-ink border-b border-rule">
            {g.label}
          </h2>
          <ul className="divide-y divide-line">
            {g.items.map((m) => (
              <li key={m.id} style={{ "--i": Math.min(n++, 12) } as React.CSSProperties} className="rise">
                <button
                  type="button"
                  onClick={() => onOpen(m.id)}
                  className={cn(
                    "w-full text-left px-3 sm:px-4 py-3 transition-colors",
                    open === m.id ? "bg-accent-soft" : "hover:bg-inset/60",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-base font-medium text-ink line-clamp-2 break-words">{m.title ?? "Untitled meeting"}</span>
                    <span className="shrink-0 text-xs text-subtle tabular-nums">
                      {m.started_at ? new Date(m.started_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : ""}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted min-w-0">
                    {m.duration ? <span className="shrink-0">{minutes(m.duration)}</span> : null}
                    {shared && m.owner_name ? (
                      <span className="inline-flex items-center gap-1 truncate">
                        <Avatar src={m.owner_avatar ?? null} name={m.owner_name} size={14} /> {m.owner_name}
                      </span>
                    ) : (
                      m.speakers.length > 0 && <span className="truncate">{m.speakers.slice(0, 3).join(", ")}</span>
                    )}
                    {!shared && m.shares > 0 && (
                      <span className="ml-auto inline-flex items-center gap-0.5 shrink-0 text-subtle" title="Shared">
                        <Share2 size={11} /> {m.shares}
                      </span>
                    )}
                  </div>
                  {m.short_summary && <p className="mt-1 text-xs text-subtle line-clamp-2">{m.short_summary}</p>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {more && (
        <div className="p-3 text-center">
          <Button size="sm" variant="ghost" onClick={more}>
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}

function MeetingPane({ id, onBack, onGone }: { id: string; onBack: () => void; onGone: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["meeting", id], queryFn: () => fetchMeeting(id) });
  const m = q.data;
  const [sharing, setSharing] = useState(false);
  const [media, setMedia] = useState<{ audio_url: string | null; video_url: string | null } | null>(null);

  const transcript = useMutation({
    mutationFn: () => loadTranscript(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["meeting", id] }),
  });
  const play = useMutation({
    mutationFn: () => meetingMedia(id),
    onSuccess: (r) => {
      if (!r.audio_url && !r.video_url) toast.push({ kind: "error", title: "No recording", description: "Fireflies keeps recordings on paid plans only." });
      setMedia(r);
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't get the recording", description: e.message }),
  });
  const leave = useMutation({
    mutationFn: () => unshareMeeting(id, profile!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["meetings-shared"] });
      onGone();
    },
  });

  if (q.isLoading) return <PageSpinner />;
  if (!m) {
    return (
      <div className="p-6">
        <EmptyState icon={<AlertTriangle size={20} />} title="Meeting not found" description="It was deleted, the account was disconnected, or it's no longer shared with you." />
      </div>
    );
  }

  const sentences = m.sentences ?? (transcript.data ? transcript.data : null);
  return (
    <div key={id} className="view-enter px-3 sm:px-4 md:px-6 py-4">
      <button type="button" onClick={onBack} className="lg:hidden mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft size={16} /> Meetings
      </button>
      <MeetingView
        m={{
          title: m.title,
          started_at: m.started_at,
          duration: m.duration,
          organizer: m.organizer_email,
          speakers: m.speakers,
          attendees: m.attendees.map((a) => a.name ?? a.email ?? "").filter(Boolean),
          summary: m.summary,
        }}
        sentences={sentences}
        transcriptLoading={transcript.isPending}
        transcriptError={transcript.error ? (transcript.error as Error).message : null}
        onTranscript={() => transcript.mutate()}
        actions={
          <>
            <Button size="sm" iconLeft={<Play size={14} />} loading={play.isPending} onClick={() => play.mutate()}>
              Recording
            </Button>
            {m.transcript_url && (
              <a href={m.transcript_url} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="ghost" iconLeft={<ExternalLink size={14} />}>
                  Fireflies
                </Button>
              </a>
            )}
            {m.access === "owner" ? (
              <Button size="sm" variant="primary" iconLeft={<Share2 size={14} />} onClick={() => setSharing(true)}>
                Share{m.shares ? ` (${m.shares})` : ""}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (await confirm({ title: "Remove it from your list?", message: `${m.owner_name} can share it again.`, confirmLabel: "Remove" })) leave.mutate();
                }}
              >
                Remove
              </Button>
            )}
          </>
        }
        below={
          <>
            {m.access === "shared" && (
              <div className="text-xs text-muted inline-flex items-center gap-1.5">
                <Users size={13} /> Shared with you by {m.owner_name}
              </div>
            )}
            {m.access === "owner" && m.account_email && <div className="text-xs text-subtle">From {m.account_email}</div>}
            {media && (media.video_url || media.audio_url) && (
              <div className="rounded-xl border border-border bg-black/90 overflow-hidden">
                {media.video_url ? (
                  <video src={media.video_url} controls autoPlay className="w-full max-h-[60vh]" />
                ) : (
                  <div className="p-3 flex items-center gap-3">
                    <Video size={16} className="text-white/60" />
                    <audio src={media.audio_url!} controls autoPlay className="w-full" />
                  </div>
                )}
              </div>
            )}
          </>
        }
      />
      {sharing && <ShareMeetingModal m={m} onClose={() => setSharing(false)} />}
    </div>
  );
}

/** The Shared page's Meetings tab: the meetings shared with me. */
export function SharedMeetingsView() {
  const shared = useQuery({ queryKey: ["meetings-shared"], queryFn: fetchMeetingsSharedWithMe, refetchInterval: 60_000 });
  if (shared.isLoading) return <PageSpinner />;
  const rows = shared.data ?? [];
  if (!rows.length) return <EmptyState icon={<AudioLines size={20} />} title="No meetings shared with you" description="Meetings people share with you from Fireflies show up here." />;
  return (
    <div className="h-full overflow-auto px-3 sm:px-4 md:px-6 py-4">
      <ul className="divide-y divide-line border-b border-line">
        {rows.map((m, i) => (
          <li key={m.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise">
            <Link to={`/meetings?tab=shared&m=${m.id}`} className="block py-3 px-1 -mx-1 rounded-md hover:bg-inset/60 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <span className="text-base font-medium text-ink break-words">{m.title ?? "Untitled meeting"}</span>
                <span className="shrink-0 text-xs text-subtle">{m.started_at ? dayLabel(m.started_at) : ""}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <Avatar src={m.owner_avatar ?? null} name={m.owner_name ?? "?"} size={14} /> Shared by {m.owner_name}
                {m.duration ? <span>· {minutes(m.duration)}</span> : null}
              </div>
              {m.short_summary && <p className="mt-1 text-xs text-subtle line-clamp-2">{m.short_summary}</p>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
