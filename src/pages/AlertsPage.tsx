import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BellOff,
  BellRing,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  Hash,
  Lock,
  Mail,
  PhoneCall,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Trash2,
  Users2,
  X,
} from "lucide-react";
import { KIND_ICON } from "@/components/alerts/kinds";
import { MetricsTab } from "@/components/alerts/MetricsTab";
import { BrainTab } from "@/components/alerts/BrainTab";
import { DateField } from "@/components/ui/DateField";
import { Pager, usePaged } from "@/components/ui/Pager";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { LineTabs, type LineTab } from "@/components/ui/LineTabs";
import { SearchField } from "@/components/ui/SearchField";
import { Select } from "@/components/ui/Select";
import { Segmented, Switch, Toggle } from "@/components/ui/Controls";
import { InfoTip } from "@/components/ui/InfoTip";
import { NumberRow, SettingGroup, SettingRow, SwitchRow } from "@/components/ui/SettingRows";
import { PillTabs } from "@/components/ui/PillTabs";
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
  editGroup,
  fetchAlerts,
  fetchCalendlyChoices,
  fetchMailWatchPeople,
  fetchSlackChannels,
  fetchWatchGroups,
  fetchWatchOverview,
  KIND_LABEL,
  setPerson,
  linkSlackUser,
  reopenAlert,
  saveSlack,
  saveWatchSettings,
  setGroupMonitored,
  setGroupReplies,
  setMailWatch,
  setSlackMonitored,
  SLACK_EVENTS_URL,
  slackManifest,
  slackStatus,
  snoozeAlert,
  span,
  syncGroups,
  syncSlack,
  testCall,
  type AlertKind,
  type GroupKind,
  type GroupParticipant,
  type GroupProject,
  type MailWatchPerson,
  type MyMailAccount,
  type SlackChannel,
  type SlackMember,
  type SlackParticipant,
  type WatchAlert,
  type WatchGroup,
  type WatchMember,
  type WatchOverview,
  type WatchSettings,
} from "@/lib/watchApi";
import { LIVE_FALLBACK } from "@/lib/live";

// -----------------------------------------------------------------------------
// Alerts: the WhatsApp watch. The bot reads the WhatsApp groups it's in; when a
// client is left without a reply, or someone promises something, an alert
// rings the team members in that group (only the person it's about, when it's
// about one person): notifications again and again, then phone calls, until
// someone marks it handled. Email works the same way: each person turns on
// their own Gmail accounts (Email tab), and alerts from client or ad platform
// emails ring only that mailbox's owner. Slack too: the iklipse Slack app reads
// the channels it's invited to, like the bot reads groups (Slack tab: admins
// set up the app, pick the channels and say who on Slack is who on the team).
// Everyone sees the alerts on them; admins see all, the bot's groups (and who
// on the team is in each), the Slack channels, everyone's email and the
// settings, the bot's numbers (Metrics: messages, replies, alerts, AI cost),
// and the brain (Claude for the team on WhatsApp: its switch, settings, runs).
// The iklipse apps, where Ikli's calls ring like real ones, have
// their own page (Apps). ?a=<id> opens an alert (notifications link there),
// ?tab= a tab.
// -----------------------------------------------------------------------------

type Tab = "open" | "closed" | "email" | "groups" | "slack" | "metrics" | "brain" | "settings";
const TABS: Tab[] = ["open", "closed", "email", "groups", "slack", "metrics", "brain", "settings"];

/** Kinds about someone waiting (since the alert opened), not something due. */
const waits = (k: AlertKind) => k === "unanswered" || k === "ads";

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
  const ov = useQuery({ queryKey: ["watch-overview"], queryFn: fetchWatchOverview, refetchInterval: LIVE_FALLBACK });
  const admin = !!ov.data?.is_admin;
  const asked = params.get("tab") as Tab | null;
  const tab: Tab = asked && TABS.includes(asked) && (admin || asked === "open" || asked === "closed" || asked === "email") ? asked : "open";
  const focus = params.get("a");
  const setTab = (t: Tab) => setParams(t === "open" ? {} : { tab: t }, { replace: true });
  const [q, setQ] = useState("");

  const open = useQuery({ queryKey: ["watch-alerts", true], queryFn: () => fetchAlerts(true), refetchInterval: LIVE_FALLBACK });
  const closed = useQuery({ queryKey: ["watch-alerts", false], queryFn: () => fetchAlerts(false), enabled: tab === "closed" });

  const tabs: LineTab<Tab>[] = [
    { value: "open", label: "Open", count: open.data?.length },
    { value: "closed", label: "Closed" },
    { value: "email", label: "Email", count: admin ? ov.data?.mail?.watched : undefined },
    ...(admin
      ? ([
          { value: "groups", label: "Groups", count: ov.data?.bot?.monitored },
          { value: "slack", label: "Slack", count: ov.data?.slack?.monitored },
          { value: "metrics", label: "Metrics" },
          { value: "brain", label: "Brain" },
          { value: "settings", label: "Settings" },
        ] as LineTab<Tab>[])
      : []),
  ];

  const list = tab === "closed" ? closed : open;
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase();
    const rows = list.data ?? [];
    if (!words) return rows;
    return rows.filter((a) =>
      [a.title, a.detail, a.person, a.group.name, a.slack?.name, a.mail?.subject, a.mail?.from, a.mail?.email, ...a.recipients.map((r) => r.name)].join(" ").toLowerCase().includes(words),
    );
  }, [list.data, q]);
  const paged = usePaged(shown, "alerts");

  // The Apps tab moved to its own page.
  if ((asked as string | null) === "apps") return <Navigate to="/apps" replace />;
  if (ov.isLoading) return <PageSpinner />;

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-4 md:p-6">
        <div className="flex flex-wrap items-start sm:items-center gap-3 mb-4">
          <div className="flex-1 min-w-[12rem]">
            <PageTitle count={open.data && `${open.data.length} open`} info="Clients waiting for a reply and promises in the WhatsApp groups, Slack channels and the team's email, ringing until someone handles them.">Alerts</PageTitle>
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
          {admin && ov.data && (tab === "open" || tab === "slack") && <SlackNote ov={ov.data} onSettings={() => setTab("settings")} onlyErrors={tab === "open"} />}
          {tab === "email" && ov.data && <EmailTab ov={ov.data} alerts={open.data} onSettings={() => setTab("settings")} />}
          {tab === "groups" && ov.data && <GroupsTab ov={ov.data} />}
          {tab === "slack" && ov.data && <SlackTab ov={ov.data} />}
          {tab === "metrics" && <MetricsTab />}
          {tab === "brain" && <BrainTab />}
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
                      ? "When a client waits for a reply or someone promises something in a WhatsApp group, a Slack channel or an email, it shows up here."
                      : undefined
                }
              />
            ) : (
              <>
              <ul className={ROWS}>
                {paged.rows.map((a, i) => (
                  <AlertRow key={a.id} a={a} admin={admin} index={i} focused={focus === a.id} />
                ))}
              </ul>
              <Pager {...paged.pager} />
              </>
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
  if (a.status === "resolved") {
    const where = a.source === "email" ? "the email" : a.source === "slack" ? "the channel" : "the group";
    return { text: `Dealt with in ${where}`, tone: "success" };
  }
  if (a.status === "stopped") return { text: "Stopped", tone: "muted" };
  if (a.snoozed_until && Date.parse(a.snoozed_until) > now) return { text: `Snoozed until ${clock(a.snoozed_until)}`, tone: "muted" };
  if (a.recipients.some((r) => r.calling)) return { text: "Ikli is calling", tone: "danger" };
  if (a.calls_made > 0) return { text: `Calling · ${a.calls_made} ${a.calls_made === 1 ? "call" : "calls"}`, tone: "danger" };
  if (a.alerts_sent > 0) return { text: `Ringing · ${a.alerts_sent} ${a.alerts_sent === 1 ? "alert" : "alerts"}`, tone: "warn" };
  if (Date.parse(a.due_at) > now) return { text: `${waits(a.kind) ? "Rings" : "Due"} ${clock(a.due_at)}`, tone: "accent" };
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
  resumed: "Resumed",
  reminders: "Reminders",
  reminder: "Reminder",
  stopped: "Stopped",
  reopened: "Reopened",
  held: "The bot replied",
  updated: "Updated",
};

