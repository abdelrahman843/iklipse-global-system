import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, Copy, ExternalLink, Link2, MessageCircle, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Hint, Input, Label, Textarea } from "@/components/ui/Input";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { Modal } from "@/components/ui/Modal";
import { PageTitle, plural } from "@/components/ui/PageTitle";
import { PillTabs } from "@/components/ui/PillTabs";
import { ROW, ROWS, Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { LogoLoader, PageSpinner, Spinner } from "@/components/ui/Spinner";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { lengthText } from "@/components/meetings/CalendlySection";
import { cn } from "@/lib/cn";
import { addDays, cairoToday, dayText, timeText } from "@/lib/attendanceApi";
import { fetchCalendlyEventTypes, fetchConnections, type CalendlyAccount } from "@/lib/connectionsApi";
import {
  bookCalendly,
  cancelCalendly,
  fetchCalendlyMeeting,
  fetchCalendlyMeetings,
  fetchOpenTimes,
  placeName,
  type CalendlyMeeting,
} from "@/lib/calendlyApi";

// -----------------------------------------------------------------------------
// Calendly (0084): the meetings on my Calendly
// accounts, one account at a time, coming or past, by day. A meeting opens
// with who it's with and its link, and can be cancelled (Calendly tells them).
// Book a meeting: an event type, a day, one of its open times, and who it's
// with; Calendly emails them the invite and the link (a paid Calendly plan
// only). Booking links: an event type's page, for people to pick a time.
// -----------------------------------------------------------------------------

type Range = "coming" | "past";

export default function CalendlyPage() {
  const conns = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const accounts = conns.data?.calendly ?? [];
  if (conns.isLoading) return <PageSpinner />;
  if (!accounts.length)
    return (
      <div className="p-6">
        <EmptyState
          icon={<CalendarClock size={20} />}
          title="Connect Calendly first"
          description="The meetings on your Calendly show here once it's connected, and you can book them for people from here."
          action={
            <Link to="/connections?tab=calendly">
              <Button variant="primary" iconLeft={<CalendarClock size={14} />}>
                Connect Calendly
              </Button>
            </Link>
          }
        />
      </div>
    );
  return <Meetings accounts={accounts} />;
}

const copy = async (text: string, toast: ReturnType<typeof useToast>, what = "Link") => {
  try {
    await navigator.clipboard.writeText(text);
    toast.push({ kind: "success", title: `${what} copied` });
  } catch {
    toast.push({ kind: "error", title: "Couldn't copy it" });
  }
};

function Meetings({ accounts }: { accounts: CalendlyAccount[] }) {
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === picked) ?? accounts.find((a) => a.for_bot) ?? accounts[0]!;
  const [range, setRange] = useState<Range>("coming");
  const [booking, setBooking] = useState(false);
  const [open, setOpen] = useState<CalendlyMeeting | null>(null);
  const today = cairoToday();
  const from = range === "coming" ? today : addDays(today, -60);
  const to = range === "coming" ? addDays(today, 90) : today;

  const q = useQuery({
    queryKey: ["calendly", "meetings", account.id, range],
    queryFn: () => fetchCalendlyMeetings(account.id, from, to),
    refetchInterval: 60_000,
  });
  const types = useQuery({ queryKey: ["calendly", "types", account.id], queryFn: () => fetchCalendlyEventTypes(account.id), staleTime: 5 * 60_000 });

  const now = Date.now();
  const shown = useMemo(() => {
    const list = (q.data ?? []).filter((m) => (range === "coming" ? Date.parse(m.end) >= now : Date.parse(m.end) < now));
    if (range === "past") list.reverse();
    const days = new Map<string, CalendlyMeeting[]>();
    for (const m of list) {
      const d = cairoToday(new Date(m.start));
      days.set(d, [...(days.get(d) ?? []), m]);
    }
    return [...days.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, range]);
  const count = shown.reduce((n, [, ms]) => n + ms.length, 0);

  const tabs: LineTab<Range>[] = [
    { value: "coming", label: "Coming" },
    { value: "past", label: "Past" },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <PageTitle count={q.data && plural(count, range === "coming" ? "coming" : "past", range === "coming" ? "coming" : "past")}>Calendly</PageTitle>
            <p className="text-sm text-muted mt-1 hidden sm:block">The meetings on your Calendly. Calendly emails each one the invite and the link.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Menu
              align="right"
              trigger={
                <Button size="sm" iconLeft={<Link2 size={14} />}>
                  Booking links
                </Button>
              }
            >
              {(close) =>
                types.isLoading ? (
                  <div className="px-3 py-2 text-sm text-muted">Loading…</div>
                ) : !types.data?.length ? (
                  <div className="px-3 py-2 text-sm text-muted">{types.error ? (types.error as Error).message : "No event types on this Calendly."}</div>
                ) : (
                  types.data.map((t) => (
                    <MenuItem
                      key={t.uri}
                      onClick={() => {
                        close();
                        void copy(t.url, toast, `${t.name} link`);
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Copy size={13} /> {t.name} ({lengthText(t.minutes)})
                      </span>
                    </MenuItem>
                  ))
                )
              }
            </Menu>
            <Button size="sm" variant="primary" iconLeft={<Plus size={14} />} onClick={() => setBooking(true)}>
              Book a meeting
            </Button>
          </div>
        </div>

        {accounts.length > 1 && (
          <PillTabs
            value={account.id}
            tabs={accounts.map((a) => ({ value: a.id, label: a.email ?? a.name ?? "Calendly" }))}
            onChange={setPicked}
            label="Calendly accounts"
            scroll
            className="mb-4"
          />
        )}
        <div className="mb-5 border-b border-border">
          <LineTabs value={range} tabs={tabs} onChange={setRange} label="Meetings" bare />
        </div>

        <div key={`${account.id}:${range}`} className="view-enter space-y-8">
          {q.isLoading ? (
            <div className="py-12 flex justify-center">
              <LogoLoader width={64} />
            </div>
          ) : q.error && !q.data ? (
            <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the meetings" description={(q.error as Error).message} />
          ) : !shown.length ? (
            <EmptyState
              icon={<CalendarClock size={20} />}
              title={range === "coming" ? "Nothing booked yet" : "No meetings in the last 2 months"}
              description={range === "coming" ? "Meetings people book on your Calendly, and the ones you book here or from WhatsApp, show up here." : undefined}
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

      {booking && <BookModal account={account} onClose={() => setBooking(false)} />}
      {open && <MeetingModal account={account} meeting={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function MeetingRow({ m, i, past, onOpen }: { m: CalendlyMeeting; i: number; past: boolean; onOpen: () => void }) {
  const toast = useToast();
  return (
    <li style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className={cn("rise", ROW, "-mx-2 px-2 flex items-center gap-3 min-w-0", past && "opacity-70")}>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left flex items-center gap-4">
        <div className="w-20 shrink-0">
          <div className="text-sm font-semibold text-ink tabular-nums">{timeText(m.start)}</div>
          <div className="text-xs text-subtle">{lengthText(m.minutes)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink truncate">{m.name}</span>
            {m.whatsapp && (
              <Badge tone="success">
                <MessageCircle size={10} /> WhatsApp
              </Badge>
            )}
          </div>
          <div className="text-sm text-muted truncate">{[m.with && `With ${m.with}`, placeName(m.location)].filter(Boolean).join(" · ") || "Open for who's in it"}</div>
        </div>
      </button>
      {m.join_url && !past && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void copy(m.join_url!, toast)}
            title="Copy the link"
            aria-label="Copy the link"
            className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
          >
            <Copy size={15} />
          </button>
          <a href={m.join_url} target="_blank" rel="noreferrer">
            <Button size="sm" iconLeft={<ExternalLink size={13} />}>
              Join
            </Button>
          </a>
        </div>
      )}
    </li>
  );
}

function MeetingModal({ account, meeting, onClose }: { account: CalendlyAccount; meeting: CalendlyMeeting; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["calendly", "meeting", account.id, meeting.id], queryFn: () => fetchCalendlyMeeting(account.id, meeting.id) });
  const m = q.data ?? { ...meeting, place: null, password: null, invitees: [] };
  const coming = Date.parse(meeting.end) >= Date.now();
  const cancel = useMutation({
    mutationFn: () => cancelCalendly(account.id, meeting.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["calendly", "meetings"] });
      toast.push({ kind: "success", title: "Cancelled", description: "Calendly told them." });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't cancel it", description: e.message }),
  });
  const who = m.invitees.filter((i) => i.status === "active");

  return (
    <Modal
      open
      onClose={onClose}
      title={m.name}
      footer={
        coming && (
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              variant="ghost"
              iconLeft={<Trash2 size={14} />}
              loading={cancel.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: "Cancel this meeting?",
                  message: who.length ? `Calendly tells ${who.map((i) => i.name || i.email).join(", ")}.` : "Calendly tells whoever booked it.",
                  confirmLabel: "Cancel meeting",
                  danger: true,
                });
                if (ok) cancel.mutate();
              }}
            >
              Cancel meeting
            </Button>
            {m.join_url && (
              <a href={m.join_url} target="_blank" rel="noreferrer">
                <Button variant="primary" iconLeft={<ExternalLink size={14} />}>
                  Join
                </Button>
              </a>
            )}
          </div>
        )
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
            {m.whatsapp ? ` · Booked from WhatsApp (${m.whatsapp})` : ""}
          </div>
        </div>
        {m.join_url && (
          <div className="flex items-center gap-2 min-w-0">
            <a href={m.join_url} target="_blank" rel="noreferrer" className="text-accent hover:underline truncate">
              {m.join_url}
            </a>
            <button type="button" onClick={() => void copy(m.join_url!, toast)} aria-label="Copy the link" className="h-8 w-8 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink">
              <Copy size={14} />
            </button>
          </div>
        )}
        {m.password && <div className="text-muted">Passcode {m.password}</div>}
        {m.place && !m.join_url && <div className="text-muted">{m.place}</div>}
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-subtle mb-1.5">With</div>
          {q.isLoading ? (
            <Spinner />
          ) : q.error ? (
            <div className="text-danger">{(q.error as Error).message}</div>
          ) : !m.invitees.length ? (
            <div className="text-muted">Nobody yet.</div>
          ) : (
            <ul className="space-y-2">
              {m.invitees.map((i) => (
                <li key={i.email} className={cn(i.status !== "active" && "opacity-60")}>
                  <div className="text-ink font-medium">
                    {i.name} <span className="text-muted font-normal">{i.email}</span>
                    {i.status !== "active" && <span className="text-xs text-subtle"> (cancelled)</span>}
                  </div>
                  {i.answers.map((a) => (
                    <div key={a.question} className="text-muted whitespace-pre-wrap">
                      <span className="text-subtle">{a.question}:</span> {a.answer}
                    </div>
                  ))}
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

function BookModal({ account, onClose }: { account: CalendlyAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useQuery({ queryKey: ["calendly", "types", account.id], queryFn: () => fetchCalendlyEventTypes(account.id), staleTime: 5 * 60_000 });
  const [typePicked, setType] = useState<string>("");
  const eventType = typePicked || account.event_type || types.data?.[0]?.uri || "";
  const [day, setDay] = useState(cairoToday());
  const [time, setTime] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guests, setGuests] = useState("");
  const [note, setNote] = useState("");
  const times = useQuery({
    queryKey: ["calendly", "times", account.id, eventType, day],
    queryFn: () => fetchOpenTimes(account.id, eventType, day),
    enabled: !!eventType && !!day,
  });
  const guestList = guests
    .split(/[\s,;]+/)
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const badGuest = guestList.find((g) => !emailOk(g));
  const ok = !!time && emailOk(email.trim()) && !badGuest;

  const book = useMutation({
    mutationFn: () =>
      bookCalendly(account.id, { event_type: eventType, start: time!, name: name.trim(), email: email.trim().toLowerCase(), guests: guestList, note: note.trim() }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["calendly", "meetings"] });
      toast.push({ kind: "success", title: "Booked", description: `Calendly emailed ${email.trim()}${r.join_url ? " the invite and the link" : " the invite"}.` });
      onClose();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't book it", description: e.message }),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Book a meeting"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} loading={book.isPending} onClick={() => book.mutate()}>
            Book
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">Calendly emails them the invite and the link. Booking for someone needs a paid Calendly plan (Standard or higher).</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Meeting</Label>
            <Select
              value={eventType}
              onChange={(v) => {
                setType(v);
                setTime(null);
              }}
              options={(types.data ?? []).map((t) => ({ value: t.uri, label: `${t.name} (${lengthText(t.minutes)})` }))}
              placeholder={types.isLoading ? "Loading…" : "No event types"}
              aria-label="Event type"
            />
            {types.error && <Hint>{(types.error as Error).message}</Hint>}
          </div>
          <div>
            <Label>Day</Label>
            <DateField
              value={day}
              onChange={(v) => {
                if (v) setDay(v);
                setTime(null);
              }}
              min={cairoToday()}
              clearable={false}
              aria-label="Day"
            />
          </div>
        </div>
        <div>
          <Label>Time (Cairo)</Label>
          {times.isLoading ? (
            <div className="py-3">
              <Spinner />
            </div>
          ) : times.error ? (
            <div className="text-sm text-danger">{(times.error as Error).message}</div>
          ) : !times.data?.length ? (
            <div className="text-sm text-muted py-1">Nothing open that day.</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {times.data.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTime(t)}
                  className={cn(
                    "h-9 px-3 rounded-md border text-sm tabular-nums transition-colors",
                    time === t ? "bg-accent border-accent text-white" : "border-border text-ink hover:bg-inset",
                  )}
                >
                  {timeText(t)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cal-name">Their name</Label>
            <Input id="cal-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sara Ali" />
          </div>
          <div>
            <Label htmlFor="cal-email">Their email</Label>
            <Input id="cal-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sara@example.com" />
          </div>
        </div>
        <div>
          <Label htmlFor="cal-guests">More people (optional)</Label>
          <Input id="cal-guests" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="Emails, separated by commas" />
          {badGuest && <Hint>{badGuest} doesn't look like an email.</Hint>}
        </div>
        <div>
          <Label htmlFor="cal-note">What it's about (optional)</Label>
          <Textarea id="cal-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          <Hint>Goes in the first question on your Calendly booking form, when it has one.</Hint>
        </div>
      </div>
    </Modal>
  );
}
