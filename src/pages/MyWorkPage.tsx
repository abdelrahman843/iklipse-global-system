import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { addDays, endOfDay } from "date-fns";
import { Calendar, ChevronRight, ListTodo } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { dueStatus, isCardDone, shortDate } from "@/lib/format";
import { fetchMyWork, type MyWorkCard } from "@/lib/pm/myWorkApi";

const byDue = (a: MyWorkCard, b: MyWorkCard) =>
  new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime();
const byBoardThenTitle = (a: MyWorkCard, b: MyWorkCard) =>
  a.board_title.localeCompare(b.board_title) || a.title.localeCompare(b.title);

export function MyWorkPage() {
  const { user } = useAuth();
  const [boardId, setBoardId] = useState("");
  const [showDone, setShowDone] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["my-work", user?.id],
    queryFn: () => fetchMyWork(user!.id),
    enabled: !!user,
    refetchOnWindowFocus: true,
  });

  // Boards that hold at least one of my cards, for the filter.
  const boards = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data ?? []) m.set(c.board_id, c.board_title);
    return [...m].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
  }, [data]);

  // A board picked earlier may have no cards left after a refetch.
  const board = boards.some((b) => b.id === boardId) ? boardId : "";

  const groups = useMemo(() => {
    const cards = (data ?? []).filter((c) => !board || c.board_id === board);
    const weekEnd = endOfDay(addDays(new Date(), 7));
    const g = {
      overdue: [] as MyWorkCard[],
      week: [] as MyWorkCard[],
      later: [] as MyWorkCard[],
      none: [] as MyWorkCard[],
      done: [] as MyWorkCard[],
    };
    for (const c of cards) {
      if (isCardDone(c)) g.done.push(c);
      else if (!c.due_date) g.none.push(c);
      else if (dueStatus(c.due_date, false) === "overdue") g.overdue.push(c);
      else if (new Date(c.due_date) <= weekEnd) g.week.push(c);
      else g.later.push(c);
    }
    g.overdue.sort(byDue);
    g.week.sort(byDue);
    g.later.sort(byDue);
    g.none.sort(byBoardThenTitle);
    g.done.sort(byBoardThenTitle);
    return g;
  }, [data, board]);

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load your work" description={(error as Error).message} />
      </div>
    );

  const openCount = groups.overdue.length + groups.week.length + groups.later.length + groups.none.length;

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-3xl mx-auto">
      {/* Phones: the board filter drops under the title at full width. */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <Link to="/pm/boards" className="eyebrow text-subtle hover:text-ink transition-colors mb-1 inline-block">
            Trello
          </Link>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">My work</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">Every card you're a member of, on every board you can see.</p>
        </div>
        {boards.length > 1 && (
          <Select
            className="w-full sm:w-56 shrink-0"
            align="right"
            aria-label="Filter by board"
            value={board}
            onChange={setBoardId}
            options={[{ value: "", label: "All boards" }, ...boards.map((b) => ({ value: b.id, label: b.title }))]}
          />
        )}
      </div>

      {(data ?? []).length === 0 ? (
        <EmptyState
          icon={<ListTodo size={28} />}
          title="Nothing assigned to you."
          description="Cards you're added to as a member, on any board, show up here."
        />
      ) : (
        <div className="space-y-8">
          {openCount === 0 ? (
            <EmptyState
              icon={<ListTodo size={28} />}
              title="You're all caught up."
              description={board ? "No open cards assigned to you on this board." : "No open cards assigned to you."}
            />
          ) : (
            <>
              <Section title="Overdue" cards={groups.overdue} tone="danger" />
              <Section title="Next 7 days" hint="Due today or within the next week." cards={groups.week} />
              <Section title="Later" cards={groups.later} />
              <Section title="No due date" cards={groups.none} />
            </>
          )}

          {groups.done.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                className="mb-3 min-h-10 sm:min-h-0 inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-ink hover:text-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <ChevronRight size={16} className={cn("text-muted transition-transform duration-150", showDone && "rotate-90")} />
                Done
                <span className="text-xs font-normal text-subtle">{groups.done.length}</span>
              </button>
              {showDone && <CardRows cards={groups.done} />}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  cards,
  tone,
}: {
  title: string;
  hint?: string;
  cards: MyWorkCard[];
  tone?: "danger";
}) {
  if (cards.length === 0) return null;
  return (
    <section>
      <div className="mb-3">
        <h2 className={cn("text-sm font-semibold flex items-center gap-1.5", tone === "danger" ? "text-danger" : "text-ink")}>
          {title}
          <span className="text-xs font-normal text-subtle">{cards.length}</span>
        </h2>
        {hint && <p className="text-xs text-muted mt-0.5">{hint}</p>}
      </div>
      <CardRows cards={cards} />
    </section>
  );
}

function CardRows({ cards }: { cards: MyWorkCard[] }) {
  return (
    <ul className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
      {cards.map((c) => {
        const done = isCardDone(c);
        const status = dueStatus(c.due_date, done);
        return (
          <li key={c.id}>
            <Link
              to={`/pm/boards/${c.board_id}/cards/${c.id}`}
              className="flex items-center gap-3 px-3 sm:px-4 py-3 hover:bg-inset transition-colors"
            >
              <div className="flex-1 min-w-0">
                {c.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {c.labels.map((l) => (
                      <span
                        key={l.id}
                        className="h-2 w-10 rounded-full ring-1 ring-border"
                        style={{ background: l.color }}
                        title={l.name || undefined}
                      />
                    ))}
                  </div>
                )}
                <div className={cn("font-medium text-ink truncate", done && "line-through opacity-70")}>{c.title}</div>
                <div className="text-xs text-subtle truncate">
                  {c.board_title} · {c.list_title}
                </div>
              </div>
              {c.due_date && (
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
                  className="text-[10px] font-medium shrink-0"
                >
                  <Calendar size={10} /> {shortDate(c.due_date)}
                </Badge>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
