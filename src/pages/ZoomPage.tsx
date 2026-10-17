import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Copy, ExternalLink, List, MessageCircle, Pencil, Plus, RefreshCw, Repeat, Trash2, Video } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Label, Textarea, FieldError } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageTitle } from "@/components/ui/PageTitle";
import { PillTabs } from "@/components/ui/PillTabs";
import { Select } from "@/components/ui/Select";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { fetchConnections, type ZoomAccount } from "@/lib/connectionsApi";
import {
  createZoomMeeting,
  deleteZoomMeeting,
  fetchCalendar,
  fetchMeetingDetails,
  updateZoomMeeting,
  type CalMeeting,
  type MeetingInput,
} from "@/lib/zoomApi";

// -----------------------------------------------------------------------------
// Zoom: a calendar of my Zoom accounts, one at a time. The month on the left
// (past meetings faded, today marked, the WhatsApp bot's meetings in green),
// the picked day on the right with each meeting's link; a list of the month
// instead of the grid on request. New meetings by hand; the coming ones can be
// changed or cancelled. Weeks start on Saturday.
// -----------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** "25-12-2019" */
const dmy = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
/** "3:00 PM" */
const time12 = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
const weekday = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long" });
const monthLabel = (d: Date) => d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
const WEEK = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
/** Saturday is the first column. */
const column = (d: Date) => (d.getDay() + 1) % 7;

