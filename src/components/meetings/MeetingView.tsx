import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, Clock, ListChecks, Search, Sparkles, Tag, Users } from "lucide-react";
import { PillTabs } from "@/components/ui/PillTabs";
import { Spinner } from "@/components/ui/Spinner";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/cn";
import { bullets, clock, meetingWhen, minutes, type MeetingSummary, type Sentence } from "@/lib/firefliesApi";

// -----------------------------------------------------------------------------
// A Fireflies meeting: when, who, the AI summary (overview, action items,
// keywords, notes) and the transcript with a search. Used on the Meetings
// page and on the page an email link opens (no sign-in).
// -----------------------------------------------------------------------------

export interface MeetingViewData {
  title: string | null;
  started_at: string | null;
  duration: number | null;
  organizer?: string | null;
  speakers: string[];
  attendees: string[];
  summary: MeetingSummary | null;
}

const SPEAKER_TONES = ["text-accent", "text-success", "text-warn", "text-danger", "text-ink"];

export function MeetingView({
  m,
  sentences,
  transcriptLoading,
  transcriptError,
  onTranscript,
  actions,
  below,
}: {
  m: MeetingViewData;
  sentences: Sentence[] | null;
  transcriptLoading?: boolean;
  transcriptError?: string | null;
  /** Asked for when the Transcript tab opens and there's none yet. */
  onTranscript?: () => void;
  actions?: ReactNode;
  /** Under the header (the recording player, who it's shared with…). */
  below?: ReactNode;
}) {
  const [tab, setTab] = useState<"summary" | "transcript">("summary");
  const people = m.attendees.length ? m.attendees : m.speakers;
  return (
    <div className="flex flex-col gap-4 min-w-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold text-ink tracking-tight break-words">{m.title ?? "Untitled meeting"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            {m.started_at && (
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays size={14} /> {meetingWhen(m.started_at)}
              </span>
            )}
            {m.duration ? (
              <span className="inline-flex items-center gap-1.5">
                <Clock size={14} /> {minutes(m.duration)}
              </span>
            ) : null}
            {m.organizer && <span className="truncate">Organized by {m.organizer}</span>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
      </div>

      {people.length > 0 && (
        <div className="flex items-start gap-2 text-sm">
          <Users size={14} className="mt-1 shrink-0 text-muted" />
          <div className="flex flex-wrap gap-1.5 min-w-0">
            {people.slice(0, 20).map((p) => (
              <span key={p} className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-ink break-all">
                {p}
              </span>
            ))}
            {people.length > 20 && <span className="text-xs text-muted self-center">+{people.length - 20} more</span>}
          </div>
        </div>
      )}

      {below}

      <PillTabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          if (t === "transcript" && !sentences && !transcriptLoading) onTranscript?.();
        }}
        label="Meeting"
        className="self-start"
        tabs={[
          { value: "summary", label: "Summary" },
          { value: "transcript", label: "Transcript", count: sentences?.length },
        ]}
      />

      {tab === "summary" ? (
        <SummaryView s={m.summary} />
      ) : (
        <Transcript sentences={sentences} loading={transcriptLoading} error={transcriptError} onRetry={onTranscript} />
      )}
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <span className="text-muted">{icon}</span>
          {title}
        </span>
      }
    >
      <div className="pt-2">{children}</div>
    </Section>
  );
}

