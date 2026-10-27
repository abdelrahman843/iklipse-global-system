import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, Brain } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pager, usePaged } from "@/components/ui/Pager";
import { SearchField } from "@/components/ui/SearchField";
import { Stat, StatStrip } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { PageSpinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { fetchBrain, fetchBrainSteps, type BrainRun } from "@/lib/brainApi";

// -----------------------------------------------------------------------------
// The brain's runs (Alerts > Brain > Runs): every message it took, the last
// 500, as a table across the page. Filters for each column (who, their tier,
// where, how it ended, the model, when) and a search through the request and
// the error; sort by any number column; a row opens the tools it used and
// the system changes it made. The totals are of what the filters show.
// -----------------------------------------------------------------------------

export const RUN_STATUS: Record<BrainRun["status"], { label: string; tone: "neutral" | "accent" | "success" | "warn" | "danger" }> = {
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Running", tone: "accent" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "warn" },
  timeout: { label: "Too long", tone: "warn" },
  budget: { label: "Hit a limit", tone: "warn" },
  fallback: { label: "Brain down", tone: "warn" },
};

const TIERS: Record<BrainRun["tier"], string> = { owner: "Super admin", admin: "Admin", member: "Team", client: "Client" };
const PERIODS = [
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "all", label: "Any time" },
];
const ALL = "all";

type SortKey = "created_at" | "cost_usd" | "turns" | "steps" | "ms";

