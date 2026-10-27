import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import { Segmented } from "@/components/ui/Controls";
import { Pager, usePaged } from "@/components/ui/Pager";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { ROWS, Section, Stat, StatStrip } from "@/components/ui/Section";
import { relativeTime } from "@/lib/format";
import { aiCost } from "@/lib/aiPrices";
import { fetchBotMetrics, fetchGuardBlocks, type BotAiUse, type BotMetricsDay } from "@/lib/watchApi";

// -----------------------------------------------------------------------------
// The bot's numbers, for admins (Alerts > Metrics, 0111): per day, how much
// came in, how often it answered clients alone or asked the team, how fast,
// the alerts it opened and closed and the repeats it kept out, the messages
// the check stopped, the reminders it sent, and what Claude cost by job.
// -----------------------------------------------------------------------------

type Range = "7" | "30";
const RANGES: { value: Range; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];
const ROLES: { role: BotAiUse["role"]; label: string; info: string }[] = [
  { role: "fast", label: "Fast jobs", info: "Sorting orders, reading groups and email for alerts, reading files." },
  { role: "main", label: "Main jobs", info: "Replies to clients, answers to the team, the words of alert calls." },
  { role: "agent", label: "Agent", info: "Tasks of several steps, when the agent is on." },
];
const WHERE: Record<string, string> = {
  "dm.reply": "a reply",
  "dm.hold": "a holding line",
  "dm.draft": "a reply for the team to OK",
  "dm.ok": "a reply the team OK'd",
  "orders.message": "an order's message",
  "orders.relay": "the team's answer",
  "agent.message_client": "the agent",
};

const money = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const count = (n: number) => n.toLocaleString("en-US");
/** "45s", "3 min", "1 h 20 min" */
function span(sec: number | null) {
  if (sec == null) return "-";
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const costOf = (ai: BotAiUse[]) => ai.reduce((s, x) => s + (aiCost(x) ?? 0), 0);
const total = (rows: BotMetricsDay[], k: keyof BotMetricsDay) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : Math.round((s[s.length / 2 - 1]! + s[s.length / 2]!) / 2);
}

