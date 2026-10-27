import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Segmented, Switch } from "@/components/ui/Controls";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { NumberRow, SettingGroup, SettingRow } from "@/components/ui/SettingRows";
import { Stat, StatStrip } from "@/components/ui/Section";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { relativeTime } from "@/lib/format";
import { BrainRuns } from "@/components/alerts/BrainRuns";
import { BRAIN_MODELS, fetchBrain, saveBrainSettings, type BrainPatch, type BrainPerson, type BrainSettings } from "@/lib/brainApi";

// -----------------------------------------------------------------------------
// Alerts > Brain (admins, 0119, 0120): Claude on the Agent SDK as the bot's
// one mind on WhatsApp. The kill switch, who it answers (the phase, clients
// too, and who the super admins are), what happens when it's down, its models and
// limits, what it spent today; and (Runs, BrainRuns.tsx) its runs: who asked what, how it ended, the
// tools it used and the system changes it made (merges, deploys).
// -----------------------------------------------------------------------------

type Phase = "0" | "1" | "2" | "3";
const PHASES: { value: Phase; label: string }[] = [
  { value: "0", label: "The super admin" },
  { value: "1", label: "+ admins" },
  { value: "2", label: "+ the team" },
  { value: "3", label: "+ clients" },
];
// "claude-opus-4-5-20251101" reads "Opus 4.5", "claude-opus-5" "Opus 5".
const MODEL_OPTIONS = BRAIN_MODELS.map((m) => ({
  value: m,
  label: m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d+)(?:-(\d+))?$/, (_, a, b) => ` ${a}${b ? `.${b}` : ""}`).replace(/^./, (c) => c.toUpperCase()),
}));

type Draft = Required<Omit<BrainPatch, "stopped">>;

const LIMITS: [keyof Draft, number, number][] = [
  ["max_turns", 1, 200],
  ["member_turns", 1, 100],
  ["run_minutes", 1, 60],
  ["run_cost_usd", 0.01, 100],
  ["day_cost_usd", 0.01, 1000],
];

const money = (n: number) => `$${Number(n).toFixed(2)}`;

/** What's saved (the super admins in a steady order, so reordering isn't a change). */
function patchOf(x: Draft): BrainPatch {
  return { ...x, owner_users: [...x.owner_users].sort() };
}

function draftOf(s: BrainSettings): Draft {
  return {
    phase: s.phase,
    fallback_old: s.fallback_old,
    owner_users: s.owner_users ?? [],
    model_owner: s.model_owner,
    model_member: s.model_member,
    model_fast: s.model_fast,
    max_turns: s.max_turns,
    member_turns: s.member_turns,
    run_minutes: s.run_minutes,
    run_cost_usd: Number(s.run_cost_usd),
    day_cost_usd: Number(s.day_cost_usd),
  };
}

/** Alerts > Brain: its settings, or its runs (a table across the page). */
export function BrainTab() {
  const [view, setView] = useState<"settings" | "runs">("settings");
  return (
    <div className="space-y-5">
      <Segmented
        value={view}
        options={[
          { value: "settings", label: "Settings" },
          { value: "runs", label: "Runs" },
        ]}
        onChange={setView}
      />
      {view === "runs" ? <BrainRuns /> : <BrainSettingsView />}
    </div>
  );
}