const money = (n: number) => `$${Number(n).toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
const model = (m: string | null) => (m ? m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d+)(?:-(\d+))?$/, (_, a, b) => ` ${a}${b ? `.${b}` : ""}`) : "-");
const seconds = (ms: number | null) => (ms == null ? "-" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const inGroup = (r: BrainRun) => r.chat_id.endsWith("@g.us");
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Cairo" });

/** Start of today in Cairo, as a time. */
function cairoDayStart(daysBack: number): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return Date.parse(`${day}T00:00:00+02:00`) - (daysBack - 1) * 86_400_000;
}

export function BrainRuns() {
  const q = useQuery({ queryKey: ["brain", 500], queryFn: () => fetchBrain(500), refetchInterval: 30_000 });
  const runs = useMemo(() => q.data?.runs ?? [], [q.data]);

  const [search, setSearch] = useState("");
  const [who, setWho] = useState(ALL);
  const [tier, setTier] = useState(ALL);
  const [where, setWhere] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [mdl, setMdl] = useState(ALL);
  const [period, setPeriod] = useState("30");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "created_at", desc: true });
  const [open, setOpen] = useState<string | null>(null);

  const people = useMemo(() => [...new Set(runs.map((r) => r.asker_name ?? "Someone"))].sort(), [runs]);
  const models = useMemo(() => [...new Set(runs.map((r) => r.model).filter((m): m is string => !!m))].sort(), [runs]);

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const from = period === ALL ? 0 : cairoDayStart(Number(period));
    const rows = runs.filter(
      (r) =>
        (who === ALL || (r.asker_name ?? "Someone") === who) &&
        (tier === ALL || r.tier === tier) &&
        (where === ALL || (where === "group") === inGroup(r)) &&
        (status === ALL || r.status === status) &&
        (mdl === ALL || r.model === mdl) &&
        Date.parse(r.created_at) >= from &&
        (!needle || [r.request, r.error, r.asker_name].some((x) => x?.toLowerCase().includes(needle))),
    );
    const v = (r: BrainRun) => (sort.key === "created_at" ? Date.parse(r.created_at) : Number(r[sort.key] ?? -1));
    return rows.sort((a, b) => (sort.desc ? v(b) - v(a) : v(a) - v(b)));
  }, [runs, search, who, tier, where, status, mdl, period, sort]);
  const paged = usePaged(shown, "brain-runs");

  const filtered = search || who !== ALL || tier !== ALL || where !== ALL || status !== ALL || mdl !== ALL || period !== "30";
  const clear = () => {
    setSearch("");
    setWho(ALL);
    setTier(ALL);
    setWhere(ALL);
    setStatus(ALL);
    setMdl(ALL);
    setPeriod("30");
  };

  if (q.isLoading) return <PageSpinner />;
  if (q.error || !q.data) return <EmptyState icon={<Brain size={20} />} title="Couldn't load the runs" description={(q.error as Error | null)?.message} />;

  const cost = shown.reduce((n, r) => n + Number(r.cost_usd || 0), 0);
  const failed = shown.filter((r) => r.status !== "done" && r.status !== "running" && r.status !== "queued").length;
  const times = shown.map((r) => r.ms).filter((x): x is number => x != null).sort((a, b) => a - b);

  const head = (key: SortKey, label: string, cls?: string) => (
    <th scope="col" className={cn("px-3 py-2 font-normal whitespace-nowrap", cls)} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
        {label}
        {sort.key === key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </button>
    </th>
  );

  return (
    <div className="space-y-4">
      <StatStrip>
        <Stat label="Runs" value={shown.length} hint={runs.length >= 500 ? "of the last 500" : undefined} />
        <Stat label="Cost" value={money(cost)} hint={shown.length ? `${money(cost / shown.length)} each` : undefined} />
        <Stat label="Didn't finish" value={failed} tone={failed ? "warn" : undefined} />
        <Stat label="Typical time" value={times.length ? seconds(times[Math.floor(times.length / 2)]!) : "-"} />
      </StatStrip>

      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={search} onChange={setSearch} placeholder="Search requests and errors" className="w-full sm:w-64" />
        <Select size="sm" className="w-40" aria-label="When" value={period} onChange={setPeriod} options={PERIODS} />
        <Select size="sm" className="w-44" aria-label="Who" value={who} onChange={setWho} options={[{ value: ALL, label: "Everyone" }, ...people.map((p) => ({ value: p, label: p }))]} />
        <Select size="sm" className="w-36" aria-label="Tier" value={tier} onChange={setTier} options={[{ value: ALL, label: "Any tier" }, ...Object.entries(TIERS).map(([value, label]) => ({ value, label }))]} />
        <Select
          size="sm"
          className="w-36"
          aria-label="Where"
          value={where}
          onChange={setWhere}
          options={[
            { value: ALL, label: "Anywhere" },
            { value: "private", label: "Privately" },
            { value: "group", label: "In a group" },
          ]}
        />
        <Select size="sm" className="w-36" aria-label="Status" value={status} onChange={setStatus} options={[{ value: ALL, label: "Any status" }, ...Object.entries(RUN_STATUS).map(([value, s]) => ({ value, label: s.label }))]} />
        <Select size="sm" className="w-40" aria-label="Model" value={mdl} onChange={setMdl} options={[{ value: ALL, label: "Any model" }, ...models.map((m) => ({ value: m, label: model(m) }))]} />
        {filtered && (
          <Button size="sm" variant="ghost" onClick={clear}>
            Clear filters
          </Button>
        )}
      </div>

      {!shown.length ? (
        <EmptyState icon={<Brain size={20} />} title={runs.length ? "No runs match" : "No runs yet"} description={runs.length ? "Try other filters." : "Each message the brain takes shows up here."} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-inset text-left text-xs uppercase tracking-eyebrow text-subtle">
              <tr>
                {head("created_at", "When")}
                <th scope="col" className="px-3 py-2 font-normal">Who</th>
                <th scope="col" className="px-3 py-2 font-normal">Where</th>
                <th scope="col" className="px-3 py-2 font-normal w-[34%]">Request</th>
                <th scope="col" className="px-3 py-2 font-normal">Status</th>
                <th scope="col" className="px-3 py-2 font-normal">Model</th>
                {head("turns", "Turns", "text-right")}
                {head("steps", "Tools", "text-right")}
                {head("cost_usd", "Cost", "text-right")}
                {head("ms", "Time", "text-right")}
                <th scope="col" className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {paged.rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className={cn("cursor-pointer hover:bg-hover", open === r.id && "bg-inset/60")} onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                    <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-muted">{when(r.created_at)}</td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <div className="text-ink">{r.asker_name ?? "Someone"}</div>
                      <div className="text-xs text-subtle">{TIERS[r.tier]}</div>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted">{inGroup(r) ? "Group" : "Private"}</td>
                    <td className="px-3 py-2.5 min-w-0">
                      <div className="text-ink line-clamp-2 break-words">{r.request || "-"}</div>
                      {r.error && <div className="mt-0.5 text-xs text-warn line-clamp-1 break-words">{r.error}</div>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                      {r.edits > 0 && <Badge className="ml-1">edited</Badge>}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-muted">{model(r.model)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{r.turns ?? "-"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{r.steps}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink">{money(Number(r.cost_usd || 0))}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{seconds(r.ms)}</td>
                    <td className="px-2 py-2.5">
                      <ChevronDown size={16} className={cn("text-subtle transition-transform", open === r.id && "rotate-180")} />
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="bg-inset/40">
                      <td colSpan={11} className="px-4 pb-4 pt-1">
                        {r.request && <div className="mb-2 text-sm text-ink whitespace-pre-wrap break-words">{r.request}</div>}
                        <RunSteps runId={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager {...paged.pager} />
    </div>
  );
}

/** What a run did: the system changes (merges, deploys) and each tool it used. */
export function RunSteps({ runId }: { runId: string }) {
  const q = useQuery({ queryKey: ["brain-steps", runId], queryFn: () => fetchBrainSteps(runId) });
  if (q.isLoading) return <div className="mt-2 text-sm text-muted">Loading…</div>;
  if (!q.data) return <div className="mt-2 text-sm text-danger">Couldn't load its steps.</div>;
  return (
    <div className="mt-2 ml-1 border-l border-line pl-3 space-y-1.5">
      {q.data.approvals.map((a) => (
        <div key={a.id} className="text-sm">
          <span className="text-ink">{a.what}</span> <Badge tone={a.status === "done" ? "success" : a.status === "waiting" ? "accent" : a.status === "refused" || a.status === "failed" ? "danger" : "neutral"}>{a.status}</Badge>
          {a.result && <div className="text-xs text-muted">{a.result}</div>}
        </div>
      ))}
      {q.data.steps.map((st) => (
        <div key={st.id} className="text-sm min-w-0">
          <span className="font-mono text-xs text-ink">{st.tool}</span> <span className={cn("text-xs", st.outcome === "ok" || st.outcome === "approved" ? "text-success" : st.outcome === "held" ? "text-accent" : "text-warn")}>{st.outcome}</span>
          {st.input && <div className="text-xs text-subtle break-all line-clamp-2">{st.input}</div>}
          {st.detail && <div className="text-xs text-muted break-words line-clamp-2">{st.detail}</div>}
        </div>
      ))}
      {!q.data.steps.length && !q.data.approvals.length && <div className="text-sm text-muted">No tools used.</div>}
    </div>
  );
}