function AlertRow({ a, admin, index, focused }: { a: WatchAlert; admin: boolean; index: number; focused: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(focused);
  const Icon = KIND_ICON[a.kind] ?? BellRing;
  const stage = stageText(a);
  const canAct = a.status === "open" && (admin || a.mine);
  const waiting = Date.now() - Date.parse(waits(a.kind) ? a.created_at : a.due_at);
  // My own mailbox: the email opens on the Mail page.
  const mailLink = a.mail?.mine ? `/mail?account=${encodeURIComponent(a.mail.account_id)}&thread=${encodeURIComponent(a.mail.thread_id)}` : null;
  // Slack: the message, in Slack.
  const slackLink = a.slack?.url && (canAct || admin) ? a.slack.url : null;

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
            {a.source === "email" ? (
              <span className="inline-flex items-center gap-1 min-w-0 break-words">
                <Mail size={12} className="shrink-0" /> {a.mail?.subject || "(no subject)"}
                {a.mail?.from && ` · from ${a.mail.from}`}
              </span>
            ) : a.source === "slack" ? (
              <span className="inline-flex items-center gap-1 min-w-0 break-words">
                <Hash size={12} className="shrink-0" /> {a.slack?.name ? `#${a.slack.name}` : "Slack channel"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Users2 size={12} /> {a.group.name ?? "WhatsApp group"}
              </span>
            )}
            <span>{KIND_LABEL[a.kind]}</span>
            {a.status === "open" ? (
              Date.parse(a.due_at) <= Date.now() && <span className="inline-flex items-center gap-1"><Clock size={12} /> {span(waiting)}{waits(a.kind) ? " waiting" : " late"}</span>
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

      {(canAct || mailLink || slackLink || (admin && a.status !== "open")) && (
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
          {mailLink && (
            <Link to={mailLink}>
              <Button size="sm" iconLeft={<Mail size={14} />}>
                Open email
              </Button>
            </Link>
          )}
          {slackLink && (
            <a href={slackLink} target="_blank" rel="noopener noreferrer">
              <Button size="sm" iconLeft={<ExternalLink size={14} />}>
                Open in Slack
              </Button>
            </a>
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
            {a.mail && <div className={cn(a.person ? "mt-1" : "mt-3", "text-sm text-muted break-words")}>Mailbox: {a.mail.email}</div>}
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
    text = "The WhatsApp bot isn't set up: its Green API connection is missing.";
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
  return <WarnNote text={text} action={action} />;
}

/** Something to fix before alerts can come, with the button that fixes it. */
function WarnNote({ text, action }: { text: ReactNode; action?: ReactNode }) {
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

// ------------------------------------------------------------------- email --

/** Turn watching a Gmail account on or off. */
function useMailWatch() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ account, on }: { account: string; on: boolean }) => setMailWatch(account, on),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      void qc.invalidateQueries({ queryKey: ["mail-watch-people"] });
      void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });
}

function EmailTab({ ov, alerts, onSettings }: { ov: WatchOverview; alerts: WatchAlert[] | undefined; onSettings: () => void }) {
  const mine = ov.my_mail ?? [];
  // Open alerts per account (the open list has all of mine).
  const openBy = useMemo(() => {
    const n = new Map<string, number>();
    for (const a of alerts ?? []) if (a.status === "open" && a.mail) n.set(a.mail.account_id, (n.get(a.mail.account_id) ?? 0) + 1);
    return n;
  }, [alerts]);

  return (
    <>
      {ov.is_admin && ov.settings?.mail_enabled === false && (
        <WarnNote
          text="Watching email is off."
          action={
            <Button size="sm" variant="secondary" onClick={onSettings}>
              Open settings
            </Button>
          }
        />
      )}
      <Section title="My email" hint="Turn on the accounts you get client emails on." info="Claude reads new emails in the accounts you turn on. Alerts about them ring only you.">
        {!mine.length ? (
          <div className="py-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted">No Gmail connected yet</span>
            <Link to="/connections">
              <Button size="sm" iconLeft={<Mail size={14} />}>
                Connect Gmail
              </Button>
            </Link>
          </div>
        ) : (
          <ul className={ROWS}>
            {mine.map((m, i) => (
              <MyMailRow key={m.account_id} m={m} open={openBy.get(m.account_id) ?? 0} index={i} />
            ))}
          </ul>
        )}
      </Section>
      {ov.is_admin && <TeamMail />}
    </>
  );
}

function MyMailRow({ m, open, index }: { m: MyMailAccount; open: number; index: number }) {
  const confirm = useConfirm();
  const watch = useMailWatch();
  return (
    <li className="rise py-3" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("font-semibold break-all", m.watching ? "text-ink" : "text-muted")}>{m.email}</span>
            {open > 0 && <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TONE.warn)}>{open} open</span>}
          </div>
          {!m.watching ? (
            <div className="mt-1 text-xs text-subtle">Not watched</div>
          ) : m.last_error ? (
            <div className="mt-1 text-xs text-danger break-words">{m.last_error}</div>
          ) : (
            <div className="mt-1 text-xs text-subtle">{m.checked_at ? `Checked ${relativeTime(m.checked_at)}` : "Not checked yet"}</div>
          )}
        </div>
        <div className="shrink-0 pt-0.5">
          <Toggle
            checked={m.watching}
            disabled={watch.isPending}
            label="Watch"
            onChange={async (on) => {
              if (!on && open > 0 && !(await confirm({ title: `Stop watching ${m.email}?`, message: "Its open alerts stop too.", confirmLabel: "Stop watching", danger: true }))) return;
              watch.mutate({ account: m.account_id, on });
            }}
          />
        </div>
      </div>
    </li>
  );
}

/** Admins: everyone's Gmail accounts, and which are watched. */
function TeamMail() {
  const people = useQuery({ queryKey: ["mail-watch-people"], queryFn: fetchMailWatchPeople, refetchInterval: LIVE_FALLBACK });
  const rows = people.data ?? [];
  const paged = usePaged(rows, "team-mail");
  const watching = rows.filter((p) => p.accounts.some((a) => a.watching)).length;
  return (
    <Section title="The team" count={people.data ? watching : undefined} info="Each person turns on their own accounts. You can stop any of them, and only the owner can turn it on again.">
      {people.isLoading ? (
        <PageSpinner />
      ) : people.error && !people.data ? (
        <div className="py-3 text-sm text-danger break-words">Couldn't load the team: {(people.error as Error).message}</div>
      ) : (
        <>
        <ul className={ROWS}>
          {paged.rows.map((p, i) => (
            <PersonMailRow key={p.id} p={p} index={i} />
          ))}
        </ul>
        <Pager {...paged.pager} />
        </>
      )}
    </Section>
  );
}

function PersonMailRow({ p, index }: { p: MailWatchPerson; index: number }) {
  return (
    <li className="rise py-3" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex items-center gap-3">
        <Avatar src={p.avatar_url} name={p.name} size={28} />
        <span className="min-w-0 font-semibold text-ink break-words">{p.name}</span>
      </div>
      {p.accounts.length ? (
        <ul className="mt-2 ml-10 space-y-2">
          {p.accounts.map((a) => (
            <TeamMailAccount key={a.account_id} a={a} />
          ))}
        </ul>
      ) : (
        <div className="mt-1 ml-10 text-xs text-subtle">No Gmail connected</div>
      )}
    </li>
  );
}

function TeamMailAccount({ a }: { a: MailWatchPerson["accounts"][number] }) {
  const confirm = useConfirm();
  const watch = useMailWatch();
  return (
    <li className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("text-sm break-all", a.watching ? "text-ink" : "text-muted")}>{a.email}</span>
          {a.open_alerts > 0 && <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TONE.warn)}>{a.open_alerts} open</span>}
        </div>
        <div className="text-xs text-subtle">{a.watching ? `Watching${a.checked_at ? ` · checked ${relativeTime(a.checked_at)}` : ""}` : "Not watched"}</div>
        {a.watching && a.last_error && <div className="text-xs text-danger break-words">{a.last_error}</div>}
      </div>
      {a.watching && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start sm:self-auto"
          loading={watch.isPending}
          onClick={async () => {
            const msg = `${a.open_alerts > 0 ? "Its open alerts stop too. " : ""}Only its owner can turn it on again.`;
            if (!(await confirm({ title: `Stop watching ${a.email}?`, message: msg, confirmLabel: "Stop watching", danger: true }))) return;
            watch.mutate({ account: a.account_id, on: false });
          }}
        >
          Stop watching
        </Button>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ groups --

function GroupsTab({ ov }: { ov: WatchOverview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const groups = useQuery({ queryKey: ["watch-groups"], queryFn: fetchWatchGroups, refetchInterval: LIVE_FALLBACK });
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
  const ours = live.filter((g) => g.kind === "team");
  const theirs = live.filter((g) => g.kind !== "team");
  const pagedOurs = usePaged(ours, "groups-ours");
  const pagedTheirs = usePaged(theirs, "groups-theirs");
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
        <>
          {ours.length > 0 && (
            <Section
              title="Team groups"
              count={ours.length}
              info={"Our own groups:\nThe bot asks for clients' details here, takes orders from anyone in them, and posts alerts (Settings).\nNobody in them counts as a client, and Claude doesn't read them for alerts."}
            >
              <ul className={ROWS}>
                {pagedOurs.rows.map((g, i) => (
                  <GroupRow key={g.chat_id} g={g} members={groups.data!.members} projects={groups.data!.projects} index={i} />
                ))}
              </ul>
              <Pager {...pagedOurs.pager} />
            </Section>
          )}
          <Section
            title="Client groups"
            count={theirs.length}
            info={"Turn off a group to stop watching it.\nOpen a group to link each team number to its person, pick its project, or make it a team group.\nEveryone else in a client group is a client, kept in Clients (Projects)."}
          >
            <ul className={ROWS}>
              {pagedTheirs.rows.map((g, i) => (
                <GroupRow key={g.chat_id} g={g} members={groups.data!.members} projects={groups.data!.projects} index={i} />
              ))}
              {!theirs.length && <li className="py-3 text-sm text-muted">No client groups.</li>}
            </ul>
            <Pager {...pagedTheirs.pager} />
            {left.length > 0 && <div className="pt-3 text-xs text-subtle">The bot left: {left.map((g) => g.name ?? "Unnamed").join(", ")}</div>}
          </Section>
        </>
      )}
    </>
  );
}

