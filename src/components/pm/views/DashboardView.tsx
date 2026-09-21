import { useMemo } from "react";
import type { Card, Label as LabelT, List, Profile } from "@/lib/database.types";
import { dueStatus } from "@/lib/format";
import { cn } from "@/lib/cn";

interface Props {
  cards: Card[];
  lists: List[];
  labels: LabelT[];
  members: Profile[];
  cardLabelsByCard: Map<string, string[]>;
  cardMembersByCard: Map<string, string[]>;
}

export function DashboardView({
  cards,
  lists,
  labels,
  members,
  cardLabelsByCard,
  cardMembersByCard,
}: Props) {
  const total = cards.length;

  const perList = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cards) m.set(c.list_id, (m.get(c.list_id) ?? 0) + 1);
    return lists.map((l) => ({ label: l.title, count: m.get(l.id) ?? 0 }));
  }, [cards, lists]);

  const perLabel = useMemo(() => {
    const m = new Map<string, number>();
    for (const [cid, ids] of cardLabelsByCard.entries()) {
      if (!cards.find((c) => c.id === cid)) continue;
      for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
    }
    return labels.map((l) => ({ label: l.name || "(unnamed)", color: l.color, count: m.get(l.id) ?? 0 }));
  }, [cardLabelsByCard, cards, labels]);

  const perMember = useMemo(() => {
    const m = new Map<string, number>();
    for (const [cid, ids] of cardMembersByCard.entries()) {
      if (!cards.find((c) => c.id === cid)) continue;
      for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
    }
    return members.map((mm) => ({ label: mm.display_name, count: m.get(mm.id) ?? 0 }));
  }, [cardMembersByCard, cards, members]);

  const dueBuckets = useMemo(() => {
    const b = { overdue: 0, soon: 0, later: 0, none: 0, done: 0 };
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

  return (
    <div className="p-4 md:p-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Card title="Total cards">
        <div className="text-4xl font-semibold text-ink">{total}</div>
      </Card>

      <Card title="By due status">
        <div className="grid grid-cols-5 gap-2 text-xs">
          <Stat label="Overdue" value={dueBuckets.overdue} tone="bg-danger/10 text-danger" />
          <Stat label="Soon" value={dueBuckets.soon} tone="bg-warn/10 text-warn" />
          <Stat label="Later" value={dueBuckets.later} tone="bg-surface text-muted" />
          <Stat label="Done" value={dueBuckets.done} tone="bg-success/10 text-success" />
          <Stat label="No date" value={dueBuckets.none} tone="bg-surface text-muted" />
        </div>
      </Card>

      <Card title="Cards by list">
        <Bars items={perList} />
      </Card>

      <Card title="Cards by label" className="md:col-span-2">
        <Bars items={perLabel.map((x) => ({ label: x.label, count: x.count, color: x.color }))} />
      </Card>

      <Card title="Cards by member">
        <Bars items={perMember} />
      </Card>
    </div>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-white shadow-card p-4", className)}>
      <div className="text-sm font-semibold text-ink mb-3">{title}</div>
      {children}
    </div>
  );
}
function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={cn("rounded-md px-2 py-2 text-center", tone)}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  );
}
function Bars({ items }: { items: { label: string; count: number; color?: string }[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <div className="space-y-1.5">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-2 text-sm">
          <div className="w-24 truncate text-muted">{i.label}</div>
          <div className="flex-1 h-2 rounded bg-surface overflow-hidden">
            <div
              className="h-full rounded"
              style={{ width: `${(i.count / max) * 100}%`, background: i.color ?? "#f53900" }}
            />
          </div>
          <div className="w-8 text-right tabular-nums text-ink">{i.count}</div>
        </div>
      ))}
      {items.length === 0 && <div className="text-sm text-subtle">Nothing to show yet.</div>}
    </div>
  );
}
