import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronLeft, ChevronRight, Users } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { DateField } from "@/components/ui/DateField";
import { EmptyState } from "@/components/ui/EmptyState";
import { LogoLoader } from "@/components/ui/Spinner";
import { ROW, ROWS, Section, Stat, StatStrip } from "@/components/ui/Section";
import { Steps } from "@/components/home/MyAttendance";
import { cn } from "@/lib/cn";
import {
  addDays,
  cairoToday,
  dayBounds,
  dayText,
  fetchAttendanceDay,
  hm,
  timeText,
  totals,
  useNow,
  type PersonDay,
} from "@/lib/attendanceApi";
import { LIVE_FALLBACK } from "@/lib/live";

/**
 * Admins: the team's day. Today: who's online, on a break or out, live; other
 * days: when each person came and left. detailed (the Attendance tab): the
 * team's time worked and on breaks too, and how many breaks each one took.
 */
export function TeamAttendance({ detailed = false }: { detailed?: boolean }) {
  const now = useNow();
  const today = cairoToday(new Date(now));
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? today;
  const isToday = day === today;
  const go = (d: string) => setPicked(d >= today ? null : d);

  const q = useQuery({
    queryKey: ["attendance", "day", day],
    queryFn: () => fetchAttendanceDay(day),
    refetchInterval: isToday ? LIVE_FALLBACK : false,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
  });

  const people = useMemo(() => {
    const rank = (p: PersonDay) =>
      isToday ? (p.status === "in" ? 0 : p.status === "break" ? 1 : p.sessions.length ? 2 : 3) : p.sessions.length ? 0 : 1;
    return [...(q.data ?? [])].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.sessions[0]?.started_at ?? "").localeCompare(b.sessions[0]?.started_at ?? "") ||
        a.name.localeCompare(b.name),
    );
  }, [q.data, isToday]);

  const came = people.filter((p) => p.sessions.length).length;
  const sum = people.reduce(
    (a, p) => {
      const t = totals(p.sessions, now);
      return { worked: a.worked + t.worked, breaks: a.breaks + t.breaks };
    },
    { worked: 0, breaks: 0 },
  );
  const firstIn = people.map((p) => p.sessions[0]?.started_at).filter((x): x is string => !!x).sort()[0];
  const more = detailed
    ? [
        { label: "Time worked", value: hm(sum.worked), tone: "success" as const, hint: came ? `${hm(sum.worked / came)} each` : undefined },
        { label: "On breaks", value: hm(sum.breaks), tone: undefined, hint: firstIn ? `First in ${timeText(firstIn)}` : undefined },
      ]
    : [];
  const stats = isToday
    ? [
        { label: "Online", value: people.filter((p) => p.status === "in").length, tone: "success" as const },
        { label: "On a break", value: people.filter((p) => p.status === "break").length, tone: "warn" as const },
        { label: "Logged out", value: people.filter((p) => p.status === "out" && p.sessions.length).length },
        { label: "Not in yet", value: people.filter((p) => p.status === "out" && !p.sessions.length).length },
        ...more,
      ]
    : [
        { label: "Came", value: came, tone: "success" as const },
        { label: "Didn't come", value: people.length - came },
        { label: "Didn't log out", value: people.filter((p) => p.sessions.some((s) => s.auto)).length, tone: "warn" as const },
        ...more,
      ];

  return (
    <Section
      title={isToday ? "Team today" : dayText(day)}
      info={isToday ? "Who's online, on a break or logged out, and when they came." : "When each person came and left that day."}
      action={
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => go(addDays(day, -1))}
            aria-label="Previous day"
            title="Previous day"
            className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
          >
            <ChevronLeft size={16} />
          </button>
          <DateField value={day} onChange={(v) => v && go(v)} max={today} clearable={false} align="right" className="w-36" aria-label="Day" />
          <button
            type="button"
            onClick={() => go(addDays(day, 1))}
            disabled={isToday}
            aria-label="Next day"
            title="Next day"
            className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-hover hover:text-ink disabled:opacity-40 disabled:pointer-events-none"
          >
            <ChevronRight size={16} />
          </button>
          {!isToday && (
            <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
              Today
            </Button>
          )}
        </div>
      }
    >
      {q.isLoading ? (
        <div className="py-10 flex justify-center">
          <LogoLoader width={64} />
        </div>
      ) : q.error && !q.data ? (
        <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the team's day" description={(q.error as Error).message} />
      ) : !people.length ? (
        <EmptyState icon={<Users size={20} />} title="No team members yet" description="Members you add on the Users page show up here." />
      ) : (
        <div className={cn("transition-opacity", q.isPlaceholderData && "opacity-60")}>
          <StatStrip className="mt-3">
            {stats.map((s, i) => (
              <Stat
                key={s.label}
                className="rise"
                style={{ "--i": i } as React.CSSProperties}
                label={s.label}
                value={s.value}
                hint={"hint" in s ? s.hint : undefined}
                tone={s.value ? s.tone : undefined}
              />
            ))}
          </StatStrip>
          <ul className={cn(ROWS, "mt-2")}>
            {people.map((p, i) => (
              <PersonRow key={p.id} p={p} i={i} live={isToday} now={now} detailed={detailed} />
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function PersonRow({ p, i, live, now, detailed }: { p: PersonDay; i: number; live: boolean; now: number; detailed: boolean }) {
  const { worked, breaks } = totals(p.sessions, now);
  const taken = p.sessions.reduce((n, s) => n + s.breaks.length, 0);
  const { first, last } = dayBounds(p.sessions);
  return (
    <li
      style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
      className={cn("rise", ROW, "-mx-2 px-2 flex flex-col gap-2.5 md:flex-row md:items-center md:gap-6")}
    >
      <div className="flex items-center gap-3 min-w-0 md:flex-1">
        <Avatar src={p.avatar_url} name={p.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink truncate">{p.name}</span>
            {live && <StatusBadge p={p} />}
            {!p.active && <Badge>Left</Badge>}
          </div>
          {p.sessions.length > 0 ? (
            <Steps sessions={p.sessions} className="mt-0.5 text-xs" />
          ) : (
            !live && <div className="mt-0.5 text-xs text-subtle">Didn't log in</div>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-4 gap-3 md:w-[24rem] md:shrink-0">
        <Cell label="In" value={first ? timeText(first) : "-"} />
        <Cell
          label="Out"
          value={last === "missed" ? "Missed" : last ? timeText(last) : "-"}
          className={last === "missed" ? "text-warn" : undefined}
        />
        <Cell label={detailed && taken ? `Breaks (${taken})` : "Breaks"} value={p.sessions.length ? hm(breaks) : "-"} />
        <Cell label="Worked" value={p.sessions.length ? hm(worked) : "-"} className={live && p.status === "in" ? "text-success" : undefined} />
      </dl>
    </li>
  );
}

function StatusBadge({ p }: { p: PersonDay }) {
  if (p.status === "in")
    return (
      <Badge tone="success">
        <span className="h-1.5 w-1.5 rounded-full bg-success" /> Online{p.since ? ` since ${timeText(p.since)}` : ""}
      </Badge>
    );
  if (p.status === "break")
    return (
      <Badge tone="warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" /> On a break{p.since ? ` since ${timeText(p.since)}` : ""}
      </Badge>
    );
  return <Badge>{p.sessions.length ? "Logged out" : "Not in yet"}</Badge>;
}

function Cell({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className={cn("text-sm font-medium text-ink tabular-nums truncate", className)}>{value}</dd>
    </div>
  );
}
