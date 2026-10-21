import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Plus, Unplug } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { disconnectCalendar, startConnect, type CalendarAccount } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Connected accounts > Google Calendar (0096): any number of Google accounts'
// calendars, like Drive. Someone on Calendly can't connect it: it's one or the
// other, and the sidebar's page is named after the one they use.
// -----------------------------------------------------------------------------

const MAX = 10;

export function CalendarSection({ accounts, onCalendly }: { accounts: CalendarAccount[]; onCalendly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const connect = useMutation({
    mutationFn: () => startConnect("calendar"),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't start connecting", description: e.message }),
  });
  const drop = useMutation({
    mutationFn: (a: CalendarAccount) => disconnectCalendar(a.id),
    onSuccess: (_d, a) => {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      void qc.invalidateQueries({ queryKey: ["calendar"] });
      toast.push({ kind: "success", title: `${a.email} disconnected` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't disconnect", description: e.message }),
  });

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
            <CalendarDays size={12} />
          </span>
          Google Calendar
        </span>
      }
      count={accounts.length > 0 ? `${accounts.length} connected` : null}
      action={
        accounts.length > 0 && (
          <Link to="/calendar" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
            <CalendarDays size={14} /> Open calendar
          </Link>
        )
      }
    >
      <div className="divide-y divide-line border-b border-line">
        {accounts.length === 0 && (
          <div className="py-4 text-sm text-muted">
            {onCalendly
              ? "You use Calendly. It's Calendly or Google Calendar, not both: disconnect Calendly first to use Google Calendar instead."
              : "Lets iklipse show the meetings on your Google Calendar, and make them for you with a Google Meet link."}
          </div>
        )}
        {accounts.map((a, i) => (
          <div key={a.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink truncate">{a.email}</div>
              <div className="text-xs text-muted mt-0.5">
                {a.name ? `${a.name} · ` : ""}Connected {relativeTime(a.connected_at)}
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Unplug size={14} />}
              className="max-sm:h-10"
              loading={drop.isPending && drop.variables?.id === a.id}
              onClick={async () => {
                const ok = await confirm({
                  title: `Disconnect ${a.email}?`,
                  message: "Its meetings leave iklipse. Nothing is deleted from Google Calendar.",
                  confirmLabel: "Disconnect",
                  danger: true,
                });
                if (ok) drop.mutate(a);
              }}
            >
              Disconnect
            </Button>
          </div>
        ))}
        {!onCalendly && (
          <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="flex-1 text-xs text-muted">
              {accounts.length ? "Add another account: Google asks which one." : "Google asks which account to connect."} Up to {MAX}.
            </div>
            <Button
              variant={accounts.length ? "secondary" : "primary"}
              size="sm"
              iconLeft={accounts.length ? <Plus size={14} /> : <CalendarDays size={14} />}
              disabled={accounts.length >= MAX}
              loading={connect.isPending}
              className="max-sm:h-10"
              onClick={() => connect.mutate()}
            >
              {accounts.length ? "Add Google Calendar" : "Connect Google Calendar"}
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}