/** Fireflies' notes: "**Heading**" lines become headings, the rest bullets. */
function Lines({ text }: { text: string | null | undefined }) {
  const lines = (text ?? "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-1.5">
      {lines.map((l, i) => {
        const head = l.match(/^\*\*(.+?)\*\*:?$/);
        if (head) return <div key={i} className="pt-2 text-base font-semibold text-ink">{head[1]}</div>;
        const clean = bullets(l)[0] ?? l;
        return (
          <div key={i} className="flex gap-2 text-base text-ink leading-relaxed">
            <span className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" aria-hidden />
            <span className="min-w-0 break-words">{clean.replace(/\*\*(.+?)\*\*/g, "$1")}</span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryView({ s }: { s: MeetingSummary | null }) {
  const overview = s?.overview || s?.short_summary;
  const notes = s?.shorthand_bullet || s?.bullet_gist || s?.outline;
  if (!s || (!overview && !s.action_items && !notes)) {
    return (
      <div className="py-8 text-center text-sm text-muted">
        No summary yet. Fireflies writes it a few minutes after the meeting ends.
      </div>
    );
  }
  return (
    <div className="grid gap-8 xl:grid-cols-2 items-start">
      <div className="space-y-8 min-w-0">
        {overview && (
          <Card icon={<Sparkles size={14} />} title="Overview">
            <p className="text-base text-ink leading-relaxed whitespace-pre-wrap break-words">{overview}</p>
          </Card>
        )}
        {s.action_items && (
          <Card icon={<ListChecks size={14} />} title="Action items">
            <Lines text={s.action_items} />
          </Card>
        )}
        {(s.keywords.length > 0 || s.topics.length > 0) && (
          <Card icon={<Tag size={14} />} title="Keywords">
            <div className="flex flex-wrap gap-1.5">
              {[...new Set([...s.topics, ...s.keywords])].map((k) => (
                <span key={k} className="rounded-full bg-inset px-2 py-0.5 text-xs text-ink">
                  {k}
                </span>
              ))}
            </div>
          </Card>
        )}
      </div>
      {notes && (
        <div className="min-w-0">
          <Card icon={<ListChecks size={14} />} title="Notes">
            <Lines text={notes} />
          </Card>
        </div>
      )}
    </div>
  );
}

function Transcript({
  sentences,
  loading,
  error,
  onRetry,
}: {
  sentences: Sentence[] | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [q, setQ] = useState("");
  const tones = useMemo(() => {
    const map = new Map<string, string>();
    for (const x of sentences ?? []) if (!map.has(x.s)) map.set(x.s, SPEAKER_TONES[map.size % SPEAKER_TONES.length]);
    return map;
  }, [sentences]);
  if (loading) {
    return (
      <div className="py-8 flex items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Getting the transcript from Fireflies…
      </div>
    );
  }
  if (!sentences) {
    return (
      <div className="py-8 text-center text-sm text-muted">
        {error ? `Couldn't get the transcript: ${error}` : "No transcript yet."}
        {onRetry && (
          <button type="button" onClick={onRetry} className="ml-2 font-medium text-accent hover:underline">
            Try again
          </button>
        )}
      </div>
    );
  }
  if (!sentences.length) {
    return <div className="py-8 text-center text-sm text-muted">The transcript is empty or still processing.</div>;
  }
  const needle = q.trim().toLowerCase();
  const shown = needle ? sentences.filter((x) => x.t.toLowerCase().includes(needle) || x.s.toLowerCase().includes(needle)) : sentences;
  return (
    <div>
      <div className="pb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the transcript"
            aria-label="Search the transcript"
            className="h-11 sm:h-9 w-full rounded-md border border-border bg-surface pl-8 pr-3 text-lg sm:text-base text-ink placeholder:text-subtle focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          />
        </div>
        {needle && <span className="text-xs text-muted shrink-0">{shown.length} found</span>}
      </div>
      <ol className="border-t border-rule pt-4 pb-4 space-y-3">
        {shown.map((x) => (
          <li key={x.i} className="flex gap-3">
            <span className="w-12 shrink-0 pt-0.5 text-right text-xs tabular-nums text-subtle">{clock(x.a)}</span>
            <div className="min-w-0">
              <div className={cn("text-xs font-semibold", tones.get(x.s))}>{x.s}</div>
              <p className="text-sm text-ink leading-relaxed break-words">{needle ? mark(x.t, needle) : x.t}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function mark(text: string, needle: string): ReactNode {
  const out: ReactNode[] = [];
  const low = text.toLowerCase();
  let at = 0;
  for (let i = low.indexOf(needle); i !== -1; i = low.indexOf(needle, at)) {
    out.push(text.slice(at, i));
    out.push(
      <mark key={i} className="rounded bg-warn/30 text-ink px-0.5">
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    at = i + needle.length;
  }
  out.push(text.slice(at));
  return out;
}
