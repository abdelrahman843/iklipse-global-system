import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageTitle } from "@/components/ui/PageTitle";
import { PillTabs } from "@/components/ui/PillTabs";
import { Section, Stat, StatStrip } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { LogoLoader } from "@/components/ui/Spinner";
import { Steps } from "@/components/home/MyAttendance";
import { TeamAttendance } from "@/components/home/TeamAttendance";
import { cn } from "@/lib/cn";
import {
  addDays,
  cairoToday,
  dayBounds,
  fetchAttendanceDay,
  hm,
  timeText,
  totals,
  type PersonDay,
  type WorkSession,
} from "@/lib/attendanceApi";

// -----------------------------------------------------------------------------
// Attendance (admins): the team's day, any day (who came, when they left,
// their breaks; today live), and a report over days: each person's days,
// time worked and on breaks, when they usually came and left, and the days
// they didn't log out. Pick a person for their days one by one.
// -----------------------------------------------------------------------------

type Tab = "day" | "report";
type Preset = "week" | "last-week" | "month" | "last-month" | "custom";

/** The longest stretch a report covers (one call per day). */
const MAX_DAYS = 62;

const TABS = [
  { value: "day" as const, label: "Day" },
  { value: "report" as const, label: "Report" },
];

const PRESETS = [
  { value: "week" as const, label: "This week" },
  { value: "last-week" as const, label: "Last week" },
  { value: "month" as const, label: "This month" },
  { value: "last-month" as const, label: "Last month" },
];

/** Saturday 0 ... Friday 6: the work week starts on Saturday in Cairo. */
const weekday = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 1) % 7;

function rangeOf(p: Exclude<Preset, "custom">, today: string): [string, string] {
  if (p === "week") return [addDays(today, -weekday(today)), today];
  if (p === "last-week") {
    const start = addDays(today, -weekday(today) - 7);
    return [start, addDays(start, 6)];
  }
  const first = `${today.slice(0, 7)}-01`;
  if (p === "month") return [first, today];
  const lastEnd = addDays(first, -1);
  return [`${lastEnd.slice(0, 7)}-01`, lastEnd];
}

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < MAX_DAYS; d = addDays(d, 1)) out.push(d);
  return out;
}

/** "Sun 18 Oct". */
function shortDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

/** The average clock time of some times (minutes after Cairo midnight), as "9:12 AM". */
function avgClock(times: string[]) {
  if (!times.length) return "-";
  const mins = times.map((iso) => {
    const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
    return h! * 60 + m!;
  });
  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(avg / 60), avg % 60));
  return d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}

interface PersonReport {
  id: string;
  name: string;
  avatar_url: string | null;
  /** Each day of the report they logged in on. */
  days: { day: string; sessions: WorkSession[] }[];
  worked: number;
  breaks: number;
  missed: number;
  avgIn: string;
  avgOut: string;
}

export default function AttendancePage() {
  const [tab, setTab] = useState<Tab>("day");
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PageTitle info="When each team member logged in and out, and their breaks. Admins don't log attendance. A session nobody logged out of is closed by the system the next morning and doesn't count towards the time worked.">
            Attendance
          </PageTitle>
          <PillTabs value={tab} tabs={TABS} onChange={setTab} label="View" />
        </div>
        {tab === "day" ? <TeamAttendance /> : <Report />}
      </div>
    </div>
  );
}

