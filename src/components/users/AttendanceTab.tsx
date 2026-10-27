import { Fragment, useMemo, useState } from "react";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, Download, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { InfoTip } from "@/components/ui/InfoTip";
import { Pager, usePaged } from "@/components/ui/Pager";
import { PillTabs } from "@/components/ui/PillTabs";
import { Section, Stat, StatStrip } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { LogoLoader } from "@/components/ui/Spinner";
import { Steps } from "@/components/home/MyAttendance";
import { TeamAttendance } from "@/components/home/TeamAttendance";
import { cn } from "@/lib/cn";
import { saveBlob } from "@/lib/nativeApp";
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
// Attendance (admins, a tab on the Users page): the team's day, any day (who
// came, when they left, their breaks; today live), and a report over days.
// The report counts the "team days" (days anyone on the team logged in) and,
// for each person: the days they came and missed, time worked and on breaks
// (a day's average too), when they usually came and left (and the earliest
// and latest), and the days they didn't log out. A chart shows the hours
// worked each day; pick a person for theirs and their days one by one. The
// whole report downloads as a CSV.
// -----------------------------------------------------------------------------

type View = "day" | "report";
type Preset = "week" | "last-week" | "month" | "last-month" | "custom";

/** The longest stretch a report covers (one call per day). */
const MAX_DAYS = 62;

const VIEWS = [
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

/** Minutes after Cairo midnight. */
function clockMinutes(iso: string) {
  const [h, m] = new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number);
  return h! * 60 + m!;
}

/** Minutes after midnight as "9:12 AM". */
function clockText(min: number) {
  const d = new Date(Date.UTC(2000, 0, 1, Math.floor(min / 60), min % 60));
  return d.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}

/** The average, earliest and latest clock time of some times. */
function clockStats(times: string[]) {
  if (!times.length) return null;
  const mins = times.map(clockMinutes);
  return {
    avg: clockText(Math.round(mins.reduce((a, b) => a + b, 0) / mins.length)),
    min: clockText(Math.min(...mins)),
    max: clockText(Math.max(...mins)),
  };
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "-");
const breakCount = (sessions: WorkSession[]) => sessions.reduce((n, s) => n + s.breaks.length, 0);

interface DayRow {
  day: string;
  sessions: WorkSession[];
  worked: number;
  breaks: number;
  /** Breaks taken that day. */
  taken: number;
  missed: boolean;
}

interface PersonReport {
  id: string;
  name: string;
  avatar_url: string | null;
  /** Each day of the report they logged in on. */
  days: DayRow[];
  worked: number;
  breaks: number;
  taken: number;
  missed: number;
  /** Days with time that counts (not only a session nobody logged out of). */
  counted: number;
  longest: number;
  ins: ReturnType<typeof clockStats>;
  outs: ReturnType<typeof clockStats>;
}

