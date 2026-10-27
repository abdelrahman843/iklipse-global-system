import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Copy, ExternalLink, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Controls";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint, Input, Label, Textarea } from "@/components/ui/Input";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { Modal } from "@/components/ui/Modal";
import { PageTitle, plural } from "@/components/ui/PageTitle";
import { PillTabs } from "@/components/ui/PillTabs";
import { ROWS, Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { LogoLoader, PageSpinner, Spinner } from "@/components/ui/Spinner";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { lengthText } from "@/components/meetings/CalendlySection";
import { copy, MeetingRow } from "@/components/meetings/MeetingRow";
import { CalendlyCalendar, daysOf, shiftDay, titleOf, type CalView } from "@/components/meetings/CalendlyCalendar";
import { cn } from "@/lib/cn";
import { addDays, cairoToday, dayText, timeText } from "@/lib/attendanceApi";
import { placeName } from "@/lib/calendlyApi";
import { fetchConnections, type CalendarAccount } from "@/lib/connectionsApi";
import {
  cancelCalendarMeeting,
  createCalendarMeeting,
  fetchCalendarMeeting,
  fetchCalendarMeetings,
  type CalendarGuest,
  type CalendarMeeting,
} from "@/lib/calendarApi";

// -----------------------------------------------------------------------------
// Calendar (0096): the meetings on my Google Calendars, one account at a time,
// in the Calendly page's calendar (a day, a week, a month, in Cairo time) or
// as a list, coming or past, by day. A meeting opens with who's in it, their
// answers and its link, and can be cancelled (Google emails the guests). New
// meeting: a title, a day and time, how long, who's in it and a Google Meet
// link; an empty half hour on the calendar starts one then.
// -----------------------------------------------------------------------------

type Range = "coming" | "past";
type View = CalView | "list";

const VIEWS: { value: View; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "list", label: "List" },
];

const LENGTHS = [15, 30, 45, 60, 90, 120].map((m) => ({ value: String(m), label: lengthText(m) }));

/** The view picked last time; a phone starts on the day. */
const firstView = (): View => {
  try {
    const v = localStorage.getItem("calendar.view") as View | null;
    if (v && VIEWS.some((x) => x.value === v)) return v;
  } catch {
    // no storage
  }
  return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches ? "day" : "week";
};

export default function CalendarPage() {
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const accounts = conns.data?.calendar ?? [];
  if (conns.isLoading) return <PageSpinner />;
  if (!accounts.length)
    return (
      <div className="p-6">
        <EmptyState
          icon={<CalendarDays size={20} />}
          title="Connect Google Calendar first"
          description="The meetings on your Google Calendar show here once it's connected, and you can make them from here."
          action={
            <Link to="/connections?tab=calendar">
              <Button variant="primary" iconLeft={<CalendarDays size={14} />}>
                Connect Google Calendar
              </Button>
            </Link>
          }
        />
      </div>
    );
  return <Meetings accounts={accounts} />;
}

