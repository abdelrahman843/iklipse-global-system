import { useEffect, useMemo, useRef, useState } from "react";
import { addDays, isBefore } from "date-fns";
import { AlertTriangle, CheckCircle2, Clock, Layers } from "lucide-react";
import type { Card as CardT, Label as LabelT, List, Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/Avatar";
import { dueStatus, shortDate } from "@/lib/format";
import { cn } from "@/lib/cn";

interface Props {
  cards: CardT[];
  lists: List[];
  labels: LabelT[];
  members: Profile[];
  cardLabelsByCard: Map<string, string[]>;
  cardMembersByCard: Map<string, string[]>;
  onOpenCard: (id: string) => void;
}

export function DashboardView({ cards, lists, labels, members, cardLabelsByCard, cardMembersByCard, onOpenCard }: Props) {
  const ids = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);

  const perList = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.list_id, (m.get(c.list_id) ?? 0) + 1);
    return lists.map((l) => ({ key: l.id, label: l.title, color: l.color ?? undefined, count: m.get(l.id) ?? 0 }));
  }, [cards, lists]);

  const perLabel = useMemo(() => {
    const m = new Map<string, number>();
    for (const [cid, lids] of cardLabelsByCard) if (ids.has(cid)) for (const id of lids) m.set(id, (m.get(id) ?? 0) + 1);
    return labels
      .map((l) => ({ key: l.id, label: l.name || "(unnamed)", color: l.color, count: m.get(l.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
  }, [cardLabelsByCard, ids, labels]);

  const perMember = useMemo(() => {
    const m = new Map<string, number>();
    for (const [cid, uids] of cardMembersByCard) if (ids.has(cid)) for (const id of uids) m.set(id, (m.get(id) ?? 0) + 1);
    return members
      .map((p) => ({ key: p.id, label: p.display_name, profile: p, count: m.get(p.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
  }, [cardMembersByCard, ids, members]);

  const buckets = useMemo(() => {
    const b = { overdue: 0, soon: 0, later: 0, done: 0, none: 0 };
    for (const c of cards) {
      const s = dueStatus(c.due_date, c.due_completed);
      if (!s) b.none++;
      else if (s === "overdue") b.overdue++;
      else if (s === "soon") b.soon++;
      else if (s === "completed") b.done++;
      else b.later++;
    }
    return b;
  }, [cards]);

  const attention = useMemo(() => {
    const week = addDays(new Date(), 7);
    return cards
      .filter((c) => c.due_date && !c.due_completed && isBefore(new Date(c.due_date), week))
      .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1))
      .slice(0, 8);
  }, [cards]);

  const total = cards.length;
  const dated = total - buckets.none;
  const pct = dated ? Math.round((buckets.done / dated) * 100) : 0;

  return (
    <div className="h-full overflow-auto">
      <div className="p-3 sm:p-4 md:p-6 max-w-page mx-auto space-y-3 sm:space-y-4">
        {/* KPI row */}
        <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-4">
          <Kpi i={0} icon={<Layers size={16} />} label="Total cards" value={total} tone="text-ink" />
          <Kpi i={1} icon={<CheckCircle2 size={16} />} label="Completed" value={buckets.done} tone="text-success" />
          <Kpi i={2} icon={<AlertTriangle size={16} />} label="Overdue" value={buckets.overdue} tone="text-danger" />
          <Kpi i={3} icon={<Clock size={16} />} label="Due soon" value={buckets.soon} tone="text-warn" />
        </div>

        <div className="grid gap-3 sm:gap-4 grid-cols-1 lg:grid-cols-3">
          <Panel i={4} title="Completion">
            <div className="flex items-center gap-5">
              <Ring pct={pct} />
              <div className="space-y-1.5 text-sm">
                <Legend color="rgb(var(--c-success))" label="Done" value={buckets.done} />
                <Legend color="rgb(var(--c-danger))" label="Overdue" value={buckets.overdue} />
                <Legend color="rgb(var(--c-warn))" label="Due soon" value={buckets.soon} />
                <Legend color="rgb(var(--c-accent))" label="Later" value={buckets.later} />
                <Legend color="rgb(var(--c-rule))" label="No date" value={buckets.none} />
              </div>
            </div>
            <Stacked
              parts={[
                { v: buckets.done, c: "rgb(var(--c-success))" },
                { v: buckets.overdue, c: "rgb(var(--c-danger))" },
                { v: buckets.soon, c: "rgb(var(--c-warn))" },
                { v: buckets.later, c: "rgb(var(--c-accent))" },
                { v: buckets.none, c: "rgb(var(--c-rule))" },
              ]}
            />
          </Panel>

          <Panel i={5} title="Needs attention" className="lg:col-span-2">
            {attention.length === 0 ? (
              <div className="h-full min-h-[120px] grid place-items-center text-center text-sm text-muted">
                <div>
                  <CheckCircle2 size={22} className="mx-auto mb-2 text-success" />
                  Nothing overdue or due in the next 7 days.
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-line -my-1">
                {attention.map((c, i) => {
                  const overdue = dueStatus(c.due_date, false) === "overdue";
                  return (
                    <li key={c.id} className="rise" style={{ "--i": i } as React.CSSProperties}>
                      <button
                        data-card-id={c.id}
                        onClick={() => onOpenCard(c.id)}
                        className="w-full flex items-center gap-3 py-2 px-2 -mx-2 rounded-md text-left hover:bg-inset transition-colors group"
                      >
                        <span className={cn("h-2 w-2 rounded-full shrink-0", overdue ? "bg-danger" : "bg-warn")} />
                        <span className="flex-1 min-w-0 truncate text-sm font-medium text-ink group-hover:text-accent transition-colors">
                          {c.title}
                        </span>
                        <span className="text-xs text-subtle truncate max-w-[120px] hidden sm:inline">
                          {lists.find((l) => l.id === c.list_id)?.title}
                        </span>
                        <span
                          className={cn(
                            "text-xs font-medium tabular-nums rounded-full px-2 py-0.5",
                            overdue ? "bg-danger/10 text-danger" : "bg-warn/10 text-warn",
                          )}
                        >
                          {shortDate(c.due_date!)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          <Panel i={6} title="Cards by list">
            <Bars items={perList} />
          </Panel>
          <Panel i={7} title="Cards by label">
            <Bars items={perLabel} />
          </Panel>
          <Panel i={8} title="Cards by member" className="md:col-span-2 xl:col-span-1">
            <Bars
              items={perMember.map((m) => ({
                ...m,
                icon: <Avatar name={m.profile.display_name} src={m.profile.avatar_url} size={18} />,
              }))}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}

// Eases a number from its previous value to the new one.
function useCountUp(value: number, ms = 700) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = Math.round(a + (value - a) * eased);
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

function Kpi({ i, icon, label, value, tone }: { i: number; icon: React.ReactNode; label: string; value: number; tone: string }) {
  const n = useCountUp(value);
  return (
    <div
      className="rise rounded-lg border border-border bg-surface shadow-card p-4 transition-[box-shadow,transform] duration-200 hover:shadow-pop"
      style={{ "--i": i } as React.CSSProperties}
    >
      <div className={cn("flex items-center gap-2 text-xs font-medium text-muted")}>
        <span className={tone}>{icon}</span>
        {label}
      </div>
      <div className={cn("mt-2 text-2xl sm:text-3xl font-semibold tabular-nums tracking-display", tone)}>{n}</div>
    </div>
  );
}

function Panel({ i, title, children, className }: { i: number; title: string; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn("rise rounded-lg border border-border bg-surface shadow-card p-4 sm:p-5 flex flex-col", className)}
      style={{ "--i": i } as React.CSSProperties}
    >
      <div className="text-xs font-semibold uppercase tracking-eyebrow text-subtle mb-4">{title}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 38;
  const circ = 2 * Math.PI * r;
  const [drawn, setDrawn] = useState(0);
  // Start from 0 so the stroke animates in on mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  const n = useCountUp(pct);
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 96 96" className="h-24 w-24 -rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" strokeWidth="10" className="stroke-inset" />
        <circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          className="stroke-success transition-[stroke-dashoffset] duration-700 ease-pop"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - drawn / 100)}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="text-xl font-semibold text-ink tabular-nums">{n}%</div>
          <div className="text-[10px] text-subtle -mt-0.5">of dated</div>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: color }} />
      <span className="text-muted w-16">{label}</span>
      <span className="font-semibold text-ink tabular-nums">{value}</span>
    </div>
  );
}

function Stacked({ parts }: { parts: { v: number; c: string }[] }) {
  const sum = parts.reduce((s, p) => s + p.v, 0);
  if (!sum) return null;
  return (
    <div className="mt-5 h-2.5 w-full rounded-full overflow-hidden flex bg-inset grow-x">
      {parts.map((p, i) =>
        p.v ? <div key={i} className="h-full transition-[width] duration-500 ease-pop" style={{ width: `${(p.v / sum) * 100}%`, background: p.c }} /> : null,
      )}
    </div>
  );
}

function Bars({ items }: { items: { key: string; label: string; count: number; color?: string; icon?: React.ReactNode }[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  if (items.length === 0) return <div className="text-sm text-subtle">Nothing to show yet.</div>;
  return (
    <div className="space-y-2.5">
      {items.map((it, idx) => (
        <div key={it.key} className="group flex items-center gap-3 text-sm">
          <div className="w-28 flex items-center gap-2 min-w-0">
            {it.icon}
            <span className="truncate text-muted font-medium group-hover:text-ink transition-colors" title={it.label}>
              {it.label}
            </span>
          </div>
          <div className="flex-1 h-2.5 rounded-full bg-inset overflow-hidden">
            <div
              className="grow-x h-full rounded-full transition-[width] duration-500 ease-pop"
              style={{
                width: `${(it.count / max) * 100}%`,
                background: it.color ?? "rgb(var(--c-accent))",
                "--i": idx,
              } as React.CSSProperties}
            />
          </div>
          <div className="w-7 text-right tabular-nums text-ink font-semibold">{it.count}</div>
        </div>
      ))}
    </div>
  );
}
