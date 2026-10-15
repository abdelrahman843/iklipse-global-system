import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BellOff,
  BellRing,
  Check,
  ChevronDown,
  Clock,
  Handshake,
  Hourglass,
  MessageSquareWarning,
  PhoneCall,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Users2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Hint } from "@/components/ui/Input";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ROWS, Section } from "@/components/ui/Section";
import { PageTitle } from "@/components/ui/PageTitle";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  botStateText,
  clock,
  closeAlert,
  connectBot,
  fetchAlerts,
  fetchWatchGroups,
  fetchWatchOverview,
  KIND_LABEL,
  linkNumber,
  reopenAlert,
  saveWatchSettings,
  setGroupMonitored,
  snoozeAlert,
  span,
  syncGroups,
  testCall,
  type AlertKind,
  type WatchAlert,
  type WatchGroup,
  type WatchMember,
  type WatchOverview,
  type WatchSettings,
} from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// Alerts: the WhatsApp watch. The bot reads the WhatsApp groups it's in; when a
// client is left without a reply, or someone promises something, an alert
// rings the team members in that group (only the person it's about, when it's
// about one person): notifications again and again, then phone calls, until
// someone marks it handled. Everyone sees the alerts on them; admins see all,
// the bot's groups (and who on the team is in each) and the settings.
// ?a=<id> opens an alert (notifications link there), ?tab= a tab.
// -----------------------------------------------------------------------------

type Tab = "open" | "closed" | "groups" | "settings";
const TABS: Tab[] = ["open", "closed", "groups", "settings"];

const KIND_ICON: Record<AlertKind, typeof BellRing> = {
  unanswered: MessageSquareWarning,
  promise: Handshake,
  follow_up: Hourglass,
};

const SNOOZE = [
  { label: "15 minutes", min: 15 },
  { label: "1 hour", min: 60 },
  { label: "3 hours", min: 180 },
  { label: "Until tomorrow", min: -1 },
];

/** Minutes until 9 am tomorrow, here. */
function untilTomorrow() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return Math.max(60, Math.round((t.getTime() - Date.now()) / 60_000));
}