function Meetings({ accounts }: { accounts: CalendarAccount[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === picked) ?? accounts[0]!;
  const [range, setRange] = useState<Range>("coming");
  const [view, setViewState] = useState<View>(firstView);
  const today = cairoToday();
  const [anchor, setAnchor] = useState(today);
  const [making, setMaking] = useState<{ day?: string; time?: string } | null>(null);
  const [open, setOpen] = useState<CalendarMeeting | null>(null);
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem("calendar.view", v);
    } catch {
      // no storage
    }
  };
  const calendar = view !== "list";
  const shownDays = calendar ? daysOf(view, anchor) : [];
  const from = calendar ? shownDays[0]! : range === "coming" ? today : addDays(today, -60);
  const to = calendar ? shownDays[shownDays.length - 1]! : range === "coming" ? addDays(today, 90) : today;

  const q = useQuery({
    queryKey: ["calendar", "meetings", account.id, calendar ? `${from}:${to}` : range],
    queryFn: () => fetchCalendarMeetings(account.id, from, to),
    refetchInterval: 60_000,
    placeholderData: calendar ? keepPreviousData : undefined,
  });
  // The next and previous stretch, ready before they're asked for.
  const qc = useQueryClient();
  useEffect(() => {
    if (!calendar) return;
    for (const n of [-1, 1]) {
      const ds = daysOf(view, shiftDay(view, anchor, n));
      const [a, b] = [ds[0]!, ds[ds.length - 1]!];
      void qc.prefetchQuery({ queryKey: ["calendar", "meetings", account.id, `${a}:${b}`], queryFn: () => fetchCalendarMeetings(account.id, a, b), staleTime: 60_000 });
    }
  }, [qc, account.id, view, anchor, calendar]);

  const now = Date.now();
  const shown = useMemo(() => {
    const list = (q.data ?? []).filter((m) => (range === "coming" ? Date.parse(m.end) >= now : Date.parse(m.end) < now));
    if (range === "past") list.reverse();
    const days = new Map<string, CalendarMeeting[]>();
    for (const m of list) {
      const d = cairoToday(new Date(m.start));
      days.set(d, [...(days.get(d) ?? []), m]);
    }
    return [...days.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, range]);
  const count = calendar ? (q.data ?? []).length : shown.reduce((n, [, ms]) => n + ms.length, 0);

  const tabs: LineTab<Range>[] = [
    { value: "coming", label: "Coming" },
    { value: "past", label: "Past" },
  ];

  // The calendar fills the page and scrolls inside itself; the list scrolls the page.
  return (
    <div className={cn("h-full overflow-y-auto", calendar && "flex flex-col")}>
      <div className={cn("p-3 sm:p-4 md:p-6", calendar && "flex-1 min-h-0 flex flex-col")}>
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <PageTitle
              count={q.data && (calendar ? plural(count, "meeting") : plural(count, range === "coming" ? "coming" : "past", range === "coming" ? "coming" : "past"))}
              info="The meetings on your Google Calendar. Google emails the people in each one the invite and the link."
            >
              Calendar
            </PageTitle>
          </div>
          <Button size="sm" variant="primary" iconLeft={<Plus size={14} />} onClick={() => setMaking({})} className="shrink-0">
            New meeting
          </Button>
        </div>

        {accounts.length > 1 && (
          <PillTabs
            value={account.id}
            tabs={accounts.map((a) => ({ value: a.id, label: a.email }))}
            onChange={setPicked}
            label="Google Calendars"
            scroll
            className="mb-4"
          />
        )}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {calendar && (
            <>
              <Button size="sm" onClick={() => setAnchor(today)}>
                Today
              </Button>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setAnchor(shiftDay(view, anchor, -1))}
                  aria-label="Back"
                  className="h-9 w-9 grid place-items-center rounded-full text-muted hover:bg-hover hover:text-ink"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => setAnchor(shiftDay(view, anchor, 1))}
                  aria-label="Next"
                  className="h-9 w-9 grid place-items-center rounded-full text-muted hover:bg-hover hover:text-ink"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <h2 className="text-lg font-semibold text-ink mr-auto">{titleOf(view, anchor)}</h2>
              {q.isFetching && !q.isLoading && <Spinner />}
            </>
          )}
          <PillTabs value={view} tabs={VIEWS} onChange={setView} label="View" className={cn(!calendar && "mr-auto")} />
        </div>
        {!calendar && (
          <div className="mb-5 border-b border-border">
            <LineTabs value={range} tabs={tabs} onChange={setRange} label="Meetings" bare />
          </div>
        )}

        <div key={`${account.id}:${calendar ? view : range}`} className={cn("view-enter", calendar ? "flex-1 min-h-[24rem] flex flex-col" : "space-y-8")}>
          {q.isLoading ? (
            <div className="py-12 flex justify-center">
              <LogoLoader width={64} />
            </div>
          ) : q.error && !q.data ? (
            <EmptyState
              icon={<AlertTriangle size={20} />}
              title="Couldn't load the meetings"
              description={(q.error as Error).message}
              action={
                /connected again/i.test((q.error as Error).message) && (
                  <Link to="/connections?tab=calendar">
                    <Button variant="primary" iconLeft={<CalendarDays size={14} />}>
                      Connect it again
                    </Button>
                  </Link>
                )
              }
            />
          ) : calendar ? (
            <CalendlyCalendar
              view={view}
              anchor={anchor}
              meetings={q.data ?? []}
              free={[]}
              freeMinutes={30}
              onOpen={(m) => setOpen((q.data ?? []).find((x) => x.id === m.id) ?? null)}
              onBook={(day, time) => {
                if (day < today) return;
                setMaking({ day, time });
              }}
              onPickDay={(d) => {
                setAnchor(d);
                setView("day");
              }}
            />
          ) : !shown.length ? (
            <EmptyState
              icon={<CalendarDays size={20} />}
              title={range === "coming" ? "Nothing coming up" : "No meetings in the last 2 months"}
              description={range === "coming" ? "Meetings on your Google Calendar, and the ones you make here, show up here." : undefined}
            />
          ) : (
            shown.map(([day, ms]) => (
              <Section key={day} title={day === today ? `Today, ${dayText(day)}` : dayText(day)} count={ms.length}>
                <ul className={ROWS}>
                  {ms.map((m, i) => (
                    <MeetingRow key={m.id} m={m} i={i} past={range === "past"} onOpen={() => setOpen(m)} />
                  ))}
                </ul>
              </Section>
            ))
          )}
        </div>
      </div>

      {making && <NewMeetingModal account={account} start={making} onClose={() => setMaking(null)} />}
      {open && <MeetingModal account={account} meeting={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

const ANSWER: Record<CalendarGuest["status"], string> = {
  accepted: "Going",
  tentative: "Maybe",
  declined: "Not going",
  needsAction: "No answer yet",
};

/** Google's description can carry a little HTML: as plain text. */
const plainText = (html: string) => {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n"), "text/html");
  return (doc.body.textContent ?? "").trim();
};

function MeetingModal({ account, meeting, onClose }: { account: CalendarAccount; meeting: CalendarMeeting; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["calendar", "meeting", account.id, meeting.id], queryFn: () => fetchCalendarMeeting(account.id, meeting.id) });
  const m = q.data ?? { ...meeting, place: null, password: null, note: null, mine: false, invitees: [] };
  const coming = Date.parse(meeting.end) >= Date.now();
  const guests = m.invitees.filter((i) => !i.self);
  const cancel = useMutation({
    mutationFn: () => cancelCalendarMeeting(account.id, meeting.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["calendar", "meetings"] });
      toast.push(m.mine && guests.length ? { kind: "success", title: "Cancelled", description: "Google emailed the people in it." } : { kind: "success", title: "Taken off your calendar" });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't cancel it", description: e.message }),
  });
  const note = m.note ? plainText(m.note) : "";

  return (
    <Modal
      open
      onClose={onClose}
      title={m.name}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {coming && q.data ? (
            <Button
              variant="ghost"
              iconLeft={<Trash2 size={14} />}
              loading={cancel.isPending}
              onClick={async () => {
                const ok = await confirm(
                  m.mine
                    ? {
                        title: "Cancel this meeting?",
                        message: guests.length ? `Google emails ${guests.map((i) => i.name || i.email).join(", ")}.` : "It comes off your Google Calendar.",
                        confirmLabel: "Cancel meeting",
                        danger: true,
                      }
                    : {
                        title: "Take it off your calendar?",
                        message: "Someone else made it, so it stays on theirs.",
                        confirmLabel: "Take it off",
                        danger: true,
                      },
                );
                if (ok) cancel.mutate();
              }}
            >
              {m.mine ? "Cancel meeting" : "Take off my calendar"}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {m.link && (
              <a href={m.link} target="_blank" rel="noreferrer">
                <Button variant={coming && m.join_url ? "secondary" : "primary"} iconLeft={<CalendarDays size={14} />}>
                  <span className="hidden sm:inline">Open in Google Calendar</span>
                  <span className="sm:hidden">Google</span>
                </Button>
              </a>
            )}
            {coming && m.join_url && (
              <a href={m.join_url} target="_blank" rel="noreferrer">
                <Button variant="primary" iconLeft={<ExternalLink size={14} />}>
                  Join
                </Button>
              </a>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4 text-sm">
        <div>
          <div className="font-semibold text-ink">
            {dayText(cairoToday(new Date(m.start)))}, {timeText(m.start)}
          </div>
          <div className="text-muted">
            {lengthText(m.minutes)}
            {placeName(m.location) ? ` · ${placeName(m.location)}` : ""}
          </div>
        </div>
        {m.join_url && (
          <div className="flex items-center gap-2 min-w-0">
            <a href={m.join_url} target="_blank" rel="noreferrer" className="text-accent hover:underline truncate">
              {m.join_url}
            </a>
            <button type="button" onClick={() => void copy(m.join_url!, toast)} aria-label="Copy the link" className="h-8 w-8 shrink-0 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink">
              <Copy size={14} />
            </button>
          </div>
        )}
        {m.password && <div className="text-muted">Passcode {m.password}</div>}
        {m.place && <div className="text-muted break-words">{m.place}</div>}
        {note && <div className="text-ink whitespace-pre-wrap break-words">{note}</div>}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-subtle mb-1.5">With</div>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <div className="text-danger">{(q.error as Error).message}</div>
          ) : !guests.length ? (
            <div className="text-muted">Nobody else.</div>
          ) : (
            <ul className="space-y-1.5">
              {guests.map((i) => (
                <li key={i.email} className={cn("flex flex-wrap items-baseline gap-x-2", i.status === "declined" && "opacity-60")}>
                  <span className="text-ink font-medium">{i.name || i.email}</span>
                  {i.name && <span className="text-muted">{i.email}</span>}
                  <span className="text-xs text-subtle">
                    {i.organizer ? "Made it" : ANSWER[i.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

const emailOk = (e: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(e);

/** The next half hour from now, in Cairo ("14:30"). */
function nextHalfHour() {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date())
    .split(":")
    .map(Number);
  const mins = Math.min(23 * 60 + 30, Math.ceil((h! * 60 + m! + 1) / 30) * 30);
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function NewMeetingModal({ account, start, onClose }: { account: CalendarAccount; start: { day?: string; time?: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const today = cairoToday();
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(start.day && start.day >= today ? start.day : today);
  const [time, setTime] = useState(start.time ?? nextHalfHour());
  const [minutes, setMinutes] = useState("30");
  const [guests, setGuests] = useState("");
  const [note, setNote] = useState("");
  const [meet, setMeet] = useState(true);
  const guestList = guests
    .split(/[\s,;]+/)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const badGuest = guestList.find((g) => !emailOk(g));
  const ok = !!day && /^\d{2}:\d{2}$/.test(time) && !badGuest;

  const make = useMutation({
    mutationFn: () => createCalendarMeeting(account.id, { title: title.trim(), day, time, minutes: Number(minutes), emails: guestList, note: note.trim(), meet }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["calendar", "meetings"] });
      toast.push({ kind: "success", title: "Meeting made", description: guestList.length ? "Google emailed them the invite." : undefined });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't make it", description: e.message }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="New meeting"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} loading={make.isPending} onClick={() => make.mutate()}>
            Make it
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">On {account.email}. Google emails the people in it the invite{meet ? " and the Meet link" : ""}.</p>
        <div>
          <Label htmlFor="gc-title">Title</Label>
          <Input id="gc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting" autoFocus />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>Day</Label>
            <DateField value={day} onChange={(v) => v && setDay(v)} min={today} clearable={false} aria-label="Day" />
          </div>
          <div>
            <Label htmlFor="gc-time">Time (Cairo)</Label>
            <Input id="gc-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div>
            <Label>How long</Label>
            <Select value={minutes} onChange={setMinutes} options={LENGTHS} aria-label="How long" />
          </div>
        </div>
        <div>
          <Label htmlFor="gc-guests">Who's in it</Label>
          <Input id="gc-guests" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="Emails, separated by commas" />
          {badGuest && <Hint>{badGuest} doesn't look like an email.</Hint>}
        </div>
        <div>
          <Label htmlFor="gc-note">What it's about (optional)</Label>
          <Textarea id="gc-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Toggle checked={meet} onChange={setMeet} label="Add a Google Meet link" />
      </div>
    </Modal>
  );
}
