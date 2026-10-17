import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Infinity as Always,
  List,
  Mail,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Repeat as RepeatIcon,
  Trash2,
  Users,
  Video,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Label, Textarea, FieldError, Hint } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { PageTitle } from "@/components/ui/PageTitle";
import { PillTabs } from "@/components/ui/PillTabs";
import { Select } from "@/components/ui/Select";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { PageSpinner, Spinner } from "@/components/ui/Spinner";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { fetchConnections, type GmailAccount, type ZoomAccount } from "@/lib/connectionsApi";
import {
  createZoomMeeting,
  deleteZoomMeeting,
  fetchCalendar,
  fetchMeetingDetails,
  updateZoomMeeting,
  type CalMeeting,
  type Invited,
  type MeetingInput,
  type MeetingKind,
  type MeetingOptions,
  type Repeat,
  type Room,
} from "@/lib/zoomApi";

// -----------------------------------------------------------------------------
// Zoom: a calendar of my Zoom accounts, one at a time. The month on the left
// (past meetings faded, today marked, the WhatsApp bot's meetings in green),
// the picked day on the right with each meeting's link; a list of the month
// instead of the grid on request. Links with no set time above it. New
// meetings by hand: at a time, now, repeating, or with no set time, with
// invitees (emailed the invitation from my Gmail) and Zoom's options. The
// coming ones can be changed or cancelled (one meeting of a series, or all of
// it). Weeks start on Saturday.
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
/** Zoom's weekday numbers (1 Sunday .. 7 Saturday), in the calendar's order. */
const ZOOM_DAYS = [7, 1, 2, 3, 4, 5, 6];
const zoomDay = (d: Date) => d.getDay() + 1;

