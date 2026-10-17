import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarDays, Copy, ExternalLink, Plus, RefreshCw, Unplug, Video } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PillTabs } from "@/components/ui/PillTabs";
import { Section } from "@/components/ui/Section";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { disconnectZoom, fetchZoomMeetings, setZoomForBot, startConnect, type ZoomAccount, type ZoomMeeting } from "@/lib/connectionsApi";

// -----------------------------------------------------------------------------
// Connected accounts > Zoom: any number of accounts (0079). One of them is the
// one the WhatsApp bot books on when an admin asks it in a group. Under them,
// what's coming up on each account, one account at a time.
// -----------------------------------------------------------------------------

const MAX = 10;

export function ZoomSection({ accounts }: { accounts: ZoomAccount[] }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["connections"] });
    void qc.invalidateQueries({ queryKey: ["zoom-meetings"] });
  };

  const connect = useMutation({
    mutationFn: () => startConnect("zoom"),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't start connecting", description: e.message }),
  });
  const drop = useMutation({
    mutationFn: (a: ZoomAccount) => disconnectZoom(a.id),
    onSuccess: (_d, a) => {
      refresh();
      toast.push({ kind: "success", title: `${a.email ?? "Zoom"} disconnected` });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't disconnect", description: e.message }),
  });
  const forBot = useMutation({
    mutationFn: (a: ZoomAccount) => setZoomForBot(a.id),
    onSuccess: (_d, a) => {
      refresh();
      toast.push({ kind: "success", title: "The bot books on this account now", description: a.email ?? undefined });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });

  return (
    <>
      <Section
        title={
          <span className="inline-flex items-center gap-2">
            <span className="grid place-items-center h-5 w-5 rounded bg-accent-soft text-accent">
              <Video size={12} />
            </span>
            Zoom
          </span>
        }
        count={accounts.length > 0 ? `${accounts.length} connected` : null}
        action={
          accounts.length > 0 && (
            <Link to="/zoom" className="text-sm font-medium text-accent hover:underline underline-offset-2 inline-flex items-center gap-1">
              <CalendarDays size={14} /> Open calendar
            </Link>
          )
        }
      >
        <div className="divide-y divide-line border-b border-line">
          {accounts.length === 0 && (
            <div className="py-4 text-sm text-muted">
              Lets iklipse make Zoom meetings on your account.
              {isAdmin && " Admins can also book them from WhatsApp, by mentioning the bot in a group."}
            </div>
          )}
          {accounts.map((a, i) => (
            <div key={a.id} style={{ "--i": Math.min(i, 12) } as React.CSSProperties} className="rise py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink flex flex-wrap items-center gap-2 min-w-0">
                  <span className="truncate">{a.email ?? "Zoom account"}</span>
                  {isAdmin && a.for_bot && (
                    <Badge tone="accent">
                      <Bot size={10} className="inline -mt-px mr-1" />
                      WhatsApp bot books here
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted mt-0.5">Connected {relativeTime(a.connected_at)}</div>
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
                      title: `Disconnect ${a.email ?? "this Zoom account"}?`,
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
          ))}
          <div className="py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="flex-1 text-xs text-muted">
              {accounts.length
                ? "Zoom connects the account you're signed in to on zoom.us. To add a different one, sign out there first."
                : "Zoom asks you to sign in and allow iklipse."}{" "}
              Up to {MAX}.
            </div>
            <Button
              variant={accounts.length ? "secondary" : "primary"}
              size="sm"
              iconLeft={accounts.length ? <Plus size={14} /> : <Video size={14} />}
              loading={connect.isPending}
              disabled={accounts.length >= MAX}
              className="max-sm:h-10"
              onClick={() => connect.mutate()}
            >
              {accounts.length ? "Add Zoom account" : "Connect Zoom"}
            </Button>
          </div>
        </div>
      </Section>
      {accounts.length > 0 && <Upcoming accounts={accounts} />}
    </>
  );
}

// ------------------------------------------------------------ upcoming --

const pad = (n: number) => String(n).padStart(2, "0");
/** "25-12-2019", like the bot says it. */
const dmy = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
const time12 = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
const weekday = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "long" });
function length(m: number | null) {
  if (!m) return null;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h ? `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}` : `${m} min`;
}

/** What's coming up on each account, one account at a time. */
function Upcoming({ accounts }: { accounts: ZoomAccount[] }) {
  const toast = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === picked) ?? accounts.find((a) => a.for_bot) ?? accounts[0];
  const q = useQuery({ queryKey: ["zoom-meetings", account.id], queryFn: () => fetchZoomMeetings(account.id), staleTime: 60_000 });

  // By day: "Sunday 25-12-2019", then each meeting's time.
  const days: { day: string; items: (ZoomMeeting & { at: Date })[] }[] = [];
  for (const m of q.data ?? []) {
    const at = new Date(m.start_time);
    const day = `${weekday(at)} ${dmy(at)}`;
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push({ ...m, at });
    else days.push({ day, items: [{ ...m, at }] });
  }

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: "Link copied" });
    } catch {
      toast.push({ kind: "error", title: "Couldn't copy", description: url });
    }
  };

  return (
    <Section
      title="Coming up on Zoom"
      count={q.data?.length || null}
      action={
        <Button variant="ghost" size="sm" iconLeft={<RefreshCw size={14} />} loading={q.isFetching && !q.isLoading} onClick={() => void q.refetch()}>
          Refresh
        </Button>
      }
    >
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
      {q.isLoading ? (
        <div className="py-6 grid place-items-center">
          <Spinner />
        </div>
      ) : q.error ? (
        <p className="py-4 text-sm text-danger">{(q.error as Error).message}</p>
      ) : !days.length ? (
        <p className="py-4 text-sm text-muted">Nothing coming up on {account.email ?? "this account"}.</p>
      ) : (
        <div className="space-y-5">
          {days.map((d) => (
            <div key={d.day}>
              <div className="text-xs font-semibold uppercase tracking-wide text-subtle mb-1">{d.day}</div>
              <div className="divide-y divide-line border-y border-line">
                {d.items.map((m) => (
                  <div key={`${m.id}-${m.start_time}`} className="py-2.5 flex flex-col sm:flex-row sm:items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-ink truncate">{m.topic || "Zoom meeting"}</div>
                      <div className="text-xs text-muted mt-0.5">{[time12(m.at), length(m.duration)].filter(Boolean).join(" · ")}</div>
                    </div>
                    {m.join_url && (
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" iconLeft={<Copy size={14} />} onClick={() => void copy(m.join_url!)}>
                          Copy link
                        </Button>
                        <a
                          href={m.join_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center justify-center gap-1.5 h-10 px-3 text-base sm:h-8 sm:px-2.5 sm:text-sm rounded-md font-medium bg-surface text-ink border border-border hover:bg-inset transition-colors"
                        >
                          <ExternalLink size={14} />
                          Open
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
