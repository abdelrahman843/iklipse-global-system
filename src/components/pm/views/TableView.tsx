import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Inbox } from "lucide-react";
import type { Card, Label as LabelT, List, Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { dueStatus, relativeTime, shortDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import { readableText } from "@/components/pm/ColorPicker";

interface Props {
  cards: Card[];
  lists: List[];
  labelsById: Map<string, LabelT>;
  membersById: Map<string, Profile>;
  cardLabelsByCard: Map<string, string[]>;
  cardMembersByCard: Map<string, string[]>;
  onOpenCard: (id: string) => void;
  /** Present only when the viewer may change dates — shows a completion toggle. */
  onToggleComplete?: (id: string, completed: boolean) => void;
}

type SortKey = "title" | "list" | "due" | "updated";

const DUE_TONE = { overdue: "danger", soon: "warn", completed: "success", later: "neutral" } as const;

export function TableView({
  cards,
  lists,
  labelsById,
  membersById,
  cardLabelsByCard,
  cardMembersByCard,
  onOpenCard,
  onToggleComplete,
}: Props) {
  const [sort, setSort] = useState<SortKey>("updated");
  const [dir, setDir] = useState<1 | -1>(-1);

  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const listOrder = useMemo(() => new Map(lists.map((l, i) => [l.id, i])), [lists]);

  const rows = useMemo(() => {
    const sorted = [...cards];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sort === "title") cmp = a.title.localeCompare(b.title);
      // Lists sort in board order, not alphabetically — matches the board.
      else if (sort === "list") cmp = (listOrder.get(a.list_id) ?? 0) - (listOrder.get(b.list_id) ?? 0);
      else if (sort === "due") {
        // Undated cards always sink to the bottom, whichever direction.
        if (!a.due_date && !b.due_date) return 0;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        cmp = new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      } else cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      return cmp * dir;
    });
    return sorted;
  }, [cards, sort, dir, listOrder]);

  const setSortKey = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(k === "updated" ? -1 : 1);
    }
  };

  const done = cards.filter((c) => c.due_completed).length;

  return (
    <div className="p-2 sm:p-4 h-full flex flex-col min-h-0">
      {/* One scroll container for both axes so the sticky header actually sticks. */}
      <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-border bg-surface shadow-card">
        <table className="w-full text-sm min-w-[720px] border-separate border-spacing-0">
          <thead className="sticky top-0 z-10">
            <tr className="bg-inset/95 backdrop-blur text-muted text-[11px] uppercase tracking-eyebrow">
              {onToggleComplete && <th className="w-10 border-b border-border" aria-label="Complete" />}
              <Th k="title" sort={sort} dir={dir} onSort={setSortKey}>Card</Th>
              <Th k="list" sort={sort} dir={dir} onSort={setSortKey}>List</Th>
              <th className="text-left px-3 py-2.5 font-semibold border-b border-border">Labels</th>
              <th className="text-left px-3 py-2.5 font-semibold border-b border-border">Members</th>
              <Th k="due" sort={sort} dir={dir} onSort={setSortKey}>Due</Th>
              <Th k="updated" sort={sort} dir={dir} onSort={setSortKey}>Updated</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const status = dueStatus(c.due_date, c.due_completed);
              const memberIds = cardMembersByCard.get(c.id) ?? [];
              const labelIds = cardLabelsByCard.get(c.id) ?? [];
              const list = listById.get(c.list_id);
              return (
                <tr
                  key={c.id}
                  data-card-id={c.id}
                  tabIndex={0}
                  style={{ "--i": i } as React.CSSProperties}
                  className="rise group cursor-pointer outline-none transition-colors hover:bg-inset focus-visible:bg-accent-soft"
                  onClick={() => onOpenCard(c.id)}
                  onKeyDown={(e) => e.key === "Enter" && onOpenCard(c.id)}
                >
                  {onToggleComplete && (
                    <td className="pl-3 py-2.5 border-b border-line" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => onToggleComplete(c.id, !c.due_completed)}
                        aria-label={c.due_completed ? "Mark incomplete" : "Mark complete"}
                        className={cn(
                          "h-[18px] w-[18px] rounded-full border-2 grid place-items-center transition-all duration-200",
                          c.due_completed
                            ? "bg-success border-success text-white scale-100"
                            : "border-rule text-transparent hover:border-success hover:text-success/60",
                        )}
                      >
                        <Check size={11} strokeWidth={3} />
                      </button>
                    </td>
                  )}
                  <td className="px-3 py-2.5 border-b border-line max-w-[320px]">
                    <div
                      className={cn(
                        "font-medium truncate transition-colors group-hover:text-accent",
                        c.due_completed ? "text-subtle line-through" : "text-ink",
                      )}
                    >
                      {c.title}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 border-b border-line">
                    <span className="inline-flex items-center gap-1.5 text-muted">
                      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: list?.color ?? "rgb(var(--c-rule))" }} />
                      <span className="truncate max-w-[160px]">{list?.title ?? "—"}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 border-b border-line">
                    <div className="flex flex-wrap gap-1 max-w-[220px]">
                      {labelIds.map((id) => {
                        const l = labelsById.get(id);
                        if (!l) return null;
                        return l.name ? (
                          <span
                            key={id}
                            className="h-5 px-1.5 rounded-md text-[11px] font-medium inline-flex items-center truncate max-w-[110px]"
                            style={{ background: l.color, color: readableText(l.color) }}
                          >
                            {l.name}
                          </span>
                        ) : (
                          <span key={id} className="h-2 w-8 rounded self-center" style={{ background: l.color }} />
                        );
                      })}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 border-b border-line">
                    <div className="flex -space-x-1.5">
                      {memberIds.slice(0, 4).map((id) => {
                        const m = membersById.get(id);
                        if (!m) return null;
                        return (
                          <span key={id} title={m.display_name} className="rounded-full ring-2 ring-surface">
                            <Avatar name={m.display_name} src={m.avatar_url} size={22} />
                          </span>
                        );
                      })}
                      {memberIds.length > 4 && (
                        <span className="h-[22px] min-w-[22px] px-1 rounded-full bg-inset ring-2 ring-surface text-[10px] font-semibold text-muted grid place-items-center">
                          +{memberIds.length - 4}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 border-b border-line whitespace-nowrap">
                    {c.due_date && status ? (
                      <Badge tone={DUE_TONE[status]}>{shortDate(c.due_date)}</Badge>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 border-b border-line text-subtle whitespace-nowrap" title={new Date(c.updated_at).toLocaleString()}>
                    {relativeTime(c.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-subtle view-enter">
            <Inbox size={28} />
            <div className="text-sm">No cards match your filters.</div>
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div className="pt-2 px-1 text-xs text-subtle flex gap-3">
          <span>
            <span className="font-semibold text-muted tabular-nums">{rows.length}</span> cards
          </span>
          <span>
            <span className="font-semibold text-muted tabular-nums">{done}</span> complete
          </span>
        </div>
      )}
    </div>
  );
}

function Th({
  k,
  sort,
  dir,
  onSort,
  children,
}: {
  k: SortKey;
  sort: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sort === k;
  const Icon = !active ? ChevronsUpDown : dir === 1 ? ArrowUp : ArrowDown;
  return (
    <th
      aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"}
      className="text-left font-semibold border-b border-border p-0"
    >
      <button
        onClick={() => onSort(k)}
        className={cn(
          "w-full px-3 py-2.5 inline-flex items-center gap-1 uppercase tracking-eyebrow transition-colors hover:text-ink",
          active && "text-ink",
        )}
      >
        {children}
        <Icon size={12} className={cn("transition-opacity", active ? "opacity-100 text-accent" : "opacity-40")} />
      </button>
    </th>
  );
}