function lengthText(m: number | null) {
  if (!m) return null;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}` : `${m} min`;
}

type When = "past" | "now" | "soon";
const startOf = (m: CalMeeting) => new Date(m.start_time);
const endOf = (m: CalMeeting) => new Date(Date.parse(m.start_time) + (m.duration ?? 30) * 60_000);
function whenOf(m: CalMeeting, now: number): When {
  if (endOf(m).getTime() < now) return "past";
  return startOf(m).getTime() <= now ? "now" : "soon";
}

type View = "month" | "list";
const VIEW_KEY = "zoom-view";
const LENGTHS = [15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: String(m), label: lengthText(m)! }));

export default function ZoomPage() {
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const accounts = conns.data?.zoom ?? [];
  if (conns.isLoading) return <PageSpinner />;
  if (!accounts.length)
    return (
      <div className="p-6">
        <EmptyState
          icon={<Video size={20} />}
          title="Connect Zoom first"
          description="Your Zoom meetings show here as a calendar, past and coming, once your Zoom account is connected."
          action={
            <Link to="/connections?tab=zoom">
              <Button variant="primary" iconLeft={<Video size={14} />}>
                Connect Zoom
              </Button>
            </Link>
          }
        />
      </div>
    );
  return <Calendar accounts={accounts} />;
}

function Calendar({ accounts }: { accounts: ZoomAccount[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [picked, setPicked] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === picked) ?? accounts.find((a) => a.for_bot) ?? accounts[0]!;
  const today = keyOf(new Date());
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [day, setDay] = useState(today);
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "month";
    } catch {
      return "month";
    }
  });
  const [form, setForm] = useState<{ edit?: CalMeeting; day: string } | null>(null);
  const [open, setOpen] = useState<CalMeeting | null>(null);
  // The clock, so "now" and the faded past keep up while the page stays open.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Six weeks from the Saturday on or before the 1st.
  const first = addDays(month, -column(month));
  const last = addDays(first, 41);
  const q = useQuery({
    queryKey: ["zoom-cal", account.id, keyOf(first), keyOf(last)],
    queryFn: () => fetchCalendar(account.id, keyOf(first), keyOf(last)),
    staleTime: 60_000,
  });
  const byDay = useMemo(() => {
    const map = new Map<string, CalMeeting[]>();
    const sorted = [...(q.data ?? [])].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
    for (const m of sorted) {
      const k = keyOf(startOf(m));
      map.set(k, [...(map.get(k) ?? []), m]);
    }
    return map;
  }, [q.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["zoom-cal"] });
    void qc.invalidateQueries({ queryKey: ["zoom-meetings"] });
  };
  const remove = useMutation({
    mutationFn: (m: CalMeeting) => deleteZoomMeeting(account.id, m.id),
    onSuccess: (_d, m) => {
      refresh();
      setOpen(null);
      toast.push({ kind: "success", title: "Meeting cancelled", description: m.topic });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't cancel it", description: e.message }),
  });
  const askRemove = async (m: CalMeeting) => {
    const ok = await confirm({
      title: `Cancel "${m.topic}"?`,
      message: `It's deleted from Zoom (${dmy(startOf(m))}, ${time12(startOf(m))}). Anyone with the link can't join anymore.${m.whatsapp ? " The WhatsApp group isn't told." : ""}`,
      confirmLabel: "Cancel meeting",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (ok) remove.mutate(m);
  };

  const go = (n: number) => setMonth((d) => new Date(d.getFullYear(), d.getMonth() + n, 1));
  const goToday = () => {
    const d = new Date();
    setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
    setDay(today);
  };
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* fine */
    }
  };
  const pickDay = (k: string) => {
    setDay(k);
    const d = fromKey(k);
    if (d.getMonth() !== month.getMonth()) setMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  };

  const inMonth = (q.data ?? []).filter((m) => startOf(m).getMonth() === month.getMonth() && startOf(m).getFullYear() === month.getFullYear());
  const coming = inMonth.filter((m) => whenOf(m, now) !== "past").length;
  const dayMeetings = byDay.get(day) ?? [];

  return (
    <div className="p-3 sm:p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-0">
          <PageTitle count={inMonth.length ? `${inMonth.length} this month` : null}>Zoom</PageTitle>
          <p className="text-sm text-muted mt-1">
            {q.isLoading ? "Reading your Zoom…" : coming ? `${coming} coming up in ${month.toLocaleDateString("en-GB", { month: "long" })}.` : "Your meetings, past and coming."}
          </p>
        </div>
        <Button variant="primary" iconLeft={<Plus size={15} />} onClick={() => setForm({ day: day < today ? today : day })}>
          New meeting
        </Button>
      </div>

      {accounts.length > 1 && (
        <PillTabs
          scroll
          value={account.id}
          tabs={accounts.map((a) => ({ value: a.id, label: a.email ?? "Zoom account" }))}
          onChange={setPicked}
          label="Zoom accounts"
          className="mb-4"
        />
      )}

      {/* ------------------------------------------------------------ toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center rounded-lg border border-border bg-surface shadow-card">
          <button type="button" onClick={() => go(-1)} aria-label="Last month" className="h-10 w-10 sm:h-9 sm:w-9 grid place-items-center text-muted hover:text-ink">
            <ChevronLeft size={17} />
          </button>
          <button type="button" onClick={goToday} className="h-10 sm:h-9 px-3 text-sm font-semibold text-ink border-x border-border hover:bg-inset">
            Today
          </button>
          <button type="button" onClick={() => go(1)} aria-label="Next month" className="h-10 w-10 sm:h-9 sm:w-9 grid place-items-center text-muted hover:text-ink">
            <ChevronRight size={17} />
          </button>
        </div>
        <h2 className="text-lg font-bold text-ink tracking-tight mr-auto">{monthLabel(month)}</h2>
        {q.isFetching && !q.isLoading && <Spinner size={14} />}
        <Button variant="ghost" size="sm" iconLeft={<RefreshCw size={14} />} onClick={() => void q.refetch()} disabled={q.isFetching}>
          Refresh
        </Button>
        <PillTabs
          value={view}
          onChange={pickView}
          label="View"
          tabs={[
            { value: "month", label: "Month", icon: <CalendarDays size={14} /> },
            { value: "list", label: "List", icon: <List size={14} /> },
          ]}
        />
      </div>

      {q.error && (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{(q.error as Error).message}</div>
      )}

      {view === "month" ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
          {/* ------------------------------------------------------- the month */}
          <div className="rounded-2xl border border-border bg-surface shadow-card overflow-hidden">
            <div className="grid grid-cols-7 border-b border-line bg-inset/50">
              {WEEK.map((w, i) => (
                <div key={w} className={cn("py-2 text-center text-xs font-semibold uppercase tracking-wide", i === 6 || i === 0 ? "text-subtle" : "text-muted")}>
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: 42 }, (_, i) => {
                const d = addDays(first, i);
                const k = keyOf(d);
                const list = byDay.get(k) ?? [];
                const out = d.getMonth() !== month.getMonth();
                const isToday = k === today;
                const isPicked = k === day;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => pickDay(k)}
                    onDoubleClick={() => k >= today && setForm({ day: k })}
                    className={cn(
                      "relative min-h-[3.25rem] sm:min-h-[6.75rem] p-1 sm:p-1.5 text-left border-line transition-colors duration-100",
                      i % 7 !== 6 && "border-r",
                      i < 35 && "border-b",
                      out ? "bg-inset/40" : "bg-surface hover:bg-inset/50",
                      isPicked && "bg-accent-soft/40 hover:bg-accent-soft/50",
                    )}
                    aria-label={`${weekday(d)} ${dmy(d)}, ${list.length} meeting${list.length === 1 ? "" : "s"}`}
                    aria-pressed={isPicked}
                  >
                    <span
                      className={cn(
                        "inline-grid place-items-center h-6 min-w-6 px-1 rounded-full text-xs font-semibold tabular-nums",
                        isToday ? "bg-accent text-white" : out ? "text-subtle" : "text-ink",
                        isPicked && !isToday && "ring-2 ring-accent/50",
                      )}
                    >
                      {d.getDate()}
                    </span>
                    {/* Phones: a dot a meeting. */}
                    {list.length > 0 && (
                      <span className="sm:hidden mt-1 flex flex-wrap gap-0.5 px-0.5">
                        {list.slice(0, 4).map((m) => (
                          <span key={`${m.id}-${m.start_time}`} className={cn("h-1.5 w-1.5 rounded-full", dot(m, now))} />
                        ))}
                      </span>
                    )}
                    {/* Wider: the first few meetings. */}
                    <span className="hidden sm:block mt-1 space-y-0.5">
                      {list.slice(0, 3).map((m) => (
                        <span key={`${m.id}-${m.start_time}`} className={cn("flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-tight font-medium truncate", chip(m, now))}>
                          <span className="tabular-nums shrink-0 opacity-80">{time12(startOf(m)).replace(":00", "")}</span>
                          <span className="truncate">{m.topic}</span>
                        </span>
                      ))}
                      {list.length > 3 && <span className="block px-1.5 text-[11px] text-subtle font-medium">+{list.length - 3} more</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* --------------------------------------------------------- the day */}
          <aside className="lg:sticky lg:top-4 rounded-2xl border border-border bg-surface shadow-card p-4">
            <div className="flex items-start gap-2 mb-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-subtle">{day === today ? "Today" : weekday(fromKey(day))}</div>
                <div className="text-xl font-extrabold text-ink tracking-tight tabular-nums">{dmy(fromKey(day))}</div>
              </div>
              {day >= today && (
                <Button size="sm" iconLeft={<Plus size={14} />} onClick={() => setForm({ day })}>
                  Add
                </Button>
              )}
            </div>
            {q.isLoading ? (
              <div className="py-8 grid place-items-center">
                <Spinner />
              </div>
            ) : dayMeetings.length ? (
              <div className="space-y-2.5">
                {dayMeetings.map((m) => (
                  <MeetingCard key={`${m.id}-${m.start_time}`} m={m} now={now} onOpen={() => setOpen(m)} />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border py-8 px-4 text-center">
                <CalendarDays size={22} className="mx-auto text-subtle" />
                <p className="mt-2 text-sm text-muted">Nothing on this day.</p>
                {day >= today && (
                  <button type="button" onClick={() => setForm({ day })} className="mt-2 text-sm font-semibold text-accent hover:underline underline-offset-2">
                    Book a meeting
                  </button>
                )}
              </div>
            )}
          </aside>
        </div>
      ) : (
        /* ------------------------------------------------------------ the list */
        <div className="max-w-3xl">
          {q.isLoading ? (
            <div className="py-10 grid place-items-center">
              <Spinner />
            </div>
          ) : !inMonth.length ? (
            <EmptyState icon={<CalendarDays size={20} />} title={`Nothing in ${monthLabel(month)}`} description="Meetings on this Zoom account show here." />
          ) : (
            <div className="space-y-5">
              {[...new Set(inMonth.map((m) => keyOf(startOf(m))))].map((k) => (
                <div key={k}>
                  <div className={cn("mb-1.5 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide", k === today ? "text-accent" : "text-subtle")}>
                    {k === today ? "Today" : weekday(fromKey(k))} <span className="tabular-nums">{dmy(fromKey(k))}</span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {(byDay.get(k) ?? []).map((m) => (
                      <MeetingCard key={`${m.id}-${m.start_time}`} m={m} now={now} onOpen={() => setOpen(m)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-subtle">
        Times are in your time zone. Zoom keeps about six months of past meetings. Double-click a day to book on it.
      </p>

      {open && (
        <MeetingModal
          account={account.id}
          m={open}
          now={now}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setForm({ edit: open, day: keyOf(startOf(open)) });
            setOpen(null);
          }}
          onDelete={() => void askRemove(open)}
          deleting={remove.isPending}
        />
      )}
      {form && (
        <MeetingForm
          account={account.id}
          edit={form.edit}
          day={form.day}
          onClose={() => setForm(null)}
          onSaved={(d) => {
            refresh();
            setForm(null);
            pickDay(d);
          }}
        />
      )}
    </div>
  );
}

/** Coming: the accent; the WhatsApp bot's: green; past: faded. */
function chip(m: CalMeeting, now: number) {
  const w = whenOf(m, now);
  if (w === "past") return "bg-inset text-subtle";
  if (w === "now") return "bg-success/15 text-success";
  return m.whatsapp ? "bg-success/10 text-success" : "bg-accent-soft text-accent";
}
function dot(m: CalMeeting, now: number) {
  const w = whenOf(m, now);
  if (w === "past") return "bg-subtle/60";
  return m.whatsapp || w === "now" ? "bg-success" : "bg-accent";
}

async function copy(url: string, toast: ReturnType<typeof useToast>) {
  try {
    await navigator.clipboard.writeText(url);
    toast.push({ kind: "success", title: "Link copied" });
  } catch {
    toast.push({ kind: "error", title: "Couldn't copy", description: url });
  }
}

function MeetingCard({ m, now, onOpen }: { m: CalMeeting; now: number; onOpen: () => void }) {
  const toast = useToast();
  const w = whenOf(m, now);
  const s = startOf(m);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className={cn(
        "group relative rounded-xl border bg-surface p-3 pl-4 cursor-pointer transition-[box-shadow,border-color] duration-150 hover:shadow-pop",
        w === "now" ? "border-success/40" : "border-border hover:border-rule",
        w === "past" && "opacity-70",
      )}
    >
      <span className={cn("absolute left-0 top-3 bottom-3 w-1 rounded-r-full", w === "past" ? "bg-subtle/40" : m.whatsapp || w === "now" ? "bg-success" : "bg-accent")} />
      <div className="flex items-center gap-2 text-xs text-muted tabular-nums">
        <span className="font-semibold text-ink">{time12(s)}</span>
        <span>to {time12(endOf(m))}</span>
        {w === "now" && (
          <Badge tone="success" className="ml-auto">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" /> Now
          </Badge>
        )}
        {w === "past" && <span className="ml-auto text-subtle">Done</span>}
      </div>
      <div className="mt-1 text-sm font-semibold text-ink leading-snug line-clamp-2">{m.topic || "Zoom meeting"}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {lengthText(m.duration) && <span className="text-xs text-subtle">{lengthText(m.duration)}</span>}
        {m.recurring && (
          <span className="inline-flex items-center gap-1 text-xs text-subtle">
            <Repeat size={11} /> Repeats
          </span>
        )}
        {m.whatsapp && (
          <span className="inline-flex items-center gap-1 text-xs text-success min-w-0">
            <MessageCircle size={11} className="shrink-0" /> <span className="truncate">{m.whatsapp}</span>
          </span>
        )}
      </div>
      {m.join_url && w !== "past" && (
        <div className="mt-2.5 flex gap-2" onClick={(e) => e.stopPropagation()}>
          <a
            href={m.join_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 h-9 sm:h-8 px-3 rounded-md text-sm font-semibold bg-accent text-white hover:bg-accent-hover transition-colors"
          >
            <Video size={14} /> {w === "now" ? "Join now" : "Open"}
          </a>
          <Button size="sm" variant="ghost" iconLeft={<Copy size={14} />} onClick={() => void copy(m.join_url!, toast)}>
            Copy link
          </Button>
        </div>
      )}
    </div>
  );
}

function MeetingModal({
  account,
  m,
  now,
  onClose,
  onEdit,
  onDelete,
  deleting,
}: {
  account: string;
  m: CalMeeting;
  now: number;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const toast = useToast();
  const w = whenOf(m, now);
  const d = useQuery({ queryKey: ["zoom-meeting", account, m.id], queryFn: () => fetchMeetingDetails(account, m.id), enabled: w !== "past", retry: false });
  const s = startOf(m);
  const zid = m.id.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1 $2 $3");
  const link = d.data?.join_url ?? m.join_url;
  return (
    <Modal
      open
      onClose={onClose}
      title={m.topic || "Zoom meeting"}
      size="md"
      footer={
        w !== "past" ? (
          <div className="flex flex-wrap gap-2 w-full">
            <Button variant="ghost" iconLeft={<Trash2 size={14} />} className="!text-danger hover:!bg-danger/10 mr-auto" loading={deleting} onClick={onDelete}>
              Cancel meeting
            </Button>
            {!m.recurring && (
              <Button iconLeft={<Pencil size={14} />} onClick={onEdit}>
                Edit
              </Button>
            )}
            {link && (
              <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 h-11 sm:h-9 px-4 sm:px-3 rounded-md text-base sm:text-sm font-semibold bg-accent text-white hover:bg-accent-hover">
                <ExternalLink size={14} /> Open in Zoom
              </a>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {w === "now" && <Badge tone="success">Happening now</Badge>}
          {w === "past" && <Badge>Done</Badge>}
          {w === "soon" && <Badge tone="accent">Coming up</Badge>}
          {m.recurring && <Badge>Repeats</Badge>}
          {m.whatsapp && <Badge tone="success">Booked from WhatsApp: {m.whatsapp}</Badge>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Date</dt>
          <dd className="text-ink font-medium tabular-nums">
            {dmy(s)} ({weekday(s)})
          </dd>
          <dt className="text-muted">Time</dt>
          <dd className="text-ink font-medium tabular-nums">
            {time12(s)} to {time12(endOf(m))}
            {lengthText(m.duration) && <span className="text-muted font-normal"> · {lengthText(m.duration)}</span>}
          </dd>
          <dt className="text-muted">Meeting ID</dt>
          <dd className="text-ink tabular-nums">{zid}</dd>
          {d.data?.password && (
            <>
              <dt className="text-muted">Passcode</dt>
              <dd className="text-ink tabular-nums">{d.data.password}</dd>
            </>
          )}
        </dl>
        {link && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-inset/50 pl-3 pr-1 py-1">
            <span className="flex-1 min-w-0 truncate text-sm text-muted">{link}</span>
            <Button size="sm" variant="ghost" iconLeft={<Copy size={14} />} onClick={() => void copy(link, toast)}>
              Copy
            </Button>
          </div>
        )}
        {d.isLoading && <Spinner size={14} />}
        {d.data?.agenda && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-subtle mb-1">Details</div>
            <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{d.data.agenda}</p>
          </div>
        )}
        {m.recurring && w !== "past" && <p className="text-xs text-subtle">A repeating meeting: change its times in Zoom itself.</p>}
      </div>
    </Modal>
  );
}

/** The next half hour from now, "HH:MM". */
function nextHalfHour() {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MeetingForm({
  account,
  edit,
  day,
  onClose,
  onSaved,
}: {
  account: string;
  edit?: CalMeeting;
  day: string;
  onClose: () => void;
  onSaved: (day: string) => void;
}) {
  const toast = useToast();
  const details = useQuery({ queryKey: ["zoom-meeting", account, edit?.id], queryFn: () => fetchMeetingDetails(account, edit!.id), enabled: !!edit, retry: false });
  const [topic, setTopic] = useState(edit?.topic ?? "");
  const [date, setDate] = useState(day);
  const [time, setTime] = useState(edit ? `${pad(startOf(edit).getHours())}:${pad(startOf(edit).getMinutes())}` : day === keyOf(new Date()) ? nextHalfHour() : "10:00");
  const [minutes, setMinutes] = useState(String(edit?.duration ?? 30));
  const [agenda, setAgenda] = useState<string | null>(null);
  const shownAgenda = agenda ?? details.data?.agenda ?? "";
  const start = date && /^\d{2}:\d{2}$/.test(time) ? new Date(`${date}T${time}:00`) : null;
  const past = !!start && start.getTime() < Date.now() - 60_000;
  const bad = !topic.trim() ? "Give it a title." : !start || isNaN(start.getTime()) ? "Pick the day and the time." : past ? "That time has passed." : null;

  const save = useMutation({
    mutationFn: async () => {
      const m: MeetingInput = { topic: topic.trim(), start: start!.toISOString(), minutes: Number(minutes), agenda: shownAgenda.trim() };
      if (edit) await updateZoomMeeting(account, edit.id, m);
      else await createZoomMeeting(account, m);
    },
    onSuccess: () => {
      toast.push({ kind: "success", title: edit ? "Meeting updated" : "Meeting booked", description: `${dmy(start!)}, ${time12(start!)}` });
      onSaved(date);
    },
    onError: (e: Error) => toast.push({ kind: "error", title: edit ? "Couldn't update it" : "Couldn't book it", description: e.message }),
  });
  const lengths = LENGTHS.some((l) => l.value === minutes) ? LENGTHS : [...LENGTHS, { value: minutes, label: lengthText(Number(minutes)) ?? `${minutes} min` }];

  return (
    <Modal
      open
      onClose={onClose}
      title={edit ? "Edit meeting" : "New Zoom meeting"}
      size="md"
      footer={
        <div className="flex gap-2 justify-end w-full">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!!bad} onClick={() => save.mutate()}>
            {edit ? "Save" : "Book it"}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad) save.mutate();
        }}
      >
        <div>
          <Label htmlFor="zm-topic">Title</Label>
          <Input id="zm-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Call with the client" autoFocus maxLength={200} />
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_8rem_9rem]">
          <div>
            <Label>Day</Label>
            <DateField value={date} onChange={setDate} min={keyOf(new Date())} clearable={false} aria-label="Day" />
          </div>
          <div>
            <Label htmlFor="zm-time">Time</Label>
            <Input id="zm-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} step={300} />
          </div>
          <div>
            <Label>Length</Label>
            <Select value={minutes} onChange={setMinutes} options={lengths} aria-label="Length" />
          </div>
        </div>
        <div>
          <Label htmlFor="zm-agenda">Details</Label>
          <Textarea
            id="zm-agenda"
            rows={4}
            value={shownAgenda}
            onChange={(e) => setAgenda(e.target.value)}
            placeholder="What it's about, who's in it, links…"
            maxLength={2000}
            disabled={!!edit && details.isLoading}
          />
        </div>
        <FieldError>{topic || date !== day || agenda !== null ? bad : null}</FieldError>
        {edit?.whatsapp && <p className="text-xs text-subtle">Booked from WhatsApp ({edit.whatsapp}). The group isn't told about changes made here.</p>}
      </form>
    </Modal>
  );
}