export default function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const ov = useQuery({ queryKey: ["watch-overview"], queryFn: fetchWatchOverview, refetchInterval: 30_000 });
  const admin = !!ov.data?.is_admin;
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) && (admin || asked === "open" || asked === "closed") ? asked : "open";
  const focus = params.get("a");
  const setTab = (t: Tab) => setParams(t === "open" ? {} : { tab: t }, { replace: true });
  const [q, setQ] = useState("");

  const open = useQuery({ queryKey: ["watch-alerts", true], queryFn: () => fetchAlerts(true), refetchInterval: 20_000 });
  const closed = useQuery({ queryKey: ["watch-alerts", false], queryFn: () => fetchAlerts(false), enabled: tab === "closed" });

  const tabs: LineTab<Tab>[] = [
    { value: "open", label: "Open", count: open.data?.length },
    { value: "closed", label: "Closed" },
    ...(admin
      ? ([
          { value: "groups", label: "Groups", count: ov.data?.bot?.monitored },
          { value: "settings", label: "Settings" },
        ] as LineTab<Tab>[])
      : []),
  ];

  const list = tab === "closed" ? closed : open;
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    const rows = list.data ?? [];
    if (!words) return rows;
    return rows.filter((a) => [a.title, a.detail, a.person, a.group.name, ...a.recipients.map((r) => r.name)].join(" ").toLowerCase().includes(words));
  }, [list.data, q]);

  if (ov.isLoading) return <PageSpinner />;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <PageTitle count={open.data && `${open.data.length} open`}>Alerts</PageTitle>
            <p className="text-sm text-muted mt-1 hidden sm:block">
              Clients waiting for a reply and promises in the WhatsApp groups, ringing until someone handles them.
            </p>
          </div>
        </div>

        <div className="mb-5 flex flex-col-reverse gap-3 lg:flex-row lg:items-end border-b border-border">
          <LineTabs value={tab} tabs={tabs} onChange={setTab} label="Alerts" bare />
          {(tab === "open" || tab === "closed") && (
            <SearchField value={q} onChange={setQ} placeholder="Search" className="lg:ml-auto lg:mb-2 lg:w-56" />
          )}
        </div>

        <div key={tab} className="view-enter space-y-6">
          {admin && ov.data && (tab === "open" || tab === "groups") && <BotNote ov={ov.data} onSettings={() => setTab("settings")} />}
          {tab === "groups" && ov.data && <GroupsTab ov={ov.data} />}
          {tab === "settings" && ov.data?.settings && <SettingsTab ov={ov.data} settings={ov.data.settings} />}
          {(tab === "open" || tab === "closed") &&
            (list.isLoading ? (
              <PageSpinner />
            ) : list.error && !list.data ? (
              <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the alerts" description={(list.error as Error).message} />
            ) : !shown.length ? (
              <EmptyState
                icon={tab === "open" ? <BellOff size={20} /> : <Check size={20} />}
                title={q ? "Nothing matches" : tab === "open" ? "Nothing waiting" : "Nothing closed in the last 30 days"}
                description={
                  q
                    ? undefined
                    : tab === "open"
                      ? "When a client waits for a reply or someone promises something in a WhatsApp group, it shows up here."
                      : undefined
                }
              />
            ) : (
              <ul className={ROWS}>
                {shown.map((a, i) => (
                  <AlertRow key={a.id} a={a} admin={admin} index={i} focused={focus === a.id} />
                ))}
              </ul>
            ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ an alert --

function stageText(a: WatchAlert): { text: string; tone: "muted" | "warn" | "danger" | "accent" | "success" } {
  const now = Date.now();
  if (a.status === "handled") return { text: `Handled${a.closed_by_name ? ` by ${a.closed_by_name}` : ""}`, tone: "success" };
  if (a.status === "resolved") return { text: "Dealt with in the group", tone: "success" };
  if (a.status === "stopped") return { text: "Stopped", tone: "muted" };
  if (a.snoozed_until && Date.parse(a.snoozed_until) > now) return { text: `Snoozed until ${clock(a.snoozed_until)}`, tone: "muted" };
  if (a.recipients.some((r) => r.calling)) return { text: "Ikli is calling", tone: "danger" };
  if (a.calls_made > 0) return { text: `Calling · ${a.calls_made} ${a.calls_made === 1 ? "call" : "calls"}`, tone: "danger" };
  if (a.alerts_sent > 0) return { text: `Ringing · ${a.alerts_sent} ${a.alerts_sent === 1 ? "alert" : "alerts"}`, tone: "warn" };
  if (Date.parse(a.due_at) > now) return { text: `${a.kind === "unanswered" ? "Rings" : "Due"} ${clock(a.due_at)}`, tone: "accent" };
  return { text: "Rings now", tone: "warn" };
}

const TONE = {
  muted: "text-muted bg-inset",
  warn: "text-warn bg-warn/10",
  danger: "text-danger bg-danger/10",
  accent: "text-accent bg-accent-soft",
  success: "text-success bg-success/10",
} as const;

const EVENT_TEXT: Record<string, string> = {
  opened: "Opened",
  alert: "Alert",
  call: "Call",
  answered: "Answered",
  no_answer: "No answer",
  declined: "Declined",
  call_failed: "Call failed",
  handled: "Handled",
  resolved: "Dealt with",
  snoozed: "Snoozed",
  stopped: "Stopped",
  reopened: "Reopened",
};

function AlertRow({ a, admin, index, focused }: { a: WatchAlert; admin: boolean; index: number; focused: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(focused);
  const Icon = KIND_ICON[a.kind] ?? BellRing;
  const stage = stageText(a);
  const canAct = a.status === "open" && (admin || a.mine);
  const waiting = Date.now() - Date.parse(a.kind === "unanswered" ? a.created_at : a.due_at);

  useEffect(() => {
    if (focused) document.getElementById(`alert-${a.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused, a.id]);

  const after = () => {
    void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
    void qc.invalidateQueries({ queryKey: ["watch-overview"] });
    void qc.invalidateQueries({ queryKey: ["watch-ringing"] });
  };
  const handled = useMutation({
    mutationFn: () => closeAlert(a.id),
    onSuccess: () => (after(), toast.push({ kind: "success", title: "Marked as handled", description: "It stops ringing for everyone." })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't mark it", description: e.message }),
  });
  const snooze = useMutation({
    mutationFn: (min: number) => snoozeAlert(a.id, min),
    onSuccess: () => (after(), toast.push({ kind: "success", title: "Snoozed" })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't snooze it", description: e.message }),
  });
  const reopen = useMutation({
    mutationFn: () => reopenAlert(a.id),
    onSuccess: () => (after(), toast.push({ kind: "success", title: "Open again", description: "It rings at the next minute." })),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't reopen it", description: e.message }),
  });

  return (
    <li id={`alert-${a.id}`} className={cn("rise py-3", focused && "bg-accent-soft/40 -mx-2 px-2 rounded-lg")} style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full",
            a.status !== "open" ? "bg-inset text-muted" : a.priority === "urgent" ? "bg-danger/10 text-danger" : "bg-accent-soft text-accent",
          )}
        >
          <Icon size={17} />
        </span>
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink break-words">{a.title}</span>
            {a.priority !== "normal" && a.status === "open" && (
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", a.priority === "urgent" ? TONE.danger : TONE.warn)}>
                {a.priority === "urgent" ? "Urgent" : "High"}
              </span>
            )}
          </div>
          {a.detail && <div className="mt-0.5 text-sm text-muted break-words">{a.detail}</div>}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
            <span className="inline-flex items-center gap-1">
              <Users2 size={12} /> {a.group.name ?? "WhatsApp group"}
            </span>
            <span>{KIND_LABEL[a.kind]}</span>
            {a.status === "open" ? (
              Date.parse(a.due_at) <= Date.now() && <span className="inline-flex items-center gap-1"><Clock size={12} /> {span(waiting)}{a.kind === "unanswered" ? " waiting" : " late"}</span>
            ) : (
              a.closed_at && <span>{relativeTime(a.closed_at)}</span>
            )}
            <span className={cn("rounded-full px-2 py-0.5 font-medium", TONE[stage.tone])}>{stage.text}</span>
          </div>
        </button>
        <div className="hidden sm:flex -space-x-1.5 shrink-0 pt-1" title={a.recipients.map((r) => r.name).join(", ")}>
          {a.recipients.slice(0, 4).map((r) => (
            <Avatar key={r.user_id} src={r.avatar_url} name={r.name} size={24} className="ring-2 ring-bg" />
          ))}
        </div>
        <ChevronDown size={16} className={cn("mt-1.5 shrink-0 text-subtle transition-transform duration-200", open && "rotate-180")} />
      </div>

      {(canAct || (admin && a.status !== "open")) && (
        <div className="mt-3 ml-12 flex flex-wrap gap-2">
          {canAct && (
            <>
              <Button size="sm" variant="primary" iconLeft={<Check size={14} />} loading={handled.isPending} onClick={() => handled.mutate()}>
                Handled
              </Button>
              <Menu
                trigger={
                  <Button size="sm" iconLeft={<BellOff size={14} />} loading={snooze.isPending}>
                    Snooze
                  </Button>
                }
              >
                {(close) => (
                  <>
                    {SNOOZE.map((s) => (
                      <MenuItem key={s.label} onClick={() => (close(), snooze.mutate(s.min < 0 ? untilTomorrow() : s.min))}>
                        {s.label}
                      </MenuItem>
                    ))}
                  </>
                )}
              </Menu>
            </>
          )}
          {admin && a.status !== "open" && (
            <Button size="sm" variant="ghost" iconLeft={<RotateCcw size={14} />} loading={reopen.isPending} onClick={() => reopen.mutate()}>
              Reopen
            </Button>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3 ml-12 grid gap-4 sm:grid-cols-2 animate-fade-in">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-subtle mb-1.5">Ringing for</div>
            <ul className="space-y-1.5">
              {a.recipients.map((r) => (
                <li key={r.user_id} className="flex items-center gap-2 text-sm">
                  <Avatar src={r.avatar_url} name={r.name} size={22} />
                  <span className="text-ink">{r.name}</span>
                  <span className="text-xs text-subtle">
                    {r.calling
                      ? "being called now"
                      : r.calls
                        ? `${r.calls} ${r.calls === 1 ? "call" : "calls"}, answered ${r.answered}`
                        : r.next_call_at
                          ? `call ${clock(r.next_call_at)}`
                          : ""}
                  </span>
                </li>
              ))}
            </ul>
            {a.person && <div className="mt-3 text-sm text-muted">About: {a.person}</div>}
            {a.close_note && <div className="mt-1 text-sm text-muted break-words">Note: {a.close_note}</div>}
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-subtle mb-1.5">What happened</div>
            <ol className="space-y-1.5">
              {a.events.map((e, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="w-20 shrink-0 text-xs text-subtle pt-0.5 tabular-nums">{relativeTime(e.at)}</span>
                  <span className="min-w-0 text-ink break-words">
                    <span className="font-medium">{EVENT_TEXT[e.what] ?? e.what}</span>
                    {e.detail && <span className="text-muted"> · {e.detail}</span>}
                    {e.by && !e.detail?.includes(e.by) && <span className="text-muted"> · {e.by}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ the bot --

function BotNote({ ov, onSettings }: { ov: WatchOverview; onSettings: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const bot = ov.bot;
  const connect = useMutation({
    mutationFn: connectBot,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      const st = botStateText(r.state);
      toast.push({ kind: st.ok ? "success" : "error", title: st.ok ? "The bot is connected" : "Connected, but the WhatsApp number has a problem", description: st.ok ? "New group messages come here from now on." : st.text });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't connect the bot", description: e.message }),
  });
  if (!bot) return null;
  const st = botStateText(bot.state);
  let text: ReactNode = null;
  let action: ReactNode = null;
  if (!bot.configured) {
    text = "The WhatsApp bot isn't set up: add the Green API connection on the Users page.";
  } else if (!bot.hook_at) {
    text = "The bot's WhatsApp doesn't send its messages here yet.";
    action = (
      <Button size="sm" variant="secondary" loading={connect.isPending} onClick={() => connect.mutate()}>
        Connect the bot
      </Button>
    );
  } else if (bot.state && !st.ok) {
    text = `The bot's WhatsApp${bot.phone ? ` (+${bot.phone})` : ""}: ${st.text}.`;
    action = (
      <Button size="sm" variant="secondary" loading={connect.isPending} onClick={() => connect.mutate()}>
        Check again
      </Button>
    );
  } else if (!ov.settings?.enabled) {
    text = "Watching the WhatsApp groups is off.";
    action = (
      <Button size="sm" variant="secondary" onClick={onSettings}>
        Open settings
      </Button>
    );
  }
  if (!text) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-sm text-ink sm:flex-row sm:items-center sm:justify-between">
      <span className="inline-flex items-start gap-2 min-w-0">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" />
        <span className="break-words">{text}</span>
      </span>
      {action && <span className="shrink-0 self-start sm:self-auto">{action}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ groups --

function GroupsTab({ ov }: { ov: WatchOverview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const groups = useQuery({ queryKey: ["watch-groups"], queryFn: fetchWatchGroups, refetchInterval: 60_000 });
  const sync = useMutation({
    mutationFn: syncGroups,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["watch-groups"] });
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      toast.push({ kind: "success", title: `${r.groups} ${r.groups === 1 ? "group" : "groups"}`, description: r.read < r.groups ? "The rest are read over the next few minutes." : undefined });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't read the groups", description: e.message }),
  });
  const bot = ov.bot;
  const rows = groups.data?.groups ?? [];
  const live = rows.filter((g) => !g.left);
  const left = rows.filter((g) => g.left);

  return (
    <>
      <Section
        title="The bot's WhatsApp"
        action={
          <Button size="sm" iconLeft={<RefreshCw size={14} />} loading={sync.isPending} disabled={!bot?.configured} onClick={() => sync.mutate()}>
            Read the groups
          </Button>
        }
      >
        <div className="py-3 text-sm text-muted flex flex-wrap gap-x-5 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <Smartphone size={14} />
            {bot?.phone ? `+${bot.phone}` : bot?.instance ? `Green API ${bot.instance}` : "Not set up"}
          </span>
          <span className={cn(botStateText(bot?.state).ok ? "text-success" : "text-warn")}>{botStateText(bot?.state).text}</span>
          {bot?.hook_at && <span>Last message {relativeTime(bot.hook_at)}</span>}
          {bot?.synced_at && <span>Groups read {relativeTime(bot.synced_at)}</span>}
        </div>
      </Section>

      {groups.isLoading ? (
        <PageSpinner />
      ) : !rows.length ? (
        <EmptyState
          icon={<Users2 size={20} />}
          title="No groups yet"
          description="Add the bot's number to your client WhatsApp groups, then press Read the groups. Groups also show up by themselves on their first message."
        />
      ) : (
        <Section title="Groups" count={live.length} hint="Turn off a group to stop watching it. Link each team number to its person, so the bot knows who is on the team.">
          <ul className={ROWS}>
            {live.map((g, i) => (
              <GroupRow key={g.chat_id} g={g} members={groups.data!.members} index={i} />
            ))}
          </ul>
          {left.length > 0 && <div className="pt-3 text-xs text-subtle">The bot left: {left.map((g) => g.name ?? "Unnamed").join(", ")}</div>}
        </Section>
      )}
    </>
  );
}

function GroupRow({ g, members, index }: { g: WatchGroup; members: WatchMember[]; index: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const team = g.participants.filter((p) => p.user_id);
  const others = g.participants.filter((p) => !p.user_id);
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["watch-groups"] });
    void qc.invalidateQueries({ queryKey: ["watch-overview"] });
    void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
  };
  const watch = useMutation({
    mutationFn: (on: boolean) => setGroupMonitored(g.chat_id, on),
    onSuccess: after,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });
  const link = useMutation({
    mutationFn: ({ phone, user }: { phone: string; user: string | null }) => linkNumber(phone, user),
    onSuccess: after,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't link the number", description: e.message }),
  });
  const options = [{ value: "", label: "Not on the team" }, ...members.filter((m) => m.active).map((m) => ({ value: m.id, label: m.name }))];

  return (
    <li className="rise py-3" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("font-semibold break-words", g.monitored ? "text-ink" : "text-muted")}>{g.name ?? "Unnamed group"}</span>
            {g.open_alerts > 0 && <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TONE.warn)}>{g.open_alerts} open</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
            <span>{g.size ?? g.participants.length} people</span>
            <span>
              Team: {team.length ? [...new Set(team.map((p) => p.user_name))].join(", ") : "nobody linked"}
            </span>
            {g.last_message_at && <span>Last message {relativeTime(g.last_message_at)}</span>}
          </div>
          {g.last_error && <div className="mt-1 text-xs text-danger break-words">{g.last_error}</div>}
        </button>
        <div className="shrink-0 pt-0.5">
          <Toggle
            checked={g.monitored}
            disabled={watch.isPending}
            label="Watch"
            onChange={async (on) => {
              if (!on && g.open_alerts > 0 && !(await confirm({ title: `Stop watching ${g.name ?? "this group"}?`, message: "Its open alerts stop too.", confirmLabel: "Stop watching", danger: true }))) return;
              watch.mutate(on);
            }}
          />
        </div>
        <ChevronDown size={16} className={cn("mt-1.5 shrink-0 text-subtle transition-transform duration-200", open && "rotate-180")} onClick={() => setOpen(!open)} />
      </div>
      {open && (
        <ul className="mt-3 rounded-lg border border-border divide-y divide-line animate-fade-in">
          {[...team, ...others].map((p) => (
            <li key={p.wa_id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink break-words">
                  {p.user_name ?? p.name ?? (p.phone ? `+${p.phone}` : "Hidden number")}
                  {p.is_admin && <span className="ml-2 text-xs text-subtle">group admin</span>}
                </div>
                <div className="text-xs text-subtle">
                  {p.phone ? `+${p.phone}` : "WhatsApp hides this number"}
                  {p.user_name && p.name && p.name !== p.user_name ? ` · ${p.name} on WhatsApp` : ""}
                  {!p.user_id ? " · counted as the client" : ""}
                </div>
              </div>
              {p.phone && (
                <Select
                  className="sm:w-48"
                  size="sm"
                  value={p.user_id ?? ""}
                  options={options}
                  aria-label="Who this is"
                  onChange={(v) => link.mutate({ phone: p.phone!, user: v || null })}
                />
              )}
            </li>
          ))}
          {!g.participants.length && <li className="px-3 py-2 text-sm text-muted">Not read yet. Press Read the groups.</li>}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- settings --

function NumField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  unit,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  unit: string;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <div className="w-28 shrink-0">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => onChange(e.target.value === "" ? NaN : Math.round(Number(e.target.value)))}
          />
        </div>
        <span className="text-sm text-muted">{unit}</span>
      </div>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

const MODELS = [
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (recommended)" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5 (smartest, slower)" },
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (cheapest)" },
];

const KEYS = [
  "enabled",
  "model",
  "reply_wait_min",
  "promise_wait_min",
  "repeat_every_min",
  "alerts_before_call",
  "calls_enabled",
  "call_retry_min",
  "call_every_min",
  "max_calls",
  "stop_after_hours",
  "quiet_from",
  "quiet_to",
  "call_language",
  "cc_admins",
] as const;
type Draft = Pick<WatchSettings, (typeof KEYS)[number]>;

const LIMITS: Partial<Record<keyof Draft, [number, number]>> = {
  reply_wait_min: [0, 1440],
  promise_wait_min: [5, 2880],
  repeat_every_min: [1, 1440],
  alerts_before_call: [1, 100],
  call_retry_min: [1, 120],
  call_every_min: [5, 1440],
  max_calls: [0, 500],
  stop_after_hours: [0, 720],
};

function SettingsTab({ ov, settings }: { ov: WatchOverview; settings: WatchSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Only what's edited here (the server refuses other keys).
  const initial = useMemo<Draft>(() => {
    const picked = Object.fromEntries(KEYS.map((k) => [k, settings[k]])) as Draft;
    return { ...picked, quiet_from: picked.quiet_from?.slice(0, 5) ?? null, quiet_to: picked.quiet_to?.slice(0, 5) ?? null };
  }, [settings]);
  const [d, setD] = useState<Draft>(initial);
  useEffect(() => setD(initial), [initial]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const bad = (Object.keys(LIMITS) as (keyof Draft)[]).find((k) => {
    const v = d[k] as number;
    const [lo, hi] = LIMITS[k]!;
    return !Number.isFinite(v) || v < lo || v > hi;
  });
  const quietBad = !!d.quiet_from !== !!d.quiet_to;

  const save = useMutation({
    mutationFn: () => saveWatchSettings({ ...d, quiet_from: d.quiet_from || null, quiet_to: d.quiet_to || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      toast.push({ kind: "success", title: "Saved" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  const test = useMutation({
    mutationFn: testCall,
    onSuccess: () => toast.push({ kind: "success", title: "Ikli is calling you", description: "Answer it here, or on your phone." }),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't call", description: e.message }),
  });

  return (
    <div className="max-w-2xl space-y-8 pb-24">
      <Section title="Watching">
        <div className="space-y-4 pt-3">
          <Toggle
            checked={d.enabled}
            onChange={(v) => set("enabled", v)}
            label="Watch the WhatsApp groups"
            hint="Claude reads each group a minute after it goes quiet and opens alerts. Group messages are kept 30 days."
          />
          <div>
            <Label>Claude model</Label>
            <Select value={d.model} options={MODELS} onChange={(v) => set("model", v)} className="w-full sm:w-80" aria-label="Claude model" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumField id="w-reply" label="A client counts as waiting after" unit="minutes" min={0} max={1440} value={d.reply_wait_min} onChange={(v) => set("reply_wait_min", v)} hint="With no reply from the team." />
            <NumField id="w-promise" label="A promise with no time is due after" unit="minutes" min={5} max={2880} value={d.promise_wait_min} onChange={(v) => set("promise_wait_min", v)} hint={'"I\'ll get back to you shortly".'} />
          </div>
        </div>
      </Section>

      <Section title="The alarm" hint="An alert rings everyone on it in the app (and on their phones) until someone marks it handled.">
        <div className="space-y-4 pt-3">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumField id="w-repeat" label="Ring again every" unit="minutes" min={1} max={1440} value={d.repeat_every_min} onChange={(v) => set("repeat_every_min", v)} />
            <NumField id="w-stop" label="Stop by itself after" unit="hours" min={0} max={720} value={d.stop_after_hours} onChange={(v) => set("stop_after_hours", v)} hint="0: only when it's handled." />
          </div>
          <div>
            <Label>Quiet hours (nothing rings, Cairo time)</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="w-36 shrink-0">
                <Input type="time" value={d.quiet_from ?? ""} onChange={(e) => set("quiet_from", e.target.value || null)} aria-label="Quiet from" />
              </div>
              <span className="text-sm text-muted">to</span>
              <div className="w-36 shrink-0">
                <Input type="time" value={d.quiet_to ?? ""} onChange={(e) => set("quiet_to", e.target.value || null)} aria-label="Quiet until" />
              </div>
              {(d.quiet_from || d.quiet_to) && (
                <Button size="sm" variant="ghost" onClick={() => setD((x) => ({ ...x, quiet_from: null, quiet_to: null }))}>
                  None
                </Button>
              )}
            </div>
            <Hint>{quietBad ? "Set both times, or neither." : "Empty: it rings any time."}</Hint>
          </div>
          <Toggle checked={d.cc_admins} onChange={(v) => set("cc_admins", v)} label="Admins get every alert too" hint="Not only the team members in that group." />
        </div>
      </Section>

      <Section
        title="Calls"
        hint="When nobody acts on the alerts, Ikli calls each person on it inside iklipse, again and again until they answer, and tells them why."
      >
        <div className="space-y-4 pt-3">
          <Toggle
            checked={d.calls_enabled}
            onChange={(v) => set("calls_enabled", v)}
            label="Call when nobody acts"
            hint="With the app open: a call screen that rings until they answer or decline. With it closed: a notification that rings on their phone, again each time."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumField id="w-before" label="Start calling after" unit="alerts" min={1} max={100} value={d.alerts_before_call} onChange={(v) => set("alerts_before_call", v)} />
            <NumField id="w-retry" label="No answer: call again after" unit="minutes" min={1} max={120} value={d.call_retry_min} onChange={(v) => set("call_retry_min", v)} />
            <NumField id="w-every" label="Answered but still open: call again every" unit="minutes" min={5} max={1440} value={d.call_every_min} onChange={(v) => set("call_every_min", v)} />
            <NumField id="w-max" label="Most calls per person" unit="calls" min={0} max={500} value={d.max_calls} onChange={(v) => set("max_calls", v)} hint="0: no limit." />
          </div>
          <div>
            <Label>Ikli speaks</Label>
            <Segmented
              value={d.call_language}
              onChange={(v) => set("call_language", v)}
              options={[
                { value: "en", label: "English" },
                { value: "ar", label: "Egyptian Arabic" },
              ]}
            />
            <Hint>Claude writes what to say; the voice is the voice agent's (ElevenLabs).</Hint>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" iconLeft={<PhoneCall size={14} />} loading={test.isPending} onClick={() => test.mutate()}>
              Test call to me
            </Button>
            {!ov.my_push && <span className="text-xs text-warn">Turn on notifications on your phone (profile menu) so calls reach it when the app is closed.</span>}
          </div>
        </div>
      </Section>

      <div className="sticky bottom-0 -mx-3 sm:-mx-4 md:-mx-6 border-t border-border bg-bg/95 backdrop-blur px-3 sm:px-4 md:px-6 py-3 flex items-center gap-3">
        <Button variant="primary" disabled={!dirty || !!bad || quietBad} loading={save.isPending} onClick={() => save.mutate()}>
          Save settings
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setD(initial)}>
            Undo changes
          </Button>
        )}
        {bad && <span className="text-sm text-danger">Check the numbers.</span>}
      </div>
    </div>
  );
}