function lengthText(m: number | null | undefined) {
  if (!m) return null;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}` : `${m} min`;
}

type When = "past" | "now" | "soon";
const startOf = (m: CalMeeting) => new Date(m.start_time);
const endOf = (m: CalMeeting) => new Date(Date.parse(m.start_time) + (m.duration || 30) * 60_000);
function whenOf(m: CalMeeting, now: number): When {
  if (endOf(m).getTime() < now) return "past";
  return startOf(m).getTime() <= now ? "now" : "soon";
}
const keyOfMeeting = (m: CalMeeting) => `${m.id}-${m.occurrence ?? m.start_time}`;

/** A link with no set time, shaped like a calendar meeting for the details. */
const roomMeeting = (r: Room): CalMeeting => ({
  id: r.id,
  occurrence: null,
  topic: r.topic,
  kind: "no_time",
  start_time: r.created_at ?? new Date().toISOString(),
  duration: null,
  join_url: r.join_url,
  recurring: true,
  whatsapp: r.whatsapp,
});

type View = "month" | "list";
const VIEW_KEY = "zoom-view";
const LENGTHS = [15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: String(m), label: lengthText(m)! }));

/** What happened to the invitation emails, as a toast. */
function inviteToast(toast: ReturnType<typeof useToast>, invited: Invited | undefined, what = "Invitation") {
  if (!invited) return;
  if ("error" in invited) toast.push({ kind: "error", title: `${what} not emailed`, description: invited.error });
  else toast.push({ kind: "success", title: `${what} emailed to ${invited.sent} ${invited.sent === 1 ? "person" : "people"}`, description: `From ${invited.from}` });
}

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
  return <Calendar accounts={accounts} gmail={conns.data?.gmail ?? []} />;
}

type FormOpen = { edit?: CalMeeting; day: string; kind?: MeetingKind };

function Calendar({ accounts, gmail }: { accounts: ZoomAccount[]; gmail: GmailAccount[] }) {
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
  const [form, setForm] = useState<FormOpen | null>(null);
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
  const meetings = q.data?.meetings ?? [];
  const rooms = q.data?.rooms ?? [];
  const byDay = useMemo(() => {
    const map = new Map<string, CalMeeting[]>();
    const sorted = [...(q.data?.meetings ?? [])].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
    for (const m of sorted) {
      const k = keyOf(startOf(m));
      map.set(k, [...(map.get(k) ?? []), m]);
    }
    return map;
  }, [q.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["zoom-cal"] });
    void qc.invalidateQueries({ queryKey: ["zoom-meetings"] });
    void qc.invalidateQueries({ queryKey: ["zoom-meeting"] });
  };
  const remove = useMutation({
    mutationFn: ({ m, one }: { m: CalMeeting; one: boolean }) => deleteZoomMeeting(account.id, m.id, { occurrence: one ? m.occurrence : null }),
    onSuccess: (r, { m, one }) => {
      refresh();
      setOpen(null);
      toast.push({ kind: "success", title: one ? "That meeting is cancelled" : "Meeting cancelled", description: m.topic });
      inviteToast(toast, r.invited, "Cancellation");
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't cancel it", description: e.message }),
  });
  const askRemove = async (m: CalMeeting, one: boolean, invitees: number) => {
    const when = m.kind === "no_time" ? "" : ` (${dmy(startOf(m))}, ${time12(startOf(m))})`;
    const ok = await confirm({
      title: one ? `Cancel this meeting of "${m.topic}"?` : `Cancel "${m.topic}"${m.occurrence ? " and all its meetings" : ""}?`,
      message: one
        ? `Only the meeting on ${dmy(startOf(m))} is cancelled; the rest of the series stays.`
        : `It's deleted from Zoom${when}. Anyone with the link can't join anymore.${invitees ? ` The ${invitees} invitee${invitees === 1 ? " gets" : "s get"} a cancellation email.` : ""}${m.whatsapp ? " The WhatsApp group isn't told." : ""}`,
      confirmLabel: one ? "Cancel this one" : "Cancel meeting",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (ok) remove.mutate({ m, one });
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

  const inMonth = meetings.filter((m) => startOf(m).getMonth() === month.getMonth() && startOf(m).getFullYear() === month.getFullYear());
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
        <div className="flex flex-wrap gap-2">
          <Button iconLeft={<Zap size={15} />} onClick={() => setForm({ day: today, kind: "instant" })}>
            Start now
          </Button>
          <Button variant="primary" iconLeft={<Plus size={15} />} onClick={() => setForm({ day: day < today ? today : day })}>
            New meeting
          </Button>
        </div>
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

      {/* ----------------------------------------------- links with no set time */}
      {rooms.length > 0 && (
        <section className="mb-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-subtle">
            <Always size={13} /> Links with no set time
          </div>
          <div className="flex gap-2.5 overflow-x-auto pb-1 -mx-1 px-1">
            {rooms.map((r) => (
              <RoomCard key={r.id} r={r} onOpen={() => setOpen(roomMeeting(r))} />
            ))}
          </div>
        </section>
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
                          <span key={keyOfMeeting(m)} className={cn("h-1.5 w-1.5 rounded-full", dot(m, now))} />
                        ))}
                      </span>
                    )}
                    {/* Wider: the first few meetings. */}
                    <span className="hidden sm:block mt-1 space-y-0.5">
                      {list.slice(0, 3).map((m) => (
                        <span key={keyOfMeeting(m)} className={cn("flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-tight font-medium truncate", chip(m, now))}>
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
                  <MeetingCard key={keyOfMeeting(m)} m={m} now={now} onOpen={() => setOpen(m)} />
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
              {[...new Set(inMonth.map((m) => keyOf(startOf(m))))].sort().map((k) => (
                <div key={k}>
                  <div className={cn("mb-1.5 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide", k === today ? "text-accent" : "text-subtle")}>
                    {k === today ? "Today" : weekday(fromKey(k))} <span className="tabular-nums">{dmy(fromKey(k))}</span>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {(byDay.get(k) ?? []).map((m) => (
                      <MeetingCard key={keyOfMeeting(m)} m={m} now={now} onOpen={() => setOpen(m)} />
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
            setForm({ edit: open, day: open.kind === "no_time" ? today : keyOf(startOf(open)) });
            setOpen(null);
          }}
          onDelete={(one, invitees) => void askRemove(open, one, invitees)}
          deleting={remove.isPending}
        />
      )}
      {form && (
        <MeetingForm
          account={account}
          gmail={gmail}
          edit={form.edit}
          day={form.day}
          kind={form.kind}
          onClose={() => setForm(null)}
          onSaved={(d) => {
            refresh();
            if (d) pickDay(d);
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

const openClass = "inline-flex items-center gap-1.5 h-9 sm:h-8 px-3 rounded-md text-sm font-semibold bg-accent text-white hover:bg-accent-hover transition-colors";

function RoomCard({ r, onOpen }: { r: Room; onOpen: () => void }) {
  const toast = useToast();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className="shrink-0 w-64 rounded-xl border border-border bg-surface p-3 cursor-pointer transition-[box-shadow,border-color] duration-150 hover:shadow-pop hover:border-rule"
    >
      <div className="flex items-center gap-1.5 text-xs text-subtle">
        <Always size={12} /> Any time
        {r.whatsapp && (
          <span className="ml-auto inline-flex items-center gap-1 text-success min-w-0">
            <MessageCircle size={11} className="shrink-0" /> <span className="truncate">{r.whatsapp}</span>
          </span>
        )}
      </div>
      <div className="mt-1 text-sm font-semibold text-ink truncate">{r.topic || "Zoom meeting"}</div>
      {r.join_url && (
        <div className="mt-2 flex gap-2" onClick={(e) => e.stopPropagation()}>
          <a href={r.join_url} target="_blank" rel="noreferrer" className={openClass}>
            <Video size={14} /> Open
          </a>
          <Button size="sm" variant="ghost" iconLeft={<Copy size={14} />} onClick={() => void copy(r.join_url!, toast)}>
            Copy link
          </Button>
        </div>
      )}
    </div>
  );
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
        {m.duration ? <span>to {time12(endOf(m))}</span> : <span>no set length</span>}
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
            <RepeatIcon size={11} /> Repeats
          </span>
        )}
        {m.kind === "instant" && (
          <span className="inline-flex items-center gap-1 text-xs text-subtle">
            <Zap size={11} /> Started now
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
          <a href={m.join_url} target="_blank" rel="noreferrer" className={openClass}>
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

const RECORDING: Record<MeetingOptions["auto_recording"], string> = { none: "Off", local: "On the host's computer", cloud: "In the cloud" };

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
  onDelete: (one: boolean, invitees: number) => void;
  deleting: boolean;
}) {
  const toast = useToast();
  const anyTime = m.kind === "no_time";
  const w = anyTime ? "soon" : whenOf(m, now);
  const d = useQuery({ queryKey: ["zoom-meeting", account, m.id], queryFn: () => fetchMeetingDetails(account, m.id), enabled: w !== "past", retry: false });
  const s = startOf(m);
  const zid = m.id.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1 $2 $3");
  const link = d.data?.join_url ?? m.join_url;
  const invitees = d.data?.invitees ?? [];
  const o = d.data?.options;
  const series = !!m.occurrence;
  return (
    <Modal
      open
      onClose={onClose}
      title={m.topic || "Zoom meeting"}
      size="md"
      footer={
        w !== "past" ? (
          <div className="flex flex-wrap gap-2 w-full">
            <div className="flex flex-wrap gap-1 mr-auto">
              {series && (
                <Button variant="ghost" iconLeft={<Trash2 size={14} />} className="!text-danger hover:!bg-danger/10" loading={deleting} onClick={() => onDelete(true, invitees.length)}>
                  Cancel this one
                </Button>
              )}
              <Button variant="ghost" iconLeft={<Trash2 size={14} />} className="!text-danger hover:!bg-danger/10" loading={deleting} onClick={() => onDelete(false, invitees.length)}>
                {series ? "Cancel all" : "Cancel meeting"}
              </Button>
            </div>
            <Button iconLeft={<Pencil size={14} />} onClick={onEdit} disabled={d.isLoading}>
              {series ? "Edit series" : "Edit"}
            </Button>
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
          {w === "soon" && !anyTime && <Badge tone="accent">Coming up</Badge>}
          {anyTime && <Badge tone="accent">Any time</Badge>}
          {m.kind === "repeat" && <Badge>Repeats</Badge>}
          {m.whatsapp && <Badge tone="success">Booked from WhatsApp: {m.whatsapp}</Badge>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {anyTime ? (
            <>
              <dt className="text-muted">When</dt>
              <dd className="text-ink font-medium">Any time: the link always works</dd>
            </>
          ) : (
            <>
              <dt className="text-muted">Date</dt>
              <dd className="text-ink font-medium tabular-nums">
                {dmy(s)} ({weekday(s)})
              </dd>
              <dt className="text-muted">Time</dt>
              <dd className="text-ink font-medium tabular-nums">
                {m.duration ? `${time12(s)} to ${time12(endOf(m))}` : time12(s)}
                {lengthText(m.duration) && <span className="text-muted font-normal"> · {lengthText(m.duration)}</span>}
              </dd>
            </>
          )}
          {d.data?.repeat_words && (
            <>
              <dt className="text-muted">Repeats</dt>
              <dd className="text-ink">{d.data.repeat_words}</dd>
            </>
          )}
          <dt className="text-muted">Meeting ID</dt>
          <dd className="text-ink tabular-nums">{zid}</dd>
          {d.data?.password && (
            <>
              <dt className="text-muted">Passcode</dt>
              <dd className="text-ink tabular-nums">{d.data.password}</dd>
            </>
          )}
          {invitees.length > 0 && (
            <>
              <dt className="text-muted">Invited</dt>
              <dd className="text-ink break-words">{invitees.join(", ")}</dd>
            </>
          )}
          {o && (
            <>
              <dt className="text-muted">Options</dt>
              <dd className="text-ink">
                {[
                  o.waiting_room ? "Waiting room" : o.join_before_host ? "Join before the host" : "Waits for the host",
                  o.mute_upon_entry && "Muted on joining",
                  o.auto_recording !== "none" && `Recorded ${RECORDING[o.auto_recording].toLowerCase()}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </dd>
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
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- the form --