/** The WhatsApp id of someone whose number WhatsApp hides: they're linked by it. */
/** Who someone in a group is, besides a team member (their id): a client, or not a client (a freelancer, a partner). */
const CLIENT = "client";
const OTHER = "other";
const hiddenId = (p: { lid?: string | null; wa_id: string }) => (p.lid?.endsWith("@lid") ? p.lid : p.wa_id.endsWith("@lid") ? p.wa_id : null);

/** What Clients has about someone in a client group, and whether the bot is asking. */
function clientLine(c: GroupParticipant["client"]) {
  if (!c) return " · a client, added soon";
  const bits = [c.email ?? "no email yet", c.company].filter(Boolean);
  const asking = c.skip ? "not asked about" : c.asked == null ? null : c.asked === 0 ? "the bot will ask" : `asked ${c.asked} ${c.asked === 1 ? "time" : "times"}`;
  return ` · ${[...bits, asking].filter(Boolean).join(" · ")}`;
}

function GroupRow({ g, members, projects, index }: { g: WatchGroup; members: WatchMember[]; projects: GroupProject[]; index: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const isTeam = g.kind === "team";
  const team = g.participants.filter((p) => p.user_id && !p.is_bot);
  const bots = g.participants.filter((p) => p.is_bot);
  const others = g.participants.filter((p) => !p.user_id && !p.is_bot);
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
    mutationFn: ({ phone, value }: { phone: string; value: string }) =>
      value === CLIENT ? setPerson(phone, "client", null) : value === OTHER ? setPerson(phone, "other", null) : setPerson(phone, "team", value),
    onSuccess: () => {
      after();
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change who this is", description: e.message }),
  });
  const replies = useMutation({
    mutationFn: (on: boolean) => setGroupReplies(g.chat_id, on),
    onSuccess: after,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });
  const edit = useMutation({
    mutationFn: ({ kind, project }: { kind: GroupKind; project: string | null }) => editGroup(g.chat_id, kind, project),
    onSuccess: () => {
      after();
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change the group", description: e.message }),
  });
  const options = [
    { value: CLIENT, label: "A client" },
    { value: OTHER, label: "Not a client" },
    ...members.filter((m) => m.active).map((m) => ({ value: m.id, label: m.name })),
  ];
  const projectOptions = [
    { value: "", label: "No project" },
    ...(g.project && !projects.some((p) => p.id === g.project!.id) ? [{ value: g.project.id, label: g.project.title }] : []),
    ...projects.map((p) => ({ value: p.id, label: p.client ? `${p.title} (${p.client})` : p.title })),
  ];

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
            {g.project && <span>Project: {g.project.title}</span>}
            {!isTeam && g.bot_replies && <span className="text-accent">The bot replies</span>}
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
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center animate-fade-in">
          <Select
            className="sm:w-44"
            size="sm"
            value={g.kind}
            disabled={edit.isPending}
            aria-label="What this group is"
            options={[
              { value: "client", label: "Client group" },
              { value: "team", label: "Team group" },
            ]}
            onChange={async (v) => {
              const kind = v as GroupKind;
              if (kind === g.kind) return;
              if (
                kind === "team" &&
                !(await confirm({
                  title: `Make ${g.name ?? "this group"} a team group?`,
                  message: `Nobody in it counts as a client, and Claude stops reading it for alerts.${g.open_alerts ? " Its open alerts stop." : ""}`,
                  confirmLabel: "Make it a team group",
                }))
              )
                return;
              edit.mutate({ kind, project: kind === "team" ? null : g.project?.id ?? null });
            }}
          />
          {!isTeam && (
            <Select
              className="sm:w-72"
              size="sm"
              value={g.project?.id ?? ""}
              disabled={edit.isPending}
              searchable={projectOptions.length > 8}
              aria-label="The project it's for"
              options={projectOptions}
              onChange={(v) => edit.mutate({ kind: g.kind, project: v || null })}
            />
          )}
        </div>
      )}
      {open && !isTeam && (
        <div className="mt-3 animate-fade-in">
          <div className="flex items-center gap-3">
            <Switch
              checked={g.bot_replies}
              disabled={replies.isPending}
              onChange={async (on) => {
                if (on && !(await confirm({ title: `Let the bot reply in ${g.name ?? "this group"}?`, message: "It writes to the client there when they wait too long, and sends the booking link when they ask for a call.", confirmLabel: "Let it reply" }))) return;
                replies.mutate(on);
              }}
              label="The bot replies here"
            />
            <span className="text-sm text-ink">The bot replies here</span>
            <InfoTip
              text={'When an alert first rings, a client left without a reply gets "Thanks, we got your message and we\'ll get back to you shortly."\nOutside working hours they get at once "we\'ll get back to you as soon as the team is online."\nOnce, and the alert rings as before.'}
            />
          </div>
        </div>
      )}
      {open && (
        <ul className="mt-3 rounded-lg border border-border divide-y divide-line animate-fade-in">
          {[...team, ...bots, ...others].map((p) => (
            <li key={p.wa_id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-ink break-words">
                  {p.is_bot ? "The bot" : p.user_name ?? (p.client?.name_known ? p.client.name : null) ?? p.name ?? (p.phone ? `+${p.phone}` : "Hidden number")}
                  {p.is_admin && <span className="ml-2 text-xs text-subtle">group admin</span>}
                </div>
                <div className="text-xs text-subtle">
                  {p.phone ? `+${p.phone}` : "WhatsApp hides this number"}
                  {p.user_name && p.name && p.name !== p.user_name ? ` · ${p.name} on WhatsApp` : ""}
                  {p.is_bot
                    ? isTeam
                      ? " · asks here for clients' details"
                      : " · reads the group"
                    : p.user_id
                      ? ""
                      : p.other
                        ? " · not a client (a freelancer, a partner)"
                        : isTeam
                          ? " · not linked to anyone on the team"
                          : clientLine(p.client)}
                </div>
              </div>
              {!p.is_bot && (p.phone || hiddenId(p)) && (
                <Select
                  className="sm:w-48"
                  size="sm"
                  value={p.user_id ?? (p.other ? OTHER : CLIENT)}
                  options={options}
                  aria-label="Who this is"
                  disabled={link.isPending}
                  onChange={(v) => link.mutate({ phone: p.phone ?? hiddenId(p)!, value: v })}
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

// ------------------------------------------------------------------- slack --

/** The Slack app's state, in plain words. */
function slackStateText(state: string | null | undefined): { text: string; ok: boolean } {
  if (!state) return { text: "Not checked yet", ok: false };
  return state === "ok" ? { text: "Connected", ok: true } : { text: state, ok: false };
}

/** Check the Slack app's token with Slack. */
function useSlackCheck() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: slackStatus,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      toast.push(r.ok ? { kind: "success", title: `Connected to ${r.team ?? "Slack"}` } : { kind: "error", title: "The Slack app has a problem", description: r.error });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't check Slack", description: e.message }),
  });
}

/** Something wrong with the Slack app (on the Open tab: only when it's broken). Not set up: the setup says it all. */
function SlackNote({ ov, onSettings, onlyErrors }: { ov: WatchOverview; onSettings: () => void; onlyErrors: boolean }) {
  const check = useSlackCheck();
  const s = ov.slack;
  if (!s?.configured) return null;
  let text: ReactNode = null;
  let action: ReactNode = null;
  if (s.state && s.state !== "ok") {
    text = `The Slack app: ${s.state}.`;
    action = (
      <Button size="sm" variant="secondary" loading={check.isPending} onClick={() => check.mutate()}>
        Check again
      </Button>
    );
  } else if (onlyErrors) {
    return null;
  } else if (s.state === "ok" && !ov.settings?.slack_enabled) {
    text = "Watching Slack is off.";
    action = (
      <Button size="sm" variant="secondary" onClick={onSettings}>
        Open settings
      </Button>
    );
  } else if (ov.settings?.slack_enabled && !s.hook_at) {
    text = "Slack hasn't sent anything yet. Check the Event Subscriptions URL in the Slack app, and invite the app to a channel.";
  }
  if (!text) return null;
  return <WarnNote text={text} action={action} />;
}

function SlackTab({ ov }: { ov: WatchOverview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const check = useSlackCheck();
  const channels = useQuery({ queryKey: ["watch-slack"], queryFn: fetchSlackChannels, refetchInterval: LIVE_FALLBACK });
  const sync = useMutation({
    mutationFn: syncSlack,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["watch-slack"] });
      void qc.invalidateQueries({ queryKey: ["watch-overview"] });
      toast.push({ kind: "success", title: `${r.channels} ${r.channels === 1 ? "channel" : "channels"}`, description: r.read < r.channels ? "The rest are read over the next few minutes." : undefined });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't read the channels", description: e.message }),
  });
  // Set up: the setup stays folded away until "Change the Slack app".
  const [changing, setChanging] = useState(false);
  const slack = ov.slack;
  const configured = !!slack?.configured;
  const st = slackStateText(slack?.state);
  const rows = channels.data?.channels ?? [];
  const live = rows.filter((c) => !c.left);
  const left = rows.filter((c) => c.left);
  const pagedLive = usePaged(live, "slack-channels");

  return (
    <>
      <Section
        title="The iklipse Slack app"
        action={
          <Button size="sm" iconLeft={<RefreshCw size={14} />} loading={sync.isPending} disabled={!configured} onClick={() => sync.mutate()}>
            Read the channels
          </Button>
        }
      >
        <div className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm text-muted flex flex-wrap gap-x-5 gap-y-1">
            <span className="inline-flex items-center gap-1.5 min-w-0 break-words">
              <Hash size={14} className="shrink-0" />
              {slack?.team ?? (configured ? "Slack workspace" : "Not set up")}
            </span>
            <span className={cn("break-words", st.ok ? "text-success" : "text-warn")}>{st.text}</span>
            {slack?.hook_at && <span>Last message {relativeTime(slack.hook_at)}</span>}
            {slack?.synced_at && <span>Channels read {relativeTime(slack.synced_at)}</span>}
          </div>
          {configured && (
            <div className="shrink-0 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" loading={check.isPending} onClick={() => check.mutate()}>
                Check again
              </Button>
              {!changing && (
                <Button size="sm" variant="ghost" onClick={() => setChanging(true)}>
                  Change the Slack app
                </Button>
              )}
            </div>
          )}
        </div>
      </Section>

      {(!configured || changing) && <SlackSetup configured={configured} onDone={() => setChanging(false)} />}

      {channels.isLoading ? (
        <PageSpinner />
      ) : channels.error && !channels.data ? (
        <EmptyState icon={<AlertTriangle size={20} />} title="Couldn't load the channels" description={(channels.error as Error).message} />
      ) : !rows.length ? (
        <EmptyState
          icon={<Hash size={20} />}
          title="No channels yet"
          description="Invite the iklipse app to your client channels in Slack (/invite @iklipse), then press Read the channels. New channels start off: turn on the ones to watch."
        />
      ) : (
        <Section
          title="Channels"
          count={live.length}
          info={"Turn on the channels to watch.\nOpen a channel to link each Slack person to their team member, so Claude knows who is on the team. People with the same email are linked by themselves."}
        >
          <ul className={ROWS}>
            {pagedLive.rows.map((c, i) => (
              <SlackChannelRow key={c.channel_id} c={c} members={channels.data!.members} index={i} />
            ))}
          </ul>
          <Pager {...pagedLive.pager} />
          {left.length > 0 && <div className="pt-3 text-xs text-subtle break-words">The app left: {left.map((c) => `#${c.name ?? "unnamed"}`).join(", ")}</div>}
        </Section>
      )}
    </>
  );
}

/** A numbered step of the Slack setup. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="py-3 flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5 text-sm text-ink">{children}</div>
    </li>
  );
}

/** Make the Slack app from the manifest, then save its token and signing secret (or remove Slack). */
function SlackSetup({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const manifest = useMemo(() => slackManifest(), []);
  const ready = !!token.trim() && !!secret.trim();
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["watch-overview"] });
    void qc.invalidateQueries({ queryKey: ["watch-slack"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      await saveSlack(token.trim(), secret.trim());
      // Saved either way; the check only says whether Slack takes the token.
      return slackStatus().catch((e: Error) => ({ ok: false, team: null, url: null, error: e.message }));
    },
    onSuccess: (r) => {
      after();
      setToken("");
      setSecret("");
      if (r.ok) {
        toast.push({ kind: "success", title: `Connected to ${r.team ?? "Slack"}`, description: "Now invite the app to your client channels." });
        onDone();
      } else {
        toast.push({ kind: "error", title: "Saved, but Slack has a problem", description: r.error });
      }
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => saveSlack("", ""),
    onSuccess: () => {
      after();
      void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
      toast.push({ kind: "success", title: "Slack removed" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't remove Slack", description: e.message }),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(manifest);
      toast.push({ kind: "success", title: "Copied" });
    } catch {
      toast.push({ kind: "error", title: "Couldn't copy", description: "Select the manifest and copy it by hand." });
    }
  };

  return (
    <Section
      title={configured ? "Change the Slack app" : "Set up the Slack app"}
      info="Once, with a Slack account that can add apps to your workspace."
      action={
        configured && (
          <Button size="sm" variant="ghost" onClick={onDone}>
            Close
          </Button>
        )
      }
    >
      <ol className={cn(ROWS, "border-b border-line")}>
        <Step n={1}>
          Open Slack apps, choose <b className="font-semibold">From a manifest</b>, pick your workspace, paste the manifest below and press{" "}
          <b className="font-semibold">Create</b>.
          <div className="mt-2">
            <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener noreferrer">
              <Button size="sm" iconLeft={<ExternalLink size={14} />}>
                Open Slack apps
              </Button>
            </a>
          </div>
        </Step>
        <Step n={2}>
          The manifest:
          <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-inset p-3 font-mono text-xs text-ink">{manifest}</pre>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button size="sm" iconLeft={<Copy size={14} />} className="self-start" onClick={() => void copy()}>
              Copy
            </Button>
            <span className="min-w-0 text-xs text-subtle break-all">Events URL: {SLACK_EVENTS_URL}</span>
          </div>
        </Step>
        <Step n={3}>
          Press <b className="font-semibold">Install to Workspace</b>, then copy the <b className="font-semibold">Bot User OAuth Token</b> (it starts with
          xoxb-) from <b className="font-semibold">OAuth & Permissions</b>.
        </Step>
        <Step n={4}>
          In <b className="font-semibold">Basic Information</b>, under <b className="font-semibold">App Credentials</b>, copy the{" "}
          <b className="font-semibold">Signing Secret</b>.
        </Step>
        <Step n={5}>
          Paste both below and press Save. Then in Slack, invite the app to each client channel: <span className="font-mono text-xs">/invite @iklipse</span>.
          Press Read the channels and turn on the ones to watch.
          <form
            className="mt-3 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) save.mutate();
            }}
          >
            <div className="min-w-0">
              <Label htmlFor="slack-token">Bot token</Label>
              <Input id="slack-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="xoxb-..." autoComplete="off" spellCheck={false} />
            </div>
            <div className="min-w-0">
              <Label htmlFor="slack-secret">Signing secret</Label>
              <Input id="slack-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
            </div>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" variant="primary" loading={save.isPending} disabled={!ready || remove.isPending}>
                Save
              </Button>
              {configured && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  iconLeft={<Trash2 size={14} />}
                  className="!text-danger hover:!bg-danger/10"
                  loading={remove.isPending}
                  disabled={save.isPending}
                  onClick={async () => {
                    const ok = await confirm({ title: "Remove the Slack app?", message: "Watching Slack stops and its open alerts stop too.", confirmLabel: "Remove", danger: true });
                    if (ok) remove.mutate();
                  }}
                >
                  Remove Slack
                </Button>
              )}
            </div>
          </form>
        </Step>
      </ol>
    </Section>
  );
}

/** Under a Slack person's name: their email, and how they count. */
function slackWho(p: SlackParticipant) {
  const bits = [
    p.is_app ? null : p.email,
    p.user_name && p.name && p.name !== p.user_name ? `${p.name} on Slack` : null,
    p.guest ? "guest" : null,
    p.external ? "other company" : null,
    p.is_app ? "reads the channel, never writes" : p.is_bot ? "an app, not counted" : p.user_id ? (p.by_email ? "linked by email" : null) : "counted as the client",
  ].filter((b): b is string => !!b);
  const text = bits.join(" · ");
  // An email stays as it is; words start with a capital.
  return bits[0] === p.email ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function SlackChannelRow({ c, members, index }: { c: SlackChannel; members: SlackMember[]; index: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const isApp = (p: SlackParticipant) => p.is_app || p.is_bot;
  const team = c.participants.filter((p) => p.user_id && !isApp(p));
  // The iklipse app first, then other apps.
  const apps = c.participants.filter(isApp).sort((a, b) => Number(b.is_app) - Number(a.is_app));
  const others = c.participants.filter((p) => !p.user_id && !isApp(p));
  const after = () => {
    void qc.invalidateQueries({ queryKey: ["watch-slack"] });
    void qc.invalidateQueries({ queryKey: ["watch-overview"] });
    void qc.invalidateQueries({ queryKey: ["watch-alerts"] });
  };
  const watch = useMutation({
    mutationFn: (on: boolean) => setSlackMonitored(c.channel_id, on),
    onSuccess: after,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't change it", description: e.message }),
  });
  const link = useMutation({
    mutationFn: ({ slack, user }: { slack: string; user: string | null }) => linkSlackUser(slack, user),
    onSuccess: after,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't link them", description: e.message }),
  });
  const options = [{ value: "", label: "Not on the team" }, ...members.filter((m) => m.active).map((m) => ({ value: m.id, label: m.name }))];
  const name = `#${c.name ?? "unnamed"}`;

  return (
    <li className="rise py-3" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("min-w-0 font-semibold break-words", c.monitored ? "text-ink" : "text-muted")}>
              {c.is_private && <Lock size={12} className="mr-1 inline-block align-baseline" aria-label="Private" />}
              {name}
            </span>
            {c.is_shared && <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TONE.muted)}>Shared</span>}
            {c.open_alerts > 0 && <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TONE.warn)}>{c.open_alerts} open</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
            <span>{c.size ?? c.participants.length} people</span>
            <span className="break-words">Team: {team.length ? [...new Set(team.map((p) => p.user_name))].join(", ") : "nobody linked"}</span>
            {c.last_message_at && <span>Last message {relativeTime(c.last_message_at)}</span>}
          </div>
          {c.last_error && <div className="mt-1 text-xs text-danger break-words">{c.last_error}</div>}
        </button>
        <div className="shrink-0 pt-0.5">
          <Toggle
            checked={c.monitored}
            disabled={watch.isPending}
            label="Watch"
            onChange={async (on) => {
              if (!on && c.open_alerts > 0 && !(await confirm({ title: `Stop watching ${name}?`, message: "Its open alerts stop too.", confirmLabel: "Stop watching", danger: true }))) return;
              watch.mutate(on);
            }}
          />
        </div>
        <ChevronDown size={16} className={cn("mt-1.5 shrink-0 text-subtle transition-transform duration-200", open && "rotate-180")} onClick={() => setOpen(!open)} />
      </div>
      {open && (
        <ul className="mt-3 rounded-lg border border-border divide-y divide-line animate-fade-in">
          {[...team, ...apps, ...others].map((p) => {
            const who = p.is_app ? "The iklipse app" : (p.user_name ?? p.name ?? p.real_name ?? "Someone");
            return (
              <li key={p.slack_id} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <Avatar src={p.avatar_url ?? p.avatar} name={who} size={24} className="shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm text-ink break-words">{who}</div>
                    <div className="text-xs text-subtle break-words">{slackWho(p)}</div>
                  </div>
                </div>
                {!isApp(p) && (
                  <Select
                    className="sm:w-48"
                    size="sm"
                    value={p.user_id ?? ""}
                    options={options}
                    aria-label="Who this is"
                    onChange={(v) => link.mutate({ slack: p.slack_id, user: v || null })}
                  />
                )}
              </li>
            );
          })}
          {!c.participants.length && <li className="px-3 py-2 text-sm text-muted">Not read yet. Press Read the channels.</li>}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- settings --

const MODELS = [
  { value: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)" },
  { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (best balance)" },
  { value: "claude-opus-5-5", label: "Claude Opus 5.5 (smartest, slower)" },
];
/** Tasks need Sonnet or Opus. */
const AGENT_MODELS = MODELS.filter((m) => m.value !== "claude-haiku-5-5");

const KEYS = [
  "enabled",
  "model_fast",
  "model_main",
  "model_agent",
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
  "cc_admins",
  "mail_enabled",
  "mail_reply_wait_min",
  "mail_clients",
  "mail_ads",
  "mail_senders",
  "slack_enabled",
  "book_enabled",
  "follow_enabled",
  "follow_wait_min",
  "follow_every_min",
  "follow_alerts",
  "off_days",
  "off_dates",
  "deadline_enabled",
  "deadline_before_hours",
  "deadline_every_min",
  "ask_enabled",
  "ask_to",
  "ask_phone",
  "ask_group",
  "ask_every_min",
  "dm_enabled",
  "book_link_account",
  "meet_tell",
  "orders_enabled",
  "order_every_min",
  "order_client_max",
  "alert_group",
  "read_files",
] as const;
type Draft = Pick<WatchSettings, (typeof KEYS)[number]>;

/** Until the server sends the newer settings. */
type Later =
  | "model_fast"
  | "model_main"
  | "model_agent"
  | "mail_enabled"
  | "mail_reply_wait_min"
  | "mail_clients"
  | "mail_ads"
  | "mail_senders"
  | "slack_enabled"
  | "book_enabled"
  | "follow_enabled"
  | "follow_wait_min"
  | "follow_every_min"
  | "follow_alerts"
  | "off_days"
  | "off_dates"
  | "deadline_enabled"
  | "deadline_before_hours"
  | "deadline_every_min"
  | "ask_enabled"
  | "ask_to"
  | "ask_phone"
  | "ask_group"
  | "ask_every_min"
  | "dm_enabled"
  | "book_link_account"
  | "meet_tell"
  | "orders_enabled"
  | "order_every_min"
  | "order_client_max"
  | "alert_group"
  | "read_files";
const LATER_DEFAULTS: Pick<Draft, Later> = {
  model_fast: "claude-haiku-5-5",
  model_main: "claude-sonnet-5-5",
  model_agent: "claude-sonnet-5-5",
  mail_enabled: false,
  mail_reply_wait_min: 60,
  mail_clients: true,
  mail_ads: true,
  mail_senders: [],
  slack_enabled: false,
  book_enabled: true,
  follow_enabled: true,
  follow_wait_min: 120,
  follow_every_min: 240,
  follow_alerts: 3,
  off_days: [],
  off_dates: [],
  deadline_enabled: true,
  deadline_before_hours: 24,
  deadline_every_min: 240,
  ask_enabled: false,
  ask_to: "person",
  ask_phone: null,
  ask_group: null,
  ask_every_min: 60,
  dm_enabled: false,
  book_link_account: null,
  meet_tell: false,
  orders_enabled: false,
  order_every_min: 60,
  order_client_max: 3,
  alert_group: null,
  read_files: true,
};

/** The week as the calendar shows it, with JavaScript's day numbers (0 Sunday). */
const WEEK_DAYS = [
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** "2026-10-20" -> "Tue 20-10-2026" */
const offDateText = (k: string) => {
  const [y, m, d] = k.split("-").map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d ?? 1);
  return `${dt.toLocaleDateString("en-GB", { weekday: "short" })} ${pad2(dt.getDate())}-${pad2(dt.getMonth() + 1)}-${dt.getFullYear()}`;
};
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** "a@b.com, @c.com" (or one per line) -> ["a@b.com", "@c.com"] */
const senderList = (text: string) =>
  text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const LIMITS: Partial<Record<keyof Draft, [number, number]>> = {
  reply_wait_min: [0, 1440],
  mail_reply_wait_min: [0, 2880],
  promise_wait_min: [1, 2880],
  repeat_every_min: [1, 1440],
  alerts_before_call: [1, 100],
  call_retry_min: [1, 120],
  call_every_min: [1, 1440],
  max_calls: [0, 500],
  stop_after_hours: [0, 720],
  follow_wait_min: [5, 10080],
  follow_every_min: [5, 10080],
  follow_alerts: [1, 50],
  deadline_before_hours: [1, 336],
  deadline_every_min: [5, 10080],
  ask_every_min: [5, 1440],
  order_every_min: [5, 1440],
  order_client_max: [1, 20],
};

type SettingsPage = "general" | "alerts" | "calls" | "bot" | "email";
const SETTINGS_PAGES: { value: SettingsPage; label: string }[] = [
  { value: "general", label: "General" },
  { value: "alerts", label: "Alerts" },
  { value: "calls", label: "Calls" },
  { value: "bot", label: "WhatsApp bot" },
  { value: "email", label: "Email" },
];
/** Where each number lives, to point at a wrong one. */
const NUMBER_PAGE: Partial<Record<keyof Draft, SettingsPage>> = {
  reply_wait_min: "alerts",
  promise_wait_min: "alerts",
  repeat_every_min: "alerts",
  stop_after_hours: "alerts",
  follow_wait_min: "alerts",
  follow_every_min: "alerts",
  follow_alerts: "alerts",
  deadline_before_hours: "alerts",
  deadline_every_min: "alerts",
  alerts_before_call: "calls",
  call_retry_min: "calls",
  call_every_min: "calls",
  max_calls: "calls",
  ask_every_min: "bot",
  order_every_min: "bot",
  order_client_max: "bot",
  mail_reply_wait_min: "email",
};
const pageLabel = (p: SettingsPage | undefined) => SETTINGS_PAGES.find((x) => x.value === (p ?? "general"))!.label;

function SettingsTab({ ov, settings }: { ov: WatchOverview; settings: WatchSettings }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Only what's edited here (the server refuses other keys).
  const initial = useMemo<Draft>(() => {
    const s = { ...LATER_DEFAULTS, ...settings };
    const picked = Object.fromEntries(KEYS.map((k) => [k, s[k]])) as Draft;
    return {
      ...picked,
      quiet_from: picked.quiet_from?.slice(0, 5) ?? null,
      quiet_to: picked.quiet_to?.slice(0, 5) ?? null,
      mail_senders: picked.mail_senders ?? [],
      off_days: [...(picked.off_days ?? [])].sort(),
      // Past dates off are gone.
      off_dates: [...(picked.off_dates ?? [])].filter((k) => k >= todayKey()).sort(),
    };
  }, [settings]);
  const [d, setD] = useState<Draft>(initial);
  // The senders box as typed (the draft keeps the list), so a comma or a new line isn't eaten.
  const [senders, setSenders] = useState(initial.mail_senders.join("\n"));
  useEffect(() => {
    setD(initial);
    setSenders(initial.mail_senders.join("\n"));
  }, [initial]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const bad = (Object.keys(LIMITS) as (keyof Draft)[]).find((k) => {
    const v = d[k] as number;
    const [lo, hi] = LIMITS[k]!;
    return !Number.isFinite(v) || v < lo || v > hi;
  });
  const quietBad = !!d.quiet_from !== !!d.quiet_to;
  const [offDate, setOffDate] = useState("");
  const [page, setPage] = useState<SettingsPage>("general");
  const groups = useQuery({ queryKey: ["watch-groups"], queryFn: fetchWatchGroups });
  const teamGroups = (groups.data?.groups ?? []).filter((g) => g.kind === "team" && !g.left);
  const calendlys = useQuery({ queryKey: ["watch-calendlys"], queryFn: fetchCalendlyChoices });
  const askBad = (d.ask_enabled || d.dm_enabled) && (d.ask_to === "person" ? !/^\+?\d{8,15}$/.test((d.ask_phone ?? "").replace(/[\s-]/g, "")) : !d.ask_group);

  const confirmOn = useConfirm();
  // Switching on something that has the AI write to clients: asked first.
  const turnOn = async (k: "dm_enabled" | "orders_enabled", v: boolean, title: string, message: string) => {
    if (v && !d[k] && !(await confirmOn({ title, message, confirmLabel: "Turn it on" }))) return;
    set(k, v);
  };
  // Only what changed is saved, so someone else's change in the meantime stays.
  const outgoing = (x: Draft) => ({ ...x, quiet_from: x.quiet_from || null, quiet_to: x.quiet_to || null, ask_phone: (x.ask_phone ?? "").replace(/\D/g, "") || null }) as Record<string, unknown>;
  const changes = () => {
    const now = outgoing(d);
    const was = outgoing(initial);
    const out = Object.fromEntries(Object.entries(now).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(was[k])));
    // Working hours go together.
    if ("quiet_from" in out || "quiet_to" in out) Object.assign(out, { quiet_from: now.quiet_from, quiet_to: now.quiet_to });
    return out as Partial<WatchSettings>;
  };
  const save = useMutation({
    mutationFn: () => saveWatchSettings(changes()),
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
    <div className="max-w-2xl pb-24">
      <PillTabs value={page} tabs={SETTINGS_PAGES} onChange={setPage} label="Settings" scroll className="mb-6" />

      <div key={page} className="view-enter space-y-8">
        {page === "general" && (
          <>
            <SettingGroup title="What Claude watches">
              <SwitchRow
                id="w-enabled"
                label="WhatsApp groups"
                checked={d.enabled}
                onChange={(v) => set("enabled", v)}
                info="Claude reads each client group a minute after it goes quiet, and opens an alert when a client is left waiting or a promise is missed. Pick the groups in Alerts > Groups."
              />
              <SwitchRow
                id="w-slack"
                label="Slack channels"
                checked={d.slack_enabled}
                onChange={(v) => set("slack_enabled", v)}
                info="The same as the groups, for the channels turned on in Alerts > Slack."
              />
              <SwitchRow
                id="w-files"
                label="Read voice notes, photos and PDFs"
                checked={d.read_files}
                onChange={(v) => set("read_files", v)}
                info="Voice notes are written out and photos and PDFs are read, so Claude and the bot know what they say. Files are kept either way, and only the bot uses them."
              />
              <SettingRow
                label="Model for quick decisions"
                info={"What to do with each message, reading the groups, Slack and email for alerts, and reading files.\nMany small calls, so Haiku keeps them fast and cheap."}
              >
                <Select value={d.model_fast} options={MODELS} onChange={(v) => set("model_fast", v)} className="w-full sm:w-72" aria-label="Model for quick decisions" />
              </SettingRow>
              <SettingRow
                label="Model for replies and answers"
                info={"What people read: replies to clients, answers to the team, and what Ikli says on a call.\nSonnet is the best balance. Opus is smarter but slower and costs more."}
              >
                <Select value={d.model_main} options={MODELS} onChange={(v) => set("model_main", v)} className="w-full sm:w-72" aria-label="Model for replies and answers" />
              </SettingRow>
              <SettingRow
                label="Model for tasks with several steps"
                info={"Requests the bot works out step by step (looking things up, then acting on them), when tasks are turned on.\nSonnet or Opus."}
              >
                <Select value={d.model_agent} options={AGENT_MODELS} onChange={(v) => set("model_agent", v)} className="w-full sm:w-72" aria-label="Model for tasks with several steps" />
              </SettingRow>
            </SettingGroup>

            <SettingGroup title="Working hours" hint="Cairo time.">
              <SettingRow
                label="Working hours"
                info={"Outside them, and on days off, nothing rings and the bot asks the team nothing.\nA client who writes is told the team will reply as soon as it's online.\nAlerts ring when work starts.\nEmpty: the team works any time."}
                stack
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-36 shrink-0">
                    <Input type="time" value={d.quiet_to ?? ""} onChange={(e) => set("quiet_to", e.target.value || null)} aria-label="Work starts" />
                  </div>
                  <span className="text-sm text-muted">to</span>
                  <div className="w-36 shrink-0">
                    <Input type="time" value={d.quiet_from ?? ""} onChange={(e) => set("quiet_from", e.target.value || null)} aria-label="Work ends" />
                  </div>
                  {(d.quiet_from || d.quiet_to) && (
                    <Button size="sm" variant="ghost" onClick={() => setD((x) => ({ ...x, quiet_from: null, quiet_to: null }))}>
                      Any time
                    </Button>
                  )}
                </div>
                {quietBad && <p className="mt-1 text-xs text-danger">Set both times, or neither.</p>}
              </SettingRow>
              <SettingRow label="Days off every week" stack>
                <div className="flex flex-wrap gap-1.5">
                  {WEEK_DAYS.map((w) => {
                    const on = d.off_days.includes(w.day);
                    return (
                      <button
                        key={w.day}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set("off_days", on ? d.off_days.filter((x) => x !== w.day) : [...d.off_days, w.day].sort())}
                        className={cn(
                          "h-9 min-w-11 px-2 rounded-md border text-sm font-medium transition-colors",
                          on ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:text-ink",
                        )}
                      >
                        {w.label}
                      </button>
                    );
                  })}
                </div>
              </SettingRow>
              <SettingRow label="Holidays" info="Single dates off. Past dates drop off by themselves." stack>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="w-48">
                    <DateField value={offDate} onChange={(v) => setOffDate(v ?? "")} min={todayKey()} aria-label="A date off" />
                  </div>
                  <Button
                    size="sm"
                    disabled={!offDate || d.off_dates.includes(offDate)}
                    onClick={() => {
                      set("off_dates", [...d.off_dates, offDate].sort());
                      setOffDate("");
                    }}
                  >
                    Add
                  </Button>
                </div>
                {d.off_dates.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {d.off_dates.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1 rounded-full bg-accent-soft text-accent pl-2.5 pr-1 py-0.5 text-sm tabular-nums">
                        {offDateText(k)}
                        <button type="button" aria-label={`Remove ${offDateText(k)}`} onClick={() => set("off_dates", d.off_dates.filter((x) => x !== k))} className="grid place-items-center h-5 w-5 rounded-full hover:bg-accent/15">
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </SettingRow>
            </SettingGroup>
          </>
        )}

        {page === "alerts" && (
          <>
            <SettingGroup title="When a client waits">
              <NumberRow
                id="w-reply"
                label="No reply from the team for"
                unit="minutes"
                min={0}
                max={1440}
                value={d.reply_wait_min}
                onChange={(v) => set("reply_wait_min", v)}
                info="A client wrote in a group or a Slack channel and nobody on the team answered. Where the bot replies, it also tells the client we'll get back to them."
              />
              <NumberRow
                id="w-promise"
                label="A promise with no time is due after"
                unit="minutes"
                min={1}
                max={2880}
                value={d.promise_wait_min}
                onChange={(v) => set("promise_wait_min", v)}
                info={'Someone on the team said "I\'ll get back to you shortly" without a time, in a group or an email.'}
              />
            </SettingGroup>

            <SettingGroup title="When we wait on a client">
              <SwitchRow
                id="w-follow"
                label="Alert when we're waiting on someone"
                checked={d.follow_enabled}
                onChange={(v) => set("follow_enabled", v)}
                info="A client said they'll send something (files, feedback, a payment), or the team asked them and they haven't answered. It goes to whoever is waiting, closes by itself when it comes, and never calls."
              />
              <NumberRow
                id="w-follow-wait"
                label="First alert after"
                unit="minutes"
                min={5}
                max={10080}
                value={d.follow_wait_min}
                onChange={(v) => set("follow_wait_min", v)}
                dim={!d.follow_enabled}
                info="When they gave no time. When they did, it alerts at that time."
              />
              <NumberRow
                id="w-follow-every"
                label="Then again every"
                unit="minutes"
                min={5}
                max={10080}
                value={d.follow_every_min}
                onChange={(v) => set("follow_every_min", v)}
                dim={!d.follow_enabled}
              />
              <NumberRow
                id="w-follow-times"
                label="At most"
                unit="alerts"
                min={1}
                max={50}
                value={d.follow_alerts}
                onChange={(v) => set("follow_alerts", v)}
                dim={!d.follow_enabled}
                info="After that it stays open, quietly, until someone deals with it."
              />
            </SettingGroup>

            <SettingGroup title="Deadlines">
              <SwitchRow
                id="w-deadline"
                label="Alert before a delivery we promised"
                checked={d.deadline_enabled}
                onChange={(v) => set("deadline_enabled", v)}
                info={'The team told a client when it will deliver ("the designs on Thursday"). It goes to whoever promised and closes by itself once delivered. At the deadline it rings, and calls when calls are on.'}
              />
              <NumberRow
                id="w-dl-before"
                label="Start alerting"
                unit="hours before"
                min={1}
                max={336}
                value={d.deadline_before_hours}
                onChange={(v) => set("deadline_before_hours", v)}
                dim={!d.deadline_enabled}
                info="24 is a day before, 48 two days."
              />
              <NumberRow
                id="w-dl-every"
                label="Then again every"
                unit="minutes"
                min={5}
                max={10080}
                value={d.deadline_every_min}
                onChange={(v) => set("deadline_every_min", v)}
                dim={!d.deadline_enabled}
              />
            </SettingGroup>

            <SettingGroup title="Ringing">
              <NumberRow
                id="w-repeat"
                label="Ring again every"
                unit="minutes"
                min={1}
                max={1440}
                value={d.repeat_every_min}
                onChange={(v) => set("repeat_every_min", v)}
                info="An alert rings everyone on it, in the app and on their phones, until someone marks it handled."
              />
              <NumberRow
                id="w-stop"
                label="Stop ringing by itself after"
                unit="hours"
                min={0}
                max={720}
                value={d.stop_after_hours}
                onChange={(v) => set("stop_after_hours", v)}
                info="0: it rings until it's handled."
              />
              <SwitchRow
                id="w-cc"
                label="Admins get every alert"
                checked={d.cc_admins}
                onChange={(v) => set("cc_admins", v)}
                info="Not only the team members in that group or channel. Email alerts only ring the mailbox owner."
              />
              <SettingRow label="Also post alerts in" info="Every 2 hours in working hours, this team group gets the open alerts in one message, or that there are none. Group and Slack alerts only; email alerts stay with the mailbox owner.">
                <Select
                  value={d.alert_group ?? ""}
                  options={[{ value: "", label: "Nowhere (the app only)" }, ...teamGroups.map((g) => ({ value: g.chat_id, label: g.name ?? "Unnamed group" }))]}
                  onChange={(v) => set("alert_group", v || null)}
                  className="w-full sm:w-64"
                  aria-label="Also post alerts in"
                />
              </SettingRow>
            </SettingGroup>
          </>
        )}

        {page === "calls" && (
          <SettingGroup title="Calls" info="When nobody acts on an alert, Ikli calls everyone on it and tells them why.">
            <SwitchRow
              id="w-calls"
              label="Call when nobody acts"
              checked={d.calls_enabled}
              onChange={(v) => set("calls_enabled", v)}
              info={"With the app open: a call screen that rings until they answer.\nOn a phone with the iklipse app (Apps page): a real full screen call.\nOtherwise: a notification that rings."}
            />
            <NumberRow
              id="w-before"
              label="Start calling after"
              unit="alerts"
              min={1}
              max={100}
              value={d.alerts_before_call}
              onChange={(v) => set("alerts_before_call", v)}
              dim={!d.calls_enabled}
              info="How many times an alert rings with nobody acting before the first call."
            />
            <NumberRow
              id="w-retry"
              label="No answer: call again after"
              unit="minutes"
              min={1}
              max={120}
              value={d.call_retry_min}
              onChange={(v) => set("call_retry_min", v)}
              dim={!d.calls_enabled}
            />
            <NumberRow
              id="w-every"
              label="Answered but still open: call again every"
              unit="minutes"
              min={1}
              max={1440}
              value={d.call_every_min}
              onChange={(v) => set("call_every_min", v)}
              dim={!d.calls_enabled}
            />
            <NumberRow
              id="w-max"
              label="Most calls per person"
              unit="calls"
              min={0}
              max={500}
              value={d.max_calls}
              onChange={(v) => set("max_calls", v)}
              dim={!d.calls_enabled}
              info="0: no limit."
            />
            <div className="py-3 flex flex-wrap items-center gap-3">
              <Button size="sm" iconLeft={<PhoneCall size={14} />} loading={test.isPending} onClick={() => test.mutate()}>
                Test call to me
              </Button>
              {!ov.my_phone && <span className="text-xs text-warn">Get the iklipse app (Apps page) so calls ring on your phone like real ones.</span>}
            </div>
          </SettingGroup>
        )}

        {page === "bot" && (
          <>
            <SettingGroup title="Asking the team">
              <SwitchRow
                id="w-ask"
                label="Ask for clients' missing details"
                checked={d.ask_enabled}
                onChange={(v) => set("ask_enabled", v)}
                info="Everyone in a client group who isn't on the team is saved in Clients. A missing name, email or hidden number is asked in one message, again until it's filled in here or on the Projects page."
              />
              <SwitchRow
                id="w-dm"
                label="Answer private messages"
                checked={d.dm_enabled}
                onChange={(v) =>
                  void turnOn("dm_enabled", v, "Answer clients' private messages?", "The bot writes replies to clients who message it privately. The first one, and any that touch money, deadlines or a complaint, still wait for the team's OK.")
                }
                info={'Someone writes to the bot about work: it writes a reply.\nThe first reply to someone, and any it isn\'t sure of or that touches money, deadlines or a complaint, waits for an OK: answer "OK" to send it, write your own reply to send that instead, or "no". The rest it sends by itself.\nOff topic, it politely says it only helps with work.\nThe team\'s own messages aren\'t answered.'}
              />
            </SettingGroup>

            <SettingGroup title="Who it asks" hint="Never in a client group, and only in working hours.">
              <SettingRow label="Ask" stack>
                <Segmented<"person" | "group">
                  value={d.ask_to}
                  onChange={(v) => set("ask_to", v)}
                  options={[
                    { value: "person", label: "One person, on WhatsApp" },
                    { value: "group", label: "A team group" },
                  ]}
                />
              </SettingRow>
              {d.ask_to === "person" ? (
                <SettingRow label="Their WhatsApp number" htmlFor="w-ask-phone" info="With the country code. They answer the bot in its private chat.">
                  <Input id="w-ask-phone" inputMode="tel" value={d.ask_phone ?? ""} onChange={(e) => set("ask_phone", e.target.value || null)} placeholder="+20 100 123 4567" className="sm:w-56" />
                </SettingRow>
              ) : (
                <SettingRow label="The team group" info="Mark a group as Team in Alerts > Groups. Anyone there can answer, by replying to the bot's message.">
                  <Select
                    value={d.ask_group ?? ""}
                    options={[{ value: "", label: teamGroups.length ? "Pick a team group" : "No team groups yet" }, ...teamGroups.map((g) => ({ value: g.chat_id, label: g.name ?? "Unnamed group" }))]}
                    onChange={(v) => set("ask_group", v || null)}
                    className="w-full sm:w-64"
                    aria-label="The team group"
                  />
                </SettingRow>
              )}
              <NumberRow id="w-ask-every" label="Ask again every" unit="minutes" min={5} max={1440} value={d.ask_every_min} onChange={(v) => set("ask_every_min", v)} info="Until someone answers." />
            </SettingGroup>

            <SettingGroup title="Meetings">
              <SwitchRow
                id="w-book"
                label="Book meetings from WhatsApp"
                checked={d.book_enabled}
                onChange={(v) => set("book_enabled", v)}
                info={"Anyone on the team mentions the bot in a group, or writes to it privately, with the day, time and who.\nIt books on their Calendly. The group only sees booked, moved or cancelled, with the link; anything else is sorted privately.\nWhen Calendly won't book it directly, the person gets a custom link for that time with their details filled in, so they only confirm. It follows up until they do.\nFree times are what isn't busy on the calendar connected in Calendly, in working hours (General). Links go out short."}
              />
              <SwitchRow
                id="w-meet-tell"
                label="Send meeting details privately"
                checked={d.meet_tell}
                onChange={(v) => set("meet_tell", v)}
                info="Everyone on a meeting that iklipse knows (the team, and people in Clients) gets the details on WhatsApp and a reminder an hour before. Others only get Calendly's emails."
              />
              <SettingRow label="Booking link for clients" info="In groups where the bot replies, a client asking for a meeting gets this Calendly's booking link.">
                <Select
                  value={d.book_link_account ?? ""}
                  options={[
                    { value: "", label: "None" },
                    ...(calendlys.data ?? []).map((c) => ({
                      value: c.id,
                      label: `${c.owner}: ${c.email ?? c.name ?? "Calendly"}${c.event_type ? ` (${c.event_type})` : ""}`,
                    })),
                  ]}
                  onChange={(v) => set("book_link_account", v || null)}
                  className="w-full sm:w-72"
                  aria-label="Booking link for clients"
                />
              </SettingRow>
            </SettingGroup>

            <SettingGroup title="Orders from the team">
              <SwitchRow
                id="w-orders"
                label="Take orders from the team"
                checked={d.orders_enabled}
                onChange={(v) =>
                  void turnOn("orders_enabled", v, "Let the team give the bot tasks?", "The bot messages people, clients included, when someone on the team asks it to, without an OK, and follows up until it's done.")
                }
                info={'Mention the bot in a group, or write to it privately:\n"tell Rabah to send the logo files"\n"ask Sara when she\'s free"\n"what did Acme say about the logo?"\n"stop asking Sara"\nIt does it without an OK, follows up until it\'s done, and answers where the order was given.\nIn a team group or privately, it also answers like any assistant, in your language: "write me a caption for this", "translate this", "5 names for the new brand".'}
              />
              <NumberRow
                id="w-order-every"
                label="Remind them every"
                unit="minutes"
                min={5}
                max={1440}
                value={d.order_every_min}
                onChange={(v) => set("order_every_min", v)}
                dim={!d.orders_enabled}
                info="Until it's done. Only in working hours."
              />
              <NumberRow
                id="w-order-max"
                label="Most messages to a client"
                unit="messages"
                min={1}
                max={20}
                value={d.order_client_max}
                onChange={(v) => set("order_client_max", v)}
                dim={!d.orders_enabled}
                info="Then it stops and tells whoever gave the order."
              />
            </SettingGroup>
          </>
        )}

        {page === "email" && (
          <SettingGroup title="Email">
            <SwitchRow
              id="w-mail"
              label="Watch the team's email"
              checked={d.mail_enabled}
              onChange={(v) => set("mail_enabled", v)}
              info="Claude reads new emails in the accounts each person turns on (Alerts > Email) and opens alerts. Client emails are kept for the bot only."
            />
            <SwitchRow
              id="w-mail-clients"
              label="Client emails"
              checked={d.mail_clients}
              onChange={(v) => set("mail_clients", v)}
              dim={!d.mail_enabled}
              info="Your clients (Projects), people at their company, and new people asking about work."
            />
            <SwitchRow
              id="w-mail-ads"
              label="Ad platform emails"
              checked={d.mail_ads}
              onChange={(v) => set("mail_ads", v)}
              dim={!d.mail_enabled}
              info="Meta, Google Ads, TikTok, Snapchat and others: a rejected ad, a failed payment, a restricted account."
            />
            <NumberRow
              id="w-mail-reply"
              label="A client email waits for a reply after"
              unit="minutes"
              min={0}
              max={2880}
              value={d.mail_reply_wait_min}
              onChange={(v) => set("mail_reply_wait_min", v)}
              dim={!d.mail_enabled}
            />
            <SettingRow label="Also treat these senders as clients" htmlFor="w-mail-senders" info="Addresses, or @company.com for everyone there. One per line." stack dim={!d.mail_enabled}>
              <Textarea
                id="w-mail-senders"
                rows={3}
                value={senders}
                onChange={(e) => (setSenders(e.target.value), set("mail_senders", senderList(e.target.value)))}
                placeholder={"name@company.com\n@company.com"}
                className="sm:w-80"
              />
            </SettingRow>
          </SettingGroup>
        )}
      </div>

      <div className="sticky bottom-0 mt-8 -mx-3 sm:-mx-4 md:-mx-6 border-t border-border bg-bg/95 backdrop-blur px-3 sm:px-4 md:px-6 py-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!dirty || !!bad || quietBad || askBad} loading={save.isPending} onClick={() => save.mutate()}>
          Save settings
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => (setD(initial), setSenders(initial.mail_senders.join("\n")))}>
            Undo changes
          </Button>
        )}
        {bad ? (
          <span className="text-sm text-danger">Check the numbers ({pageLabel(NUMBER_PAGE[bad])}).</span>
        ) : askBad ? (
          <span className="text-sm text-danger">Say who the bot asks (WhatsApp bot).</span>
        ) : quietBad ? (
          <span className="text-sm text-danger">Set both working hours (General).</span>
        ) : (
          dirty && <span className="text-sm text-muted">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
