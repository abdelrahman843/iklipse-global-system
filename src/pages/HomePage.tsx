import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BellRing, CalendarCheck2 } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { LogoLoader } from "@/components/ui/Spinner";
import { ROW, ROWS, Section } from "@/components/ui/Section";
import { PageTitle } from "@/components/ui/PageTitle";
import { DueLabel, PriorityBadge } from "@/components/projects/parts";
import { MyAttendance } from "@/components/home/MyAttendance";
import { TeamAttendance } from "@/components/home/TeamAttendance";
import { KIND_ICON } from "@/components/alerts/kinds";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { cairoToday, dayText, fetchMyAttendance } from "@/lib/attendanceApi";
import { fetchUpcomingDeliveries, type UpcomingDelivery } from "@/lib/projectsApi";
import { fetchAlerts, KIND_LABEL, type WatchAlert } from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Home: where the app opens. Team members log in, take breaks and log out
// here (attendance); admins see the team's day instead. Then the deliveries
// due in the next 3 days (and any that are late) on the projects I can see,
// and the newest open alerts.
// -----------------------------------------------------------------------------

const DAYS = 3;
const ALERTS = 5;

export default function HomePage() {
  const { isAdmin, profile } = useAuth();
  const me = useQuery({
    queryKey: ["attendance", "me"],
    queryFn: fetchMyAttendance,
    enabled: !isAdmin,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const first = profile?.display_name?.split(/\s+/)[0];

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6 space-y-8">
        <div>
          <PageTitle>{first ? `Hi, ${first}` : "Home"}</PageTitle>
          <p className="text-sm text-muted mt-1">{dayText(cairoToday())}</p>
        </div>

        {isAdmin ? <TeamAttendance /> : me.data?.tracked ? <MyAttendance me={me.data} /> : null}

        <div className="grid gap-8 lg:grid-cols-2">
          <Deliveries />
          <LatestAlerts />
        </div>
      </div>
    </div>
  );
}

function Deliveries() {
  const q = useQuery({ queryKey: ["home-deliveries", DAYS], queryFn: () => fetchUpcomingDeliveries(DAYS), refetchInterval: 120_000 });
  // Nothing to show for someone who isn't on a project.
  if (q.data && !q.data.projects) return null;
  const items = q.data?.items ?? [];
  return (
    <Section
      title="Deliveries in the next 3 days"
      count={q.data ? items.length : null}
      action={
        <Link to="/projects" className="text-sm text-accent hover:underline">
          All projects
        </Link>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error && !q.data ? (
        <p className="py-6 text-sm text-danger">Couldn't load the deliveries.</p>
      ) : !items.length ? (
        <Empty icon={<CalendarCheck2 size={18} />} text="Nothing is due in the next 3 days." />
      ) : (
        <ul className={ROWS}>
          {items.map((d, i) => (
            <DeliveryRow key={`${d.project_id}:${d.delivery_id ?? "final"}`} d={d} i={i} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function DeliveryRow({ d, i }: { d: UpcomingDelivery; i: number }) {
  return (
    <li style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise">
      <Link to={`/projects/${d.project_id}`} className={cn(ROW, "group -mx-2 px-2 flex items-center gap-3 min-w-0")}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink truncate group-hover:text-accent transition-colors">{d.title}</span>
            {(d.priority === "urgent" || d.priority === "high") && <PriorityBadge priority={d.priority} />}
          </div>
          <div className="text-sm text-muted truncate">{[d.project, d.client].filter(Boolean).join(" · ")}</div>
          <DueLabel due={d.due_at} className="mt-0.5" />
        </div>
        {d.assignee && (
          <span title={d.assignee} className="shrink-0">
            <Avatar src={d.assignee_avatar} name={d.assignee} size={28} />
          </span>
        )}
      </Link>
    </li>
  );
}

function LatestAlerts() {
  // The same list the Alerts page loads, so either one fills the other.
  const q = useQuery({ queryKey: ["watch-alerts", true], queryFn: () => fetchAlerts(true), refetchInterval: 30_000 });
  const all = q.data ?? [];
  const newest = [...all].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, ALERTS);
  return (
    <Section
      title="Latest alerts"
      count={q.data ? `${all.length} open` : null}
      action={
        <Link to="/alerts" className="text-sm text-accent hover:underline">
          All alerts
        </Link>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error && !q.data ? (
        <p className="py-6 text-sm text-danger">Couldn't load the alerts.</p>
      ) : !newest.length ? (
        <Empty icon={<BellRing size={18} />} text="No open alerts." />
      ) : (
        <ul className={ROWS}>
          {newest.map((a, i) => (
            <AlertRow key={a.id} a={a} i={i} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function AlertRow({ a, i }: { a: WatchAlert; i: number }) {
  const Icon = KIND_ICON[a.kind] ?? BellRing;
  const where = a.source === "email" ? a.mail?.subject ?? a.mail?.email : a.source === "slack" ? (a.slack?.name ? `#${a.slack.name}` : null) : a.group.name;
  return (
    <li style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise">
      <Link to={`/alerts?a=${encodeURIComponent(a.id)}`} className={cn(ROW, "group -mx-2 px-2 flex items-start gap-3 min-w-0")}>
        <span
          className={cn(
            "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full",
            a.priority === "urgent" ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent",
          )}
        >
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink break-words group-hover:text-accent transition-colors">{a.title}</span>
            {a.priority !== "normal" && (
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", a.priority === "urgent" ? "text-danger bg-danger/10" : "text-warn bg-warn/10")}>
                {a.priority === "urgent" ? "Urgent" : "High"}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle">
            <span>{KIND_LABEL[a.kind]}</span>
            {where && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate max-w-[16rem]">{where}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span>{relativeTime(a.created_at)}</span>
          </div>
        </div>
      </Link>
    </li>
  );
}

function Loading() {
  return (
    <div className="py-8 flex justify-center">
      <LogoLoader width={56} />
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="py-6 flex items-center gap-2.5 text-sm text-muted">
      <span className="text-subtle">{icon}</span>
      {text}
    </div>
  );
}