function BrainSettingsView() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const b = useQuery({ queryKey: ["brain"], queryFn: () => fetchBrain(), refetchInterval: 30_000 });
  const initial = useMemo(() => (b.data ? draftOf(b.data.settings) : null), [b.data]);
  const [d, setD] = useState<Draft | null>(initial);
  useEffect(() => setD(initial), [initial]);

  const save = useMutation({
    mutationFn: (p: BrainPatch) => saveBrainSettings(p),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["brain"] });
      toast.push({ kind: "success", title: "Saved" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't save", description: e.message }),
  });

  if (b.isLoading) return <PageSpinner />;
  if (b.error || !b.data || !d || !initial)
    return <EmptyState icon={<Brain size={20} />} title="The brain isn't set up yet" description="It starts once its database update (0119) is run." />;

  const s = b.data.settings;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const people = b.data.people ?? [];
  const noSuper = d.owner_users.length === 0;
  const bad = LIMITS.find(([k, lo, hi]) => {
    const v = d[k] as number;
    return !Number.isFinite(v) || v < lo || v > hi;
  });
  const patch = patchOf(d);
  const dirty = JSON.stringify(patch) !== JSON.stringify(patchOf(initial));

  const switchBrain = async (on: boolean) => {
    if (!on && !(await confirm({ title: "Stop the brain?", message: "Every run stops now, and it only reads until someone turns it back on (here, or an admin says start).", confirmLabel: "Stop it", danger: true }))) return;
    save.mutate({ stopped: !on });
  };

  return (
    <div className="max-w-3xl pb-24 space-y-8">
      <StatStrip>
        <Stat label="State" value={s.stopped ? "Stopped" : "On"} tone={s.stopped ? "warn" : "success"} hint={s.stopped && s.stopped_at ? `since ${relativeTime(s.stopped_at)}${s.stopped_by ? `, ${s.stopped_by}` : ""}` : undefined} />
        <Stat label="Spent today" value={money(b.data.today_cost)} hint={`of ${money(Number(s.day_cost_usd))}`} tone={b.data.today_cost >= Number(s.day_cost_usd) * 0.8 ? "warn" : undefined} />
        <Stat label="Answers" value={PHASES[s.phase]?.label ?? "-"} />
      </StatStrip>

      <SettingGroup title="Switch" info="The kill switch. Off: every run stops at once, and the brain only reads (it answers questions, changes nothing) until it's on again. Any admin can also say وقف / stop and شغّل / start to it privately on WhatsApp.">
        <SettingRow label="The brain is on" htmlFor="brain-on">
          <Switch id="brain-on" checked={!s.stopped} onChange={(v) => void switchBrain(v)} label="The brain is on" disabled={save.isPending} />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Who it answers" info="Who the brain answers on WhatsApp. The team goes by the links an admin made in Alerts > Groups, never by the number someone put on their own card. Whoever it doesn't answer yet gets the old bot.">
        <SettingRow label="Answers" info="Phase 0: only the super admin. Phase 1: admins too. Phase 2: the whole team, privately and in team groups (only messages meant for the bot), whatever they say to it: new requests, answers to its questions, orders, meetings. Phase 3: clients writing privately too (only what's theirs; the team decides anything risky). Changes to the system (code, deploys, skills) are the super admin's and admins' only, in their private chat.">
          <Segmented value={String(d.phase) as Phase} options={PHASES} onChange={(v) => set("phase", Number(v) as Draft["phase"])} />
        </SettingRow>
        <SettingRow label="When it's down, the old bot answers" htmlFor="brain-fallback" info="Off: when the brain doesn't answer, the person hears it's down for a few minutes (clients' messages wait for it). On: the old bot answers instead, as before the brain.">
          <Switch id="brain-fallback" checked={d.fallback_old} onChange={(v) => set("fallback_old", v)} label="When it's down, the old bot answers" />
        </SettingRow>
        <SettingRow label="Super admins" stack info="The people the system belongs to: they get the stronger model and the day's spending warnings, and only they change the brain's settings, its skills and who the super admins are. The brain knows them by every WhatsApp number on their account (Users page). Who else can have the brain do things is the Admin role; members only ask it questions.">
          <PeoplePicker people={people} value={d.owner_users} onChange={(v) => set("owner_users", v)} />
          {noSuper && <span className="mt-1 block text-sm text-danger">Keep at least one super admin.</span>}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Models" info="Which Claude does the work. The super admin and admins get the stronger one by default; quick jobs (summing up an old conversation) use the fast one.">
        <SettingRow label="The super admin and admins">
          <Select value={d.model_owner} options={MODEL_OPTIONS} onChange={(v) => set("model_owner", v as Draft["model_owner"])} className="w-48" aria-label="Model for the super admin and admins" />
        </SettingRow>
        <SettingRow label="The team and clients">
          <Select value={d.model_member} options={MODEL_OPTIONS} onChange={(v) => set("model_member", v as Draft["model_member"])} className="w-48" aria-label="Model for the team and clients" />
        </SettingRow>
        <SettingRow label="Quick jobs">
          <Select value={d.model_fast} options={MODEL_OPTIONS} onChange={(v) => set("model_fast", v as Draft["model_fast"])} className="w-48" aria-label="Model for quick jobs" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Limits" info="A run stops when it reaches any of these and says so. At 80% of the day's limit the super admin gets a WhatsApp message; at 100% the brain answers nobody until the next day or until the limit is raised.">
        <NumberRow id="brain-turns" label="Steps per run (the super admin and admins)" unit="steps" min={1} max={200} value={d.max_turns} onChange={(v) => set("max_turns", v)} />
        <NumberRow id="brain-mturns" label="Steps per run (the team and clients)" unit="steps" min={1} max={100} value={d.member_turns} onChange={(v) => set("member_turns", v)} />
        <NumberRow id="brain-minutes" label="Time per run" unit="minutes" min={1} max={60} value={d.run_minutes} onChange={(v) => set("run_minutes", v)} />
        <NumberRow id="brain-run-cost" label="Cost per run" unit="US dollars" min={1} max={100} value={d.run_cost_usd} onChange={(v) => set("run_cost_usd", v)} />
        <NumberRow id="brain-day-cost" label="Cost per day" unit="US dollars" min={1} max={1000} value={d.day_cost_usd} onChange={(v) => set("day_cost_usd", v)} />
      </SettingGroup>

      <div className="sticky bottom-0 mt-8 -mx-3 sm:-mx-4 md:-mx-6 border-t border-border bg-bg/95 backdrop-blur px-3 sm:px-4 md:px-6 py-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!dirty || !!bad || noSuper} loading={save.isPending} onClick={() => save.mutate(patch)}>
          Save settings
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setD(initial)}>
            Undo changes
          </Button>
        )}
        {bad ? <span className="text-sm text-danger">Check the limits.</span> : dirty && <span className="text-sm text-muted">Unsaved changes</span>}
      </div>
    </div>
  );
}

/** People picked: one chip each (x takes them off), and a menu to add someone. */
function PeoplePicker({ people, value, onChange }: { people: BrainPerson[]; value: string[]; onChange: (v: string[]) => void }) {
  const byId = new Map(people.map((p) => [p.id, p]));
  const rest = people.filter((p) => !value.includes(p.id));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((id) => (
        <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-inset pl-3 pr-1 h-8 text-sm text-ink">
          {byId.get(id)?.name ?? "Someone who left"}
          <button type="button" aria-label={`Remove ${byId.get(id)?.name ?? "them"}`} className="grid place-items-center h-6 w-6 rounded-full text-muted hover:bg-border/70 hover:text-ink" onClick={() => onChange(value.filter((x) => x !== id))}>
            <X size={14} />
          </button>
        </span>
      ))}
      {rest.length > 0 && (
        <Select
          size="sm"
          className="w-48"
          aria-label="Add a super admin"
          value=""
          placeholder="Add a person"
          onChange={(id) => id && onChange([...value, id])}
          options={rest.map((p) => ({ value: p.id, label: p.role === "admin" ? `${p.name} (admin)` : p.name }))}
        />
      )}
    </div>
  );
}