function Report() {
  const today = cairoToday();
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState<[string, string]>(() => rangeOf("month", today));
  const [from, to] = preset === "custom" ? custom : rangeOf(preset, today);
  const [who, setWho] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const days = useMemo(() => daysBetween(from, to), [from, to]);
  const cut = from <= to && daysBetween(from, to).length === MAX_DAYS && addDays(from, MAX_DAYS - 1) < to;
  const qs = useQueries({
    queries: days.map((day) => ({
      queryKey: ["attendance", "day", day],
      queryFn: () => fetchAttendanceDay(day),
      // Past days don't change.
      staleTime: day === today ? 30_000 : 10 * 60_000,
      placeholderData: keepPreviousData,
    })),
  });
  const loading = qs.some((q) => q.isLoading);
  const error = qs.find((q) => q.error)?.error as Error | undefined;

  const people = useMemo(() => {
    const byId = new Map<string, PersonReport>();
    const now = Date.now();
    qs.forEach((q, i) => {
      for (const p of (q.data ?? []) as PersonDay[]) {
        const r =
          byId.get(p.id) ??
          ({ id: p.id, name: p.name, avatar_url: p.avatar_url, days: [], worked: 0, breaks: 0, missed: 0, avgIn: "-", avgOut: "-" } as PersonReport);
        byId.set(p.id, r);
        if (!p.sessions.length) continue;
        const t = totals(p.sessions, now);
        r.days.push({ day: days[i]!, sessions: p.sessions });
        r.worked += t.worked;
        r.breaks += t.breaks;
        if (p.sessions.some((s) => s.auto)) r.missed += 1;
      }
    });
    for (const r of byId.values()) {
      const ins = r.days.map((d) => dayBounds(d.sessions).first).filter((x): x is string => !!x);
      const outs = r.days.map((d) => dayBounds(d.sessions).last).filter((x): x is string => !!x && x !== "missed");
      r.avgIn = avgClock(ins);
      r.avgOut = avgClock(outs);
    }
    return [...byId.values()].sort((a, b) => b.days.length - a.days.length || a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs.map((q) => q.dataUpdatedAt).join(","), days]);

  const shown = who ? people.filter((p) => p.id === who) : people;
  const sum = shown.reduce((a, p) => ({ days: a.days + p.days.length, worked: a.worked + p.worked, breaks: a.breaks + p.breaks, missed: a.missed + p.missed }), {
    days: 0,
    worked: 0,
    breaks: 0,
    missed: 0,
  });

  return (
    <Section
      title="Report"
      info="Time worked doesn't count breaks, or sessions nobody logged out of. The usual times are the average of the days they came."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={who}
            onChange={setWho}
            options={[{ value: "", label: "Everyone" }, ...people.map((p) => ({ value: p.id, label: p.name }))]}
            searchable
            aria-label="Person"
            className="w-44"
          />
        </div>
      }
    >
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PillTabs value={preset === "custom" ? ("" as Preset) : preset} tabs={PRESETS} onChange={setPreset} label="Days" scroll />
        <div className="flex items-center gap-2">
          <DateField
            value={from}
            max={to < today ? to : today}
            clearable={false}
            onChange={(v) => {
              if (!v) return;
              setCustom([v, to]);
              setPreset("custom");
            }}
            aria-label="From"
            className="w-36"
          />
          <span className="text-sm text-subtle">to</span>
          <DateField
            value={to}
            min={from}
            max={today}
            clearable={false}
            align="right"
            onChange={(v) => {
              if (!v) return;
              setCustom([from, v]);
              setPreset("custom");
            }}
            aria-label="To"
            className="w-36"
          />
        </div>
      </div>
      {cut && <p className="mt-2 text-sm text-warn">A report covers up to {MAX_DAYS} days: it stops on {shortDay(days[days.length - 1]!)}.</p>}

      {loading && !people.length ? (
        <div className="py-10 flex justify-center">
          <LogoLoader width={64} />
        </div>
      ) : error && !people.length ? (
        <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the attendance" description={error.message} />
      ) : !shown.length ? (
        <EmptyState icon={<Users size={20} />} title="No team members yet" description="Members you add on the Users page show up here." />
      ) : (
        <div className={cn("transition-opacity", loading && "opacity-60")}>
          <StatStrip className="mt-4">
            <Stat label="Days worked" value={sum.days} />
            <Stat label="Time worked" value={hm(sum.worked)} tone="success" />
            <Stat label="On breaks" value={hm(sum.breaks)} />
            <Stat label="Didn't log out" value={sum.missed} tone={sum.missed ? "warn" : undefined} />
          </StatStrip>

          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[760px] table-fixed text-base border-separate border-spacing-0">
              <colgroup>
                <col />
                <col className="w-[6rem]" />
                <col className="w-[8rem]" />
                <col className="w-[8rem]" />
                <col className="w-[8rem]" />
                <col className="w-[8rem]" />
                <col className="w-[8rem]" />
              </colgroup>
              <thead>
                <tr className="bg-inset text-subtle text-xs uppercase tracking-eyebrow">
                  <th scope="col" className={TH}>Person</th>
                  <th scope="col" className={TH}>Days</th>
                  <th scope="col" className={TH}>Worked</th>
                  <th scope="col" className={TH}>Breaks</th>
                  <th scope="col" className={TH}>Usually in</th>
                  <th scope="col" className={TH}>Usually out</th>
                  <th scope="col" className={TH}>Didn't log out</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const expanded = !!who || open === p.id;
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={cn("transition-colors", p.days.length && "cursor-pointer hover:bg-inset/70")}
                        onClick={() => p.days.length && !who && setOpen(expanded ? null : p.id)}
                      >
                        <td className={TD}>
                          <span className="flex min-w-0 items-center gap-2.5">
                            {!who && (
                              <span className="w-4 shrink-0 text-subtle">
                                {p.days.length ? expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : null}
                              </span>
                            )}
                            <Avatar src={p.avatar_url} name={p.name} size={28} className="shrink-0" />
                            <span className="truncate font-medium text-ink">{p.name}</span>
                          </span>
                        </td>
                        <td className={cn(TD, "tabular-nums text-ink")}>{p.days.length}</td>
                        <td className={cn(TD, "tabular-nums text-ink")}>{p.days.length ? hm(p.worked) : "-"}</td>
                        <td className={cn(TD, "tabular-nums text-muted")}>{p.days.length ? hm(p.breaks) : "-"}</td>
                        <td className={cn(TD, "tabular-nums text-muted")}>{p.avgIn}</td>
                        <td className={cn(TD, "tabular-nums text-muted")}>{p.avgOut}</td>
                        <td className={cn(TD, "tabular-nums", p.missed ? "text-warn font-medium" : "text-muted")}>{p.missed}</td>
                      </tr>
                      {expanded &&
                        p.days.map((d) => {
                          const t = totals(d.sessions);
                          const b = dayBounds(d.sessions);
                          return (
                            <tr key={d.day} className="bg-inset/40">
                              <td className={cn(TD, "pl-12")}>
                                <div className="text-ink tabular-nums">{shortDay(d.day)}</div>
                                <Steps sessions={d.sessions} className="mt-0.5 text-xs text-muted" />
                              </td>
                              <td className={TD} />
                              <td className={cn(TD, "tabular-nums text-ink")}>{hm(t.worked)}</td>
                              <td className={cn(TD, "tabular-nums text-muted")}>{hm(t.breaks)}</td>
                              <td className={cn(TD, "tabular-nums text-muted")}>{b.first ? timeText(b.first) : "-"}</td>
                              <td className={cn(TD, "tabular-nums", b.last === "missed" ? "text-warn" : "text-muted")}>
                                {b.last === "missed" ? "Missed" : b.last ? timeText(b.last) : "Still in"}
                              </td>
                              <td className={TD} />
                            </tr>
                          );
                        })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
}

const TH = "text-left font-semibold px-4 py-3 border-b border-border whitespace-nowrap";
const TD = "px-4 py-3 border-b border-line align-middle";
