import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarClock, CalendarDays, Plus, Unplug } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import {
  disconnectCalendly,
  fetchCalendlyEventTypes,
  setCalendlyEventType,
  setCalendlyForBot,
  startConnect,
  type CalendlyAccount,
} from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Connected accounts > Calendly (0084): any number of accounts. One of them is
// the one the WhatsApp bot books on when an admin asks it in a group, with the
// event type it books with (its length; Calendly's own Zoom or Google Meet
// makes the link). Calendly connects whoever is signed in on calendly.com, so
// another account means signing out there first.
// -----------------------------------------------------------------------------

const MAX = 10;

/** "30 min", "1 hour", "1 hour 30 min" */
export function lengthText(m: number) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${m} min`;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}

export function CalendlySection({ accounts }: { accounts: CalendlyAccount[] }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["connections"] });
    void qc.invalidateQueries({ queryKey: ["calendly"] });
  };

  const connect = useMutation({
    mutationFn: () => startConnect("calendly"),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't start connecting", description: e.message }),
  });
  const drop = useMutation({
    mutationFn: (a: CalendlyAccount) => disconnectCalendly(a.id),
    onSuccess: (_d, a) => {
      refresh();
      toast.push({ kind: "success", title: `${a.email ?? "Calendly"} disconnected` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't disconnect", description: e.message }),
  });
  const forBot = useMutation({
    mutationFn: (a: CalendlyAccount) => setCalendlyForBot(a.id),
    onSuccess: (_d, a) => {
      refresh();
      toast.push({ kind: "success", title: "The bot books on this account now", description: a.email ?? undefined });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });

  return (
    <Section
      title={
        <span className="inline-flex items-center gap-2">
          <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
            <CalendarClock size={12} />
          </span>
          Calendly
        </span>
      }
      count={accounts.length > 0 ? `${accounts.length} connected` : null}
      action={
        accounts.length > 0 && (
          <Link to="/calendly" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
            <CalendarDays size={14} /> Open meetings
          </Link>
        )
      }
    >
      <div className="divide-y divide-line border-b border-line">
        {accounts.length === 0 && (
          <div className="py-4 text-sm text-muted">
            Lets iklipse show the meetings on your Calendly and book them for you.
            {isAdmin && " Admins can also book them from WhatsApp, by mentioning the bot in a group."}
          </div>
        )}
        {accounts.map((a, i) => (
          <div key={a.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2 min-w-0">
                  <span className="truncate">{a.email ?? a.name ?? "Calendly account"}</span>
                  {isAdmin && a.for_bot && (
                    <Badge tone="accent">
                      <Bot size={10} className="inline -mt-px mr-1" />
                      WhatsApp bot books here
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  Connected {relativeTime(a.connected_at)}
                  {a.scheduling_url && (
                    <>
                      {" · "}
                      <a href={a.scheduling_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        Booking page
                      </a>
                    </>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {isAdmin && !a.for_bot && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-sm:h-10"
                    loading={forBot.isPending && forBot.variables?.id === a.id}
                    onClick={() => forBot.mutate(a)}
                    title="Meetings you ask the WhatsApp bot for go on this account"
                  >
                    Book from WhatsApp here
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft={<Unplug size={14} />}
                  className="max-sm:h-10"
                  loading={drop.isPending && drop.variables?.id === a.id}
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Disconnect ${a.email ?? "this Calendly account"}?`,
                      message:
                        isAdmin && a.for_bot && accounts.length > 1
                          ? "iklipse loses access to it, and the WhatsApp bot books on your next account."
                          : "iklipse loses access to it. You can connect it again any time.",
                      confirmLabel: "Disconnect",
                      danger: true,
                    });
                    if (ok) drop.mutate(a);
                  }}
                >
                  Disconnect
                </Button>
              </div>
            </div>
            {isAdmin && a.for_bot && <BotEventType account={a} />}
          </div>
        ))}
        <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="flex-1 text-xs text-muted">
            Calendly asks you to allow iklipse for the account signed in there; for another one, sign out of Calendly first. Up to {MAX}. Booking for
            someone needs a paid Calendly plan (Standard or higher).
          </div>
          <Button
            variant={accounts.length ? "secondary" : "primary"}
            size="sm"
            iconLeft={accounts.length ? <Plus size={14} /> : <CalendarClock size={14} />}
            disabled={accounts.length >= MAX}
            loading={connect.isPending}
            className="max-sm:h-10"
            onClick={() => connect.mutate()}
          >
            {accounts.length ? "Add Calendly account" : "Connect Calendly"}
          </Button>
        </div>
      </div>
    </Section>
  );
}

/** The event type the WhatsApp bot books with on this account (another length is used when one is asked for). */
function BotEventType({ account }: { account: CalendlyAccount }) {
  const qc = useQueryClient();
  const toast = useToast();
  const types = useQuery({ queryKey: ["calendly", "types", account.id], queryFn: () => fetchCalendlyEventTypes(account.id), staleTime: 5 * 60_000 });
  const pick = useMutation({
    mutationFn: (uri: string) => setCalendlyEventType(account.id, uri),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["connections"] });
      toast.push({ kind: "success", title: "The bot books with this one now" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });
  const options = (types.data ?? []).map((t) => ({ value: t.uri, label: `${t.name} (${lengthText(t.minutes)})` }));
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3 text-sm">
      <span className="text-muted shrink-0">The bot books with</span>
      {types.error ? (
        <span className="text-danger text-xs">{(types.error as Error).message}</span>
      ) : (
        <Select
          value={account.event_type ?? ""}
          onChange={(v) => pick.mutate(v)}
          options={
            options.length
              ? options
              : account.event_type
                ? [{ value: account.event_type, label: `${account.event_type_name ?? "Event type"}${account.event_type_minutes ? ` (${lengthText(account.event_type_minutes)})` : ""}` }]
                : []
          }
          placeholder={types.isLoading ? "Loading…" : "No event types on this Calendly"}
          disabled={pick.isPending || !options.length}
          className="sm:w-72"
          aria-label="Event type the bot books with"
        />
      )}
    </div>
  );
}