export function MetricsTab() {
  const [range, setRange] = useState<Range>("7");
  const days = Number(range);
  const m = useQuery({ queryKey: ["bot-metrics", days], queryFn: () => fetchBotMetrics(days) });
  const blocks = useQuery({ queryKey: ["bot-guard-blocks"], queryFn: fetchGuardBlocks });
  const pagedDays = usePaged(m.data ?? [], "bot-metrics-days");

  if (m.isLoading) return <PageSpinner />;
  if (m.error)
    return (
      <EmptyState
        icon={<BarChart3 size={20} />}
        title="No numbers yet"
        description="Not set up yet."
      />
    );

  const rows = m.data ?? [];
  const alone = total(rows, "replies_alone");
  const asked = total(rows, "asked_team");
  const ai = rows.flatMap((r) => r.ai);
  const reply = median(rows.map((r) => r.median_reply_sec).filter((x): x is number => x != null));

  return (
    <>
      <div className="flex justify-end">
        <Segmented value={range} options={RANGES} onChange={setRange} />
      </div>

      <Section title="Clients" info={"Replies alone: the bot answered a client's private chat itself.\nAsked the team: it was stuck or it was risky, so it asked you first.\nReply time: from a client's message to the bot's answer, the middle day of the range."}>
        <StatStrip>
          <Stat label="Messages in" value={count(total(rows, "group_messages") + total(rows, "private_in"))} hint={`${count(total(rows, "private_in"))} private`} />
          <Stat label="Replies alone" value={count(alone)} hint={alone + asked ? `${Math.round((alone / (alone + asked)) * 100)}% of replies` : undefined} />
          <Stat label="Asked the team" value={count(asked)} />
          <Stat label="Reply time" value={span(reply)} hint="median" />
        </StatStrip>
      </Section>

      <Section title="Alerts and reminders" info={"Repeats kept out: the same thing said again, or the same email in another mailbox, that didn't open a second alert.\nStopped: messages to clients the check didn't let go (a number, an email or a price that isn't theirs, another client's name, an internal word). The team got them instead."}>
        <StatStrip>
          <Stat label="Alerts opened" value={count(total(rows, "alerts_opened"))} hint={`${count(total(rows, "alerts_closed"))} closed`} />
          <Stat label="Repeats kept out" value={count(total(rows, "duplicates_kept_out"))} />
          <Stat label="Stopped" value={count(total(rows, "messages_stopped"))} tone={total(rows, "messages_stopped") ? "warn" : undefined} />
          <Stat label="Reminders sent" value={count(total(rows, "reminders_sent"))} />
        </StatStrip>
      </Section>

      <Section title="AI cost" count={money(costOf(ai))} info={"What Claude cost, by job, at Anthropic's list prices: an estimate, the bill is Anthropic's."}>
        <ul className={ROWS}>
          {ROLES.map(({ role, label, info }) => {
            const mine = ai.filter((x) => x.role === role);
            const calls = mine.reduce((s, x) => s + x.calls, 0);
            const failed = mine.reduce((s, x) => s + x.failed, 0);
            const models = [...new Set(mine.map((x) => x.model.replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2")))];
            return (
              <li key={role} className="py-3 flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-ink" title={info}>{label}</div>
                  <div className="text-sm text-subtle truncate">
                    {calls ? `${count(calls)} calls${failed ? `, ${count(failed)} failed` : ""}${models.length ? ` · ${models.join(", ")}` : ""}` : "No calls"}
                  </div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-ink">{money(costOf(mine))}</div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="By day">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm tabular-nums">
            <thead>
              <tr className="text-left text-muted">
                {["Day", "In", "Alone", "Asked", "Reply time", "Opened", "Closed", "Repeats", "Stopped", "Reminders", "AI"].map((h) => (
                  <th key={h} className="py-2 pr-3 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className={ROWS}>
              {pagedDays.rows.map((r) => (
                <tr key={r.day}>
                  <td className="py-2 pr-3 text-ink whitespace-nowrap">{dayLabel(r.day)}</td>
                  <td className="py-2 pr-3">{count(r.group_messages + r.private_in)}</td>
                  <td className="py-2 pr-3">{count(r.replies_alone)}</td>
                  <td className="py-2 pr-3">{count(r.asked_team)}</td>
                  <td className="py-2 pr-3">{span(r.median_reply_sec)}</td>
                  <td className="py-2 pr-3">{count(r.alerts_opened)}</td>
                  <td className="py-2 pr-3">{count(r.alerts_closed)}</td>
                  <td className="py-2 pr-3">{count(r.duplicates_kept_out)}</td>
                  <td className="py-2 pr-3">{count(r.messages_stopped)}</td>
                  <td className="py-2 pr-3">{count(r.reminders_sent)}</td>
                  <td className="py-2 pr-3">{money(costOf(r.ai))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager {...pagedDays.pager} />
      </Section>

      <Section title="Stopped messages" count={blocks.data?.length} info={"The last 20 messages to clients the check didn't let go, and why. Each went to the team to OK or change."}>
        <ul className={ROWS}>
          {(blocks.data ?? []).map((b) => (
            <li key={b.id} className="py-3 min-w-0">
              <div className="text-sm text-ink">
                To {b.to_name ?? "a client"} <span className="text-subtle">· {WHERE[b.where_from] ?? b.where_from} · {relativeTime(b.at)}</span>
              </div>
              <div className="text-sm text-warn">{b.reasons.join(", ")}</div>
              <div className="mt-1 text-sm text-muted break-words line-clamp-3">{b.text}</div>
            </li>
          ))}
          {!blocks.data?.length && <li className="py-3 text-sm text-muted">Nothing stopped.</li>}
        </ul>
      </Section>
    </>
  );
}