export function AttendanceTab() {
  const [view, setView] = useState<View>("day");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <PillTabs value={view} tabs={VIEWS} onChange={setView} label="Attendance view" />
        <InfoTip text="When each team member logged in and out, and their breaks. Admins don't log attendance. A session nobody logged out of is closed by the system the next morning and doesn't count towards the time worked." />
      </div>
      {view === "day" ? <TeamAttendance detailed /> : <Report />}
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
  const cut = from <= to && days.length === MAX_DAYS && addDays(from, MAX_DAYS - 1) < to;
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

  const { people, teamDays } = useMemo(() => {
    const byId = new Map<string, PersonReport>();
    const came = new Set<string>();
    const now = Date.now();
    qs.forEach((q, i) => {
      const day = days[i]!;
      for (const p of (q.data ?? []) as PersonDay[]) {
        const r =
          byId.get(p.id) ??
          ({ id: p.id, name: p.name, avatar_url: p.avatar_url, days: [], worked: 0, breaks: 0, taken: 0, missed: 0, counted: 0, longest: 0, ins: null, outs: null } as PersonReport);
        byId.set(p.id, r);
        if (!p.sessions.length) continue;
        came.add(day);
        const t = totals(p.sessions, now);
        const row: DayRow = { day, sessions: p.sessions, worked: t.worked, breaks: t.breaks, taken: breakCount(p.sessions), missed: p.sessions.some((s) => s.auto) };
        r.days.push(row);
        r.worked += t.worked;
        r.breaks += t.breaks;
        r.taken += row.taken;
        r.longest = Math.max(r.longest, t.worked);
        if (row.missed) r.missed += 1;
        if (p.sessions.some((s) => !s.auto)) r.counted += 1;
      }
    });
    for (const r of byId.values()) {
      r.ins = clockStats(r.days.map((d) => dayBounds(d.sessions).first).filter((x): x is string => !!x));
      r.outs = clockStats(r.days.map((d) => dayBounds(d.sessions).last).filter((x): x is string => !!x && x !== "missed"));
    }
    return {
      people: [...byId.values()].sort((a, b) => b.days.length - a.days.length || a.name.localeCompare(b.name)),
      teamDays: came.size,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs.map((q) => q.dataUpdatedAt).join(","), days]);

  const shown = who ? people.filter((p) => p.id === who) : people;
  const paged = usePaged(shown, "attendance");
  const sum = shown.reduce(
    (a, p) => ({
      days: a.days + p.days.length,
      counted: a.counted + p.counted,
      worked: a.worked + p.worked,
      breaks: a.breaks + p.breaks,
      missed: a.missed + p.missed,
      absent: a.absent + Math.max(0, teamDays - p.days.length),
    }),
    { days: 0, counted: 0, worked: 0, breaks: 0, missed: 0, absent: 0 },
  );
  const expected = shown.length * teamDays;

  // The chart: hours worked each day, by everyone shown.
  const points = useMemo(
    () =>
      days.map((day) => {
        const rows = shown.flatMap((p) => p.days.filter((d) => d.day === day).map((d) => ({ p, d })));
        return {
          day,
          worked: rows.reduce((n, x) => n + x.d.worked, 0),
          breaks: rows.reduce((n, x) => n + x.d.breaks, 0),
          people: rows.length,
          bounds: rows.length === 1 ? dayBounds(rows[0]!.d.sessions) : null,
        };
      }),
    [days, shown],
  );

  const download = () => {
    const h = (ms: number) => (ms / 3_600_000).toFixed(2);
    const lines: (string | number)[][] = [
      ["Person", "Days", "Team days", "Attendance", "Absent", "Hours worked", "Average day (hours)", "Hours on breaks", "Breaks taken", "Usually in", "Usually out", "Earliest in", "Latest in", "Didn't log out"],
      ...shown.map((p) => [
        p.name,
        p.days.length,
        teamDays,
        pct(p.days.length, teamDays),
        Math.max(0, teamDays - p.days.length),
        h(p.worked),
        p.counted ? h(p.worked / p.counted) : "",
        h(p.breaks),
        p.taken,
        p.ins?.avg ?? "",
        p.outs?.avg ?? "",
        p.ins?.min ?? "",
        p.ins?.max ?? "",
        p.missed,
      ]),
      [],
      ["Person", "Day", "In", "Out", "Hours worked", "Hours on breaks", "Breaks taken", "Didn't log out"],
      ...shown.flatMap((p) =>
        p.days.map((d) => {
          const b = dayBounds(d.sessions);
          return [p.name, d.day, b.first ? timeText(b.first) : "", b.last === "missed" ? "" : b.last ? timeText(b.last) : "Still in", h(d.worked), h(d.breaks), d.taken, d.missed ? "Yes" : ""];
        }),
      ),
    ];
    const csv = lines.map((l) => l.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(",")).join("\r\n");
    const name = who ? `${shown[0]?.name ?? "person"} ` : "";
    void saveBlob(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }), `Attendance ${name}${from} to ${to}.csv`);
  };

  return (
    <Section
      title="Report"
      info="Team days are the days anyone on the team logged in; absent counts the team days someone didn't. Time worked doesn't count breaks, or sessions nobody logged out of. Usual times are the average of the days they came."
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
          <Button size="sm" variant="secondary" iconLeft={<Download size={15} />} onClick={download} disabled={!shown.length} title="Download this report as a CSV file">
            <span className="hidden sm:inline">CSV</span>
          </Button>
        </div>
      }
    >
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PillTabs value={preset === "custom" ? ("" as Preset) : preset} tabs={PRESETS} onChange={setPreset} label="Days" scroll />
        <div className="flex w-full items-center gap-2 sm:w-auto">
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
            className="min-w-0 flex-1 sm:w-36 sm:flex-none"
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
            className="min-w-0 flex-1 sm:w-36 sm:flex-none"
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
            <Stat label="Attendance" value={pct(sum.days, expected)} hint={`${sum.days} of ${expected} days`} />
            <Stat label="Absent" value={sum.absent} hint={`${teamDays} team day${teamDays === 1 ? "" : "s"}`} tone={sum.absent ? "warn" : undefined} />
            <Stat label="Time worked" value={hm(sum.worked)} tone="success" />
            <Stat label="Average day" value={sum.counted ? hm(sum.worked / sum.counted) : "-"} />
            <Stat label="Breaks a day" value={sum.days ? hm(sum.breaks / sum.days) : "-"} hint={`${hm(sum.breaks)} in all`} />
            <Stat label="Didn't log out" value={sum.missed} tone={sum.missed ? "warn" : undefined} />
          </StatStrip>

          <HoursChart points={points} single={!!who} />

          <div className="mt-5 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[1240px] table-fixed text-base border-separate border-spacing-0">
              <colgroup>
                <col />
                <col className="w-[7.5rem]" />
                <col className="w-[5.5rem]" />
                <col className="w-[8rem]" />
                <col className="w-[7.5rem]" />
                <col className="w-[9rem]" />
                <col className="w-[9.5rem]" />
                <col className="w-[9.5rem]" />
                <col className="w-[8.5rem]" />
              </colgroup>
              <thead>
                <tr className="bg-inset text-subtle text-xs uppercase tracking-eyebrow">
                  <th scope="col" className={TH}>Person</th>
                  <th scope="col" className={TH}>Days</th>
                  <th scope="col" className={TH}>Absent</th>
                  <th scope="col" className={TH}>Worked</th>
                  <th scope="col" className={TH}>Average day</th>
                  <th scope="col" className={TH}>Breaks</th>
                  <th scope="col" className={TH}>Usually in</th>
                  <th scope="col" className={TH}>Usually out</th>
                  <th scope="col" className={TH}>Didn't log out</th>
                </tr>
              </thead>
              <tbody>
                {paged.rows.map((p) => {
                  const expanded = !!who || open === p.id;
                  const absent = Math.max(0, teamDays - p.days.length);
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={cn("transition-colors", p.days.length && "cursor-pointer hover:bg-hover")}
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
                        <td className={TD}>
                          <span className="tabular-nums text-ink">{p.days.length}</span>
                          <span className={SUB}>{pct(p.days.length, teamDays)} attended</span>
                        </td>
                        <td className={cn(TD, "tabular-nums", absent ? "text-warn font-medium" : "text-muted")}>{absent}</td>
                        <td className={cn(TD, "tabular-nums text-ink")}>
                          {p.days.length ? hm(p.worked) : "-"}
                          {p.longest > 0 && <span className={SUB}>Longest {hm(p.longest)}</span>}
                        </td>
                        <td className={cn(TD, "tabular-nums text-ink")}>{p.counted ? hm(p.worked / p.counted) : "-"}</td>
                        <td className={cn(TD, "tabular-nums text-ink")}>
                          {p.days.length ? hm(p.breaks) : "-"}
                          {p.taken > 0 && (
                            <span className={SUB}>
                              {p.taken} taken, {hm(p.breaks / p.taken)} each
                            </span>
                          )}
                        </td>
                        <td className={cn(TD, "tabular-nums text-ink")}>
                          {p.ins?.avg ?? "-"}
                          {p.ins && p.days.length > 1 && (
                            <span className={SUB}>
                              {p.ins.min} to {p.ins.max}
                            </span>
                          )}
                        </td>
                        <td className={cn(TD, "tabular-nums text-ink")}>
                          {p.outs?.avg ?? "-"}
                          {p.outs && p.days.length > 1 && (
                            <span className={SUB}>
                              {p.outs.min} to {p.outs.max}
                            </span>
                          )}
                        </td>
                        <td className={cn(TD, "tabular-nums", p.missed ? "text-warn font-medium" : "text-muted")}>{p.missed}</td>
                      </tr>
                      {expanded &&
                        p.days.map((d) => {
                          const b = dayBounds(d.sessions);
                          return (
                            <tr key={d.day} className="bg-inset/40">
                              <td className={cn(TD, "pl-12")}>
                                <div className="text-ink tabular-nums">{shortDay(d.day)}</div>
                                <Steps sessions={d.sessions} className="mt-0.5 text-xs text-muted" />
                              </td>
                              <td className={TD} />
                              <td className={TD} />
                              <td className={cn(TD, "tabular-nums text-ink")}>{hm(d.worked)}</td>
                              <td className={TD} />
                              <td className={cn(TD, "tabular-nums text-muted")}>
                                {hm(d.breaks)}
                                {d.taken > 0 && <span className={SUB}>{d.taken} taken</span>}
                              </td>
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
          <Pager {...paged.pager} />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ chart --

interface Point {
  day: string;
  worked: number;
  breaks: number;
  people: number;
  /** One person's day: when they came and left. */
  bounds: ReturnType<typeof dayBounds> | null;
}

/** A round top for the hours axis, and its ticks. */
function hourTicks(maxMs: number) {
  const top = Math.max(1, maxMs / 3_600_000);
  const step = [1, 2, 4, 5, 10, 20, 25, 50, 100, 200].find((s) => top / s <= 4) ?? 500;
  const max = Math.ceil(top / step) * step;
  return { max, ticks: Array.from({ length: max / step + 1 }, (_, i) => i * step) };
}

/** Hours worked each day of the report (everyone shown, or one person), one bar a day; hover a day for its figures. */
function HoursChart({ points, single }: { points: Point[]; single: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const { max, ticks } = hourTicks(Math.max(0, ...points.map((p) => p.worked)));
  const every = Math.max(1, Math.ceil(points.length / 10));
  const short = points.length <= 7;
  const h = hover != null ? points[hover] : null;
  return (
    <figure className="mt-5">
      <figcaption className="text-sm font-semibold text-ink">{single ? "Hours worked each day" : "Team hours worked each day"}</figcaption>
      <div className="mt-3 flex gap-2">
        {/* The hours axis. */}
        <div className="relative w-8 shrink-0 h-40 text-[11px] text-subtle tabular-nums">
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 leading-none" style={{ bottom: `${(t / max) * 100}%`, transform: "translateY(50%)" }}>
              {t}h
            </span>
          ))}
        </div>
        <div className="relative flex-1 min-w-0" onMouseLeave={() => setHover(null)}>
          <div className="relative h-40">
            {ticks.map((t) => (
              <div key={t} className={cn("absolute inset-x-0 border-t", t ? "border-line" : "border-rule")} style={{ bottom: `${(t / max) * 100}%` }} />
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {points.map((p, i) => (
                <div
                  key={p.day}
                  tabIndex={0}
                  aria-label={`${shortDay(p.day)}: ${p.worked ? hm(p.worked) : "nobody worked"}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className="relative h-full flex-1 min-w-0 flex items-end outline-none focus-visible:bg-inset/70"
                >
                  {p.worked > 0 && (
                    <div
                      className={cn("w-full rounded-t-[4px] bg-accent transition-opacity", hover != null && hover !== i && "opacity-50")}
                      style={{ height: `${Math.max(1.5, (p.worked / 3_600_000 / max) * 100)}%` }}
                    />
                  )}
                </div>
              ))}
            </div>
            {h && (
              <div
                role="tooltip"
                className="pointer-events-none absolute top-0 z-10 w-max max-w-[14rem] rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-pop"
                // Beside the day's bar, never over it.
                style={hover! < points.length / 2 ? { left: `calc(${((hover! + 1) / points.length) * 100}% + 8px)` } : { right: `calc(${((points.length - hover!) / points.length) * 100}% + 8px)` }}
              >
                <div className="font-semibold text-ink">{shortDay(h.day)}</div>
                {h.people ? (
                  <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-muted tabular-nums">
                    <dt>Worked</dt>
                    <dd className="text-ink">{hm(h.worked)}</dd>
                    <dt>Breaks</dt>
                    <dd className="text-ink">{hm(h.breaks)}</dd>
                    {single && h.bounds ? (
                      <>
                        <dt>In</dt>
                        <dd className="text-ink">{h.bounds.first ? timeText(h.bounds.first) : "-"}</dd>
                        <dt>Out</dt>
                        <dd className="text-ink">{h.bounds.last === "missed" ? "Missed" : h.bounds.last ? timeText(h.bounds.last) : "Still in"}</dd>
                      </>
                    ) : (
                      <>
                        <dt>People in</dt>
                        <dd className="text-ink">{h.people}</dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <div className="mt-0.5 text-muted">{single ? "Didn't come" : "Nobody logged in"}</div>
                )}
              </div>
            )}
          </div>
          {/* The days. */}
          <div className="mt-1.5 flex gap-[2px] text-[11px] text-subtle">
            {points.map((p, i) => (
              <span key={p.day} className="flex-1 min-w-0 text-center whitespace-nowrap overflow-visible">
                {i % every === 0 ? (short ? shortDay(p.day).split(" ")[0] : shortDay(p.day).split(" ").slice(1).join(" ")) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

const TH = "text-left font-semibold px-4 py-3 border-b border-border whitespace-nowrap";
const TD = "px-4 py-3 border-b border-line align-middle";
const SUB = "mt-0.5 block truncate text-xs text-subtle";
