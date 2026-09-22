import { useMemo, useState } from "react";
import type { Card, Label as LabelT, List, Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { dueStatus, shortDate } from "@/lib/format";
import { cn } from "@/lib/cn";

interface Props {
  cards: Card[];
  lists: List[];
  labelsById: Map<string, LabelT>;
  membersById: Map<string, Profile>;
  cardLabelsByCard: Map<string, string[]>;
  cardMembersByCard: Map<string, string[]>;
  onOpenCard: (id: string) => void;
}

type SortKey = "title" | "list" | "due" | "updated";

export function TableView({
  cards,
  lists,
  labelsById,
  membersById,
  cardLabelsByCard,
  cardMembersByCard,
  onOpenCard,
}: Props) {
  const [sort, setSort] = useState<SortKey>("updated");
  const [dir, setDir] = useState<1 | -1>(-1);

  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);

  const rows = useMemo(() => {
    const sorted = [...cards];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sort === "title") cmp = a.title.localeCompare(b.title);
      else if (sort === "list") {
        const la = listById.get(a.list_id)?.title ?? "";
        const lb = listById.get(b.list_id)?.title ?? "";
        cmp = la.localeCompare(lb);
      } else if (sort === "due") {
        const da = a.due_date ? new Date(a.due_date).getTime() : Number.POSITIVE_INFINITY;
        const db = b.due_date ? new Date(b.due_date).getTime() : Number.POSITIVE_INFINITY;
        cmp = da - db;
      } else if (sort === "updated") {
        cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
      }
      return cmp * dir;
    });
    return sorted;
  }, [cards, sort, dir, listById]);

  const setSortKey = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSort(k);
      setDir(k === "title" || k === "list" ? 1 : -1);
    }
  };

  return (
    <div className="p-2 sm:p-4 h-full overflow-auto">
      <div className="overflow-x-auto rounded-lg border border-border shadow-card">
      <table className="w-full text-sm bg-surface min-w-[640px]">
        <thead className="bg-inset text-muted text-[11px] uppercase tracking-[0.3px] border-b border-border">
          <tr>
            <Th onClick={() => setSortKey("title")} active={sort === "title"} dir={dir}>Card</Th>
            <Th onClick={() => setSortKey("list")} active={sort === "list"} dir={dir}>List</Th>
            <th className="text-left px-3 py-2.5 font-semibold">Members</th>
            <th className="text-left px-3 py-2.5 font-semibold">Labels</th>
            <Th onClick={() => setSortKey("due")} active={sort === "due"} dir={dir}>Due</Th>
            <Th onClick={() => setSortKey("updated")} active={sort === "updated"} dir={dir}>Updated</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => {
            const status = dueStatus(c.due_date, c.due_completed);
            const memberIds = cardMembersByCard.get(c.id) ?? [];
            const labelIds = cardLabelsByCard.get(c.id) ?? [];
            return (
              <tr
                key={c.id}
                className={cn(
                  "border-t border-line hover:bg-inset cursor-pointer transition-colors",
                  i % 2 === 1 && "bg-bg/40",
                )}
                onClick={() => onOpenCard(c.id)}
              >
                <td className="px-3 py-2.5">
                  <div className="font-medium text-ink">{c.title}</div>
                </td>
                <td className="px-3 py-2.5 text-muted">{listById.get(c.list_id)?.title ?? "—"}</td>
                <td className="px-3 py-2.5">
                  <div className="flex -space-x-1.5">
                    {memberIds.slice(0, 4).map((id) => {
                      const m = membersById.get(id);
                      if (!m) return null;
                      return <Avatar key={id} name={m.display_name} src={m.avatar_url} size={20} />;
                    })}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {labelIds.map((id) => {
                      const l = labelsById.get(id);
                      if (!l) return null;
                      return (
                        <span key={id} className="h-2 w-8 rounded ring-1 ring-black/5" style={{ background: l.color }} />
                      );
                    })}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  {c.due_date ? (
                    <Badge
                      tone={
                        status === "overdue"
                          ? "danger"
                          : status === "soon"
                            ? "warn"
                            : status === "completed"
                              ? "success"
                              : "neutral"
                      }
                    >
                      {shortDate(c.due_date)}
                    </Badge>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-subtle">{shortDate(c.updated_at)}</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-6 py-10 text-center text-subtle">
                No cards match your filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function Th({
  children,
  onClick,
  active,
  dir,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  dir: 1 | -1;
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        "text-left px-3 py-2.5 font-semibold cursor-pointer select-none hover:text-ink transition-colors",
        active && "text-ink",
      )}
    >
      <span className="inline-flex items-center gap-1">
        {children} {active ? (dir === 1 ? "▲" : "▼") : ""}
      </span>
    </th>
  );
}
