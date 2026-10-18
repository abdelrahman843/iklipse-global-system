import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Coffee, LogIn, LogOut, Play } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Section, Stat, StatStrip } from "@/components/ui/Section";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import {
  attendanceAct,
  dayBounds,
  hm,
  steps,
  timeText,
  totals,
  useNow,
  type AttendanceAction,
  type MyAttendance as Mine,
} from "@/lib/attendanceApi";

type Tracked = Extract<Mine, { tracked: true }>;

const DONE: Record<AttendanceAction, string> = {
  in: "Logged in",
  break: "On a break",
  back: "Back from your break",
  out: "Logged out",
};

/** A team member's own day: log in, breaks, log out, and the times so far. */
export function MyAttendance({ me }: { me: Tracked }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const now = useNow();
  const { worked, breaks } = totals(me.sessions, now);
  const { first, last } = dayBounds(me.sessions);
  const breakCount = me.sessions.reduce((n, s) => n + s.breaks.length, 0);

  const act = useMutation({
    mutationFn: attendanceAct,
    onSuccess: (data, action) => {
      qc.setQueryData(["attendance", "me"], data);
      toast.push({ kind: "success", title: DONE[action] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "That didn't go through", description: e.message }),
  });
  const press = async (action: AttendanceAction) => {
    if (action === "out") {
      const ok = await confirm({
        title: "Log out?",
        message: "This ends your work day. You stay signed in to iklipse.",
        confirmLabel: "Log out",
      });
      if (!ok) return;
    }
    act.mutate(action);
  };
  const busy = (a: AttendanceAction) => act.isPending && act.variables === a;

  const status =
    me.status === "in"
      ? { dot: "bg-success", text: `Working since ${timeText(me.since!)}` }
      : me.status === "break"
        ? { dot: "bg-warn", text: `On a break since ${timeText(me.since!)}` }
        : last && last !== "missed"
          ? { dot: "bg-subtle", text: `Logged out at ${timeText(last)}` }
          : { dot: "bg-subtle", text: "You haven't logged in today" };

  return (
    <Section title="Your day" hint="Log in when you start work, take your breaks here, and log out when you leave.">
      <div className="pt-3 flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              {me.status !== "out" && <span className={cn("absolute inset-0 rounded-full opacity-60 pulse-ring", status.dot)} />}
              <span className={cn("relative h-2.5 w-2.5 rounded-full", status.dot)} />
            </span>
            <span className="text-base font-semibold text-ink truncate">{status.text}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            {me.status === "out" ? (
              <Button
                variant="primary"
                className="col-span-2"
                iconLeft={<LogIn size={15} />}
                loading={busy("in")}
                disabled={act.isPending}
                onClick={() => void press("in")}
              >
                Log in
              </Button>
            ) : (
              <>
                {me.status === "break" ? (
                  <Button variant="primary" iconLeft={<Play size={15} />} loading={busy("back")} disabled={act.isPending} onClick={() => void press("back")}>
                    End break
                  </Button>
                ) : (
                  <Button iconLeft={<Coffee size={15} />} loading={busy("break")} disabled={act.isPending} onClick={() => void press("break")}>
                    Break
                  </Button>
                )}
                <Button iconLeft={<LogOut size={15} />} loading={busy("out")} disabled={act.isPending} onClick={() => void press("out")}>
                  Log out
                </Button>
              </>
            )}
          </div>
        </div>

        <StatStrip>
          <Stat label="Logged in" value={first ? timeText(first) : "-"} />
          <Stat
            label="Logged out"
            value={last === "missed" ? "Missed" : last ? timeText(last) : "-"}
            tone={last === "missed" ? "warn" : undefined}
          />
          <Stat label="Breaks" value={hm(breaks)} hint={breakCount ? `${breakCount} ${breakCount === 1 ? "break" : "breaks"}` : undefined} />
          <Stat label="Worked" value={hm(worked)} tone={me.status === "in" ? "success" : undefined} />
        </StatStrip>

        {me.sessions.length > 0 && <Steps sessions={me.sessions} />}
        <p className="text-sm text-subtle">Logging out here only ends your work day. You stay signed in to iklipse.</p>
      </div>
    </Section>
  );
}

/** The day as a line of steps: In 9:02 AM · Break 1:10 PM to 1:40 PM · Out 5:30 PM. */
export function Steps({ sessions, className }: { sessions: Parameters<typeof steps>[0]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm", className)}>
      {steps(sessions).map((s, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden className="text-subtle">·</span>}
          <span className={cn(s.kind === "missed" ? "text-warn font-medium" : s.kind === "break" ? "text-muted" : "text-ink")}>{s.text}</span>
        </span>
      ))}
    </div>
  );
}