/** The next half hour from now, "HH:MM". */
function nextHalfHour() {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMAIL = /^[^\s@<>(),;:"[\]]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PASSCODE = /^[A-Za-z0-9@_*-]{0,10}$/;
const KIND_OPTIONS: { value: MeetingKind; label: string }[] = [
  { value: "once", label: "At a time" },
  { value: "repeat", label: "Repeats" },
  { value: "instant", label: "Now" },
  { value: "no_time", label: "No set time" },
];
const DEFAULT_OPTIONS: MeetingOptions = {
  waiting_room: false,
  join_before_host: true,
  jbh_time: 0,
  mute_upon_entry: false,
  host_video: false,
  participant_video: false,
  auto_recording: "none",
};

/** Emails as chips: typed, pasted, a comma or Enter adds one. */
function EmailsField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((p) => p.trim().replace(/^<|>$/g, "").toLowerCase()).filter(Boolean);
    const wrong = parts.filter((p) => !EMAIL.test(p));
    const good = parts.filter((p) => EMAIL.test(p) && !value.includes(p));
    if (good.length) onChange([...value, ...good].slice(0, 50));
    setDraft(wrong.join(" "));
    setBad(wrong.length ? `Not an email address: ${wrong.join(", ")}` : null);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
        {value.map((e) => (
          <span key={e} className="inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent pl-2.5 pr-1 py-0.5 text-sm max-w-full">
            <span className="truncate">{e}</span>
            <button type="button" aria-label={`Remove ${e}`} onClick={() => onChange(value.filter((x) => x !== e))} className="grid place-items-center h-5 w-5 rounded-full hover:bg-accent/15">
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => {
            const v = e.target.value;
            if (/[\s,;]$/.test(v)) add(v);
            else setDraft(v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (/[\s,;]/.test(t.trim())) {
              e.preventDefault();
              add(`${draft} ${t}`);
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={value.length ? "Add another" : "name@company.com"}
          className="flex-1 min-w-[10rem] h-8 bg-transparent text-base sm:text-sm text-ink outline-none placeholder:text-subtle"
          aria-label="Invite by email"
          type="email"
          inputMode="email"
        />
      </div>
      <FieldError>{bad}</FieldError>
    </div>
  );
}

function MeetingForm({
  account,
  gmail,
  edit,
  day,
  kind: startKind,
  onClose,
  onSaved,
}: {
  account: ZoomAccount;
  gmail: GmailAccount[];
  edit?: CalMeeting;
  day: string;
  kind?: MeetingKind;
  onClose: () => void;
  onSaved: (day: string | null) => void;
}) {
  const toast = useToast();
  const details = useQuery({ queryKey: ["zoom-meeting", account.id, edit?.id], queryFn: () => fetchMeetingDetails(account.id, edit!.id), enabled: !!edit, retry: false });
  const [ready, setReady] = useState(!edit);
  const [kind, setKind] = useState<MeetingKind>(edit?.kind ?? startKind ?? "once");
  const [topic, setTopic] = useState(edit?.topic ?? "");
  const [date, setDate] = useState(day);
  const [time, setTime] = useState(day === keyOf(new Date()) ? nextHalfHour() : "10:00");
  const [minutes, setMinutes] = useState(startKind === "instant" ? "" : "30");
  const [agenda, setAgenda] = useState("");
  const [invitees, setInvitees] = useState<string[]>([]);
  const [notify, setNotify] = useState(gmail.length > 0);
  const match = gmail.find((g) => g.email.toLowerCase() === (account.email ?? "").toLowerCase());
  const [from, setFrom] = useState<string>(match?.id ?? gmail[0]?.id ?? "");
  const [options, setOptions] = useState<MeetingOptions>(DEFAULT_OPTIONS);
  const [passcode, setPasscode] = useState("");
  const [more, setMore] = useState(false);
  const d0 = fromKey(day);
  const [repeat, setRepeat] = useState<Repeat>({ type: "weekly", every: 1, days: [zoomDay(d0)], monthDay: d0.getDate(), times: 10, until: null });
  const [endBy, setEndBy] = useState<"times" | "until">("times");
  const [untilDay, setUntilDay] = useState(keyOf(addDays(d0, 70)));
  const [made, setMade] = useState<{ join_url: string; topic: string } | null>(null);

  // Editing: what the meeting has now.
  const was = details.data;
  useEffect(() => {
    if (ready || !was) return;
    setKind(was.kind);
    setTopic(was.topic);
    if (was.start_time) {
      const s = new Date(was.start_time);
      setDate(keyOf(s));
      setTime(`${pad(s.getHours())}:${pad(s.getMinutes())}`);
    }
    setMinutes(was.duration ? String(was.duration) : "");
    setAgenda(was.agenda ?? "");
    setInvitees(was.invitees ?? []);
    setOptions({ ...DEFAULT_OPTIONS, ...was.options });
    if (was.repeat) {
      setRepeat(was.repeat);
      if (was.repeat.until) {
        setEndBy("until");
        setUntilDay(keyOf(new Date(was.repeat.until)));
      }
    }
    setReady(true);
  }, [was, ready]);

  const timed = kind === "once" || kind === "repeat";
  const start = timed && date && /^\d{2}:\d{2}$/.test(time) ? new Date(`${date}T${time}:00`) : null;
  const startChanged = !was?.start_time || !start || start.getTime() !== Date.parse(was.start_time);
  const past = !!start && startChanged && start.getTime() < Date.now() - 60_000;
  const repeatOut: Repeat = {
    ...repeat,
    times: endBy === "times" ? Math.max(1, Math.min(50, Number(repeat.times) || 10)) : null,
    until: endBy === "until" ? new Date(`${untilDay}T23:59:00`).toISOString() : null,
  };
  const bad = !topic.trim()
    ? "Give it a title."
    : timed && (!start || isNaN(start.getTime()))
      ? "Pick the day and the time."
      : past
        ? "That time has passed."
        : kind === "repeat" && repeat.type === "weekly" && !repeat.days.length
          ? "Pick the days it repeats on."
          : kind === "repeat" && endBy === "until" && untilDay <= date
            ? "The last day is before the first meeting."
            : !PASSCODE.test(passcode)
              ? "A passcode is up to 10 letters, numbers or @ - _ *"
              : null;

  const save = useMutation({
    mutationFn: async () => {
      const mins = minutes ? Number(minutes) : null;
      const m: MeetingInput = {
        topic: topic.trim(),
        kind,
        start: timed ? start!.toISOString() : undefined,
        minutes: timed ? mins || 30 : mins,
        agenda: agenda.trim(),
        password: passcode || undefined,
        repeat: kind === "repeat" ? repeatOut : undefined,
        options,
        invitees,
        notify: notify && !!from,
        gmail: from || null,
      };
      if (!edit) return createZoomMeeting(account.id, m);
      // Only what changed, so the invitees hear about a real change.
      const patch: Partial<MeetingInput> = { invitees, notify: m.notify, gmail: m.gmail };
      if (m.topic !== was?.topic) patch.topic = m.topic;
      if (kind !== was?.kind) patch.kind = kind;
      if (timed && startChanged) patch.start = m.start;
      if (m.minutes && m.minutes !== was?.duration) patch.minutes = m.minutes;
      if (m.agenda !== (was?.agenda ?? "")) patch.agenda = m.agenda;
      if (passcode && passcode !== was?.password) patch.password = passcode;
      if (kind === "repeat" && JSON.stringify(repeatOut) !== JSON.stringify(was?.repeat)) patch.repeat = repeatOut;
      if (JSON.stringify(options) !== JSON.stringify({ ...DEFAULT_OPTIONS, ...was?.options })) patch.options = options;
      return updateZoomMeeting(account.id, edit.id, patch);
    },
    onSuccess: (r) => {
      inviteToast(toast, r.invited, edit ? "Update" : "Invitation");
      onSaved(timed ? date : null);
      // A link to use now: shown, to open or copy.
      if (!edit && "join_url" in r && (kind === "instant" || kind === "no_time")) {
        setMade({ join_url: r.join_url, topic: topic.trim() });
        return;
      }
      toast.push({
        kind: "success",
        title: edit ? "Meeting updated" : kind === "repeat" ? "Meetings booked" : "Meeting booked",
        description: start ? `${dmy(start)}, ${time12(start)}` : undefined,
      });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: edit ? "Couldn't update it" : "Couldn't book it", description: e.message }),
  });

  const lengths = [
    ...(kind === "instant" ? [{ value: "", label: "No set length" }] : []),
    ...(LENGTHS.some((l) => l.value === minutes) || !minutes ? LENGTHS : [...LENGTHS, { value: minutes, label: lengthText(Number(minutes)) ?? `${minutes} min` }]),
  ];
  const setOpt = <K extends keyof MeetingOptions>(k: K, v: MeetingOptions[K]) => setOptions((o) => ({ ...o, [k]: v }));
  const pickKind = (k: MeetingKind) => {
    setKind(k);
    if (k === "instant" && !edit) setMinutes("");
    if ((k === "once" || k === "repeat") && !minutes) setMinutes("30");
  };

  if (made)
    return (
      <Modal open onClose={onClose} title={kind === "instant" ? "Your meeting is ready" : "Your link is ready"} size="sm">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            <span className="font-semibold text-ink">{made.topic}</span>
            {kind === "instant" ? ": start it now, and send the link to who you're meeting." : ": it works any time. Keep it, send it, use it again."}
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-inset/50 pl-3 pr-1 py-1">
            <span className="flex-1 min-w-0 truncate text-sm text-muted">{made.join_url}</span>
            <Button size="sm" variant="ghost" iconLeft={<Copy size={14} />} onClick={() => void copy(made.join_url, toast)}>
              Copy
            </Button>
          </div>
          <a href={made.join_url} target="_blank" rel="noreferrer" className="w-full inline-flex items-center justify-center gap-1.5 h-11 sm:h-10 rounded-md font-semibold bg-accent text-white hover:bg-accent-hover">
            <Video size={16} /> Open in Zoom
          </a>
        </div>
      </Modal>
    );

  return (
    <Modal
      open
      onClose={onClose}
      title={edit ? (edit.occurrence ? "Edit the series" : "Edit meeting") : "New Zoom meeting"}
      size="lg"
      footer={
        <div className="flex gap-2 justify-end w-full">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!!bad || !ready} onClick={() => save.mutate()}>
            {edit ? "Save" : kind === "instant" ? "Start it" : kind === "no_time" ? "Make the link" : "Book it"}
          </Button>
        </div>
      }
    >
      {!ready ? (
        <div className="py-10 grid place-items-center">
          <Spinner />
        </div>
      ) : (
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

          <div>
            <Label>When</Label>
            <Segmented value={kind} options={KIND_OPTIONS} onChange={pickKind} />
            <Hint>
              {kind === "instant"
                ? "Starts now: a link to open right away, with a length or none."
                : kind === "no_time"
                  ? "A link with no date that always works, for any time you need it."
                  : kind === "repeat"
                    ? "The same link for every meeting of the series."
                    : "One meeting, on a day and at a time."}
            </Hint>
          </div>

          {timed && (
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem_9rem]">
              <div>
                <Label>{kind === "repeat" ? "First day" : "Day"}</Label>
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
          )}
          {kind === "instant" && (
            <div className="sm:w-56">
              <Label>Length</Label>
              <Select value={minutes} onChange={setMinutes} options={lengths} aria-label="Length" />
            </div>
          )}

          {kind === "repeat" && (
            <div className="rounded-xl border border-border bg-inset/40 p-3 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label>Repeats</Label>
                  <Segmented
                    value={repeat.type}
                    options={[
                      { value: "daily", label: "Daily" },
                      { value: "weekly", label: "Weekly" },
                      { value: "monthly", label: "Monthly" },
                    ]}
                    onChange={(t) => setRepeat((r) => ({ ...r, type: t, days: r.days.length ? r.days : [zoomDay(fromKey(date))], monthDay: r.monthDay ?? fromKey(date).getDate() }))}
                  />
                </div>
                <div className="w-28">
                  <Label htmlFor="zm-every">Every</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="zm-every"
                      type="number"
                      min={1}
                      max={repeat.type === "daily" ? 99 : repeat.type === "weekly" ? 50 : 10}
                      value={repeat.every}
                      onChange={(e) => setRepeat((r) => ({ ...r, every: Math.max(1, Number(e.target.value) || 1) }))}
                    />
                    <span className="text-sm text-muted">{repeat.type === "daily" ? "days" : repeat.type === "weekly" ? "weeks" : "months"}</span>
                  </div>
                </div>
              </div>
              {repeat.type === "weekly" && (
                <div>
                  <Label>On</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {ZOOM_DAYS.map((zd, i) => {
                      const on = repeat.days.includes(zd);
                      return (
                        <button
                          key={zd}
                          type="button"
                          aria-pressed={on}
                          onClick={() => setRepeat((r) => ({ ...r, days: on ? r.days.filter((x) => x !== zd) : [...r.days, zd].sort() }))}
                          className={cn(
                            "h-9 min-w-11 px-2 rounded-md border text-sm font-medium transition-colors",
                            on ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:text-ink",
                          )}
                        >
                          {WEEK[i]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {repeat.type === "monthly" && (
                <div className="w-40">
                  <Label htmlFor="zm-mday">Day of the month</Label>
                  <Input id="zm-mday" type="number" min={1} max={31} value={repeat.monthDay ?? ""} onChange={(e) => setRepeat((r) => ({ ...r, monthDay: Math.max(1, Math.min(31, Number(e.target.value) || 1)) }))} />
                </div>
              )}
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label>Ends</Label>
                  <Segmented
                    value={endBy}
                    options={[
                      { value: "times", label: "After" },
                      { value: "until", label: "On a day" },
                    ]}
                    onChange={setEndBy}
                  />
                </div>
                {endBy === "times" ? (
                  <div className="flex items-center gap-2 w-40">
                    <Input type="number" min={1} max={50} value={repeat.times ?? 10} onChange={(e) => setRepeat((r) => ({ ...r, times: Math.max(1, Math.min(50, Number(e.target.value) || 1)) }))} aria-label="How many meetings" />
                    <span className="text-sm text-muted">meetings</span>
                  </div>
                ) : (
                  <div className="w-48">
                    <DateField value={untilDay} onChange={setUntilDay} min={date} clearable={false} aria-label="Last day" />
                  </div>
                )}
              </div>
              <Hint>Zoom allows up to 50 meetings in a series.</Hint>
            </div>
          )}

          <div>
            <Label>
              <span className="inline-flex items-center gap-1.5">
                <Users size={13} /> Invite people
              </span>
            </Label>
            <EmailsField value={invitees} onChange={setInvitees} />
            {invitees.length > 0 &&
              (gmail.length ? (
                <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
                  <Toggle checked={notify} onChange={setNotify} label="Email them the invitation" hint="A calendar invite with the link. They get the changes and the cancellation too." />
                  {notify && gmail.length > 1 && (
                    <Select className="sm:w-60 sm:ml-auto" size="sm" value={from} onChange={setFrom} options={gmail.map((g) => ({ value: g.id, label: g.email }))} aria-label="Email it from" />
                  )}
                </div>
              ) : (
                <Hint>
                  <span className="inline-flex items-center gap-1">
                    <Mail size={12} /> Zoom keeps them on the meeting. To email them the invitation, connect your Gmail on the{" "}
                    <Link to="/connections?tab=gmail" className="text-accent hover:underline">
                      Connections
                    </Link>{" "}
                    page.
                  </span>
                </Hint>
              ))}
            {invitees.length > 0 && notify && gmail.length === 1 && <Hint>Emailed from {gmail[0]!.email}.</Hint>}
          </div>

          <div>
            <Label htmlFor="zm-agenda">Details</Label>
            <Textarea id="zm-agenda" rows={3} value={agenda} onChange={(e) => setAgenda(e.target.value)} placeholder="What it's about, links, notes…" maxLength={2000} />
          </div>

          {/* ------------------------------------------------------ Zoom's options */}
          <div className="rounded-xl border border-border">
            <button type="button" onClick={() => setMore(!more)} className="w-full flex items-center gap-2 px-3 py-2.5 text-sm font-semibold text-ink">
              More options
              <span className="text-xs font-normal text-subtle truncate">
                {[options.waiting_room && "waiting room", options.mute_upon_entry && "muted", options.auto_recording !== "none" && "recorded", passcode && "own passcode"].filter(Boolean).join(", ")}
              </span>
              <ChevronDown size={16} className={cn("ml-auto text-subtle transition-transform", more && "rotate-180")} />
            </button>
            {more && (
              <div className="border-t border-line px-3 py-3 space-y-3 animate-fade-in">
                <Toggle
                  checked={options.waiting_room}
                  onChange={(v) => setOptions((o) => ({ ...o, waiting_room: v, join_before_host: v ? false : o.join_before_host }))}
                  label="Waiting room"
                  hint="People wait until the host lets them in."
                />
                <Toggle
                  checked={options.join_before_host}
                  onChange={(v) => setOpt("join_before_host", v)}
                  disabled={options.waiting_room}
                  label="Join before the host"
                  hint={options.waiting_room ? "Not with a waiting room." : "People can start without the host."}
                />
                <Toggle checked={options.mute_upon_entry} onChange={(v) => setOpt("mute_upon_entry", v)} label="Mute people when they join" />
                <Toggle checked={options.host_video} onChange={(v) => setOpt("host_video", v)} label="Host's video on" />
                <Toggle checked={options.participant_video} onChange={(v) => setOpt("participant_video", v)} label="Everyone's video on" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Record it</Label>
                    <Select
                      value={options.auto_recording}
                      onChange={(v) => setOpt("auto_recording", v as MeetingOptions["auto_recording"])}
                      options={(Object.keys(RECORDING) as MeetingOptions["auto_recording"][]).map((k) => ({ value: k, label: RECORDING[k] }))}
                      aria-label="Record it"
                    />
                  </div>
                  <div>
                    <Label htmlFor="zm-pass">Passcode</Label>
                    <Input id="zm-pass" value={passcode} onChange={(e) => setPasscode(e.target.value.trim())} placeholder={was?.password ? `Now: ${was.password}` : "Zoom makes one"} maxLength={10} />
                  </div>
                </div>
                <Hint>Recording in the cloud needs a paid Zoom account.</Hint>
              </div>
            )}
          </div>

          <FieldError>{topic || date !== day || agenda ? bad : null}</FieldError>
          {edit?.whatsapp && <p className="text-xs text-subtle">Booked from WhatsApp ({edit.whatsapp}). The group isn't told about changes made here.</p>}
          {edit?.occurrence && <p className="text-xs text-subtle">Changes here apply to every meeting of the series.</p>}
        </form>
      )}
    </Modal>
  );
}

