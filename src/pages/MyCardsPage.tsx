import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PageSpinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Badge } from "@/components/ui/Badge";
import { myCards } from "@/lib/pm/searchApi";
import { dueStatus, shortDate } from "@/lib/format";

export function MyCardsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["my-cards"], queryFn: myCards });

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <div className="eyebrow text-subtle mb-1">Personal queue</div>
        <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">My cards</h1>
        <p className="text-sm text-muted mt-1 hidden sm:block">Cards assigned to you, sorted by due date.</p>
      </div>

      {(data ?? []).length === 0 ? (
        <EmptyState title="Nothing is assigned to you." />
      ) : (
        <ul className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line">
          {(data ?? []).map((c) => {
            const status = dueStatus(c.due_date, c.due_completed);
            return (
              <li key={c.card_id}>
                <Link
                  to={`/pm/boards/${c.board_id}/cards/${c.card_id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-inset transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-subtle">
                      {c.board_title} · {c.list_title}
                    </div>
                    <div className="font-medium text-ink truncate">{c.title}</div>
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
                    >
                      {shortDate(c.due_date)}
                    </Badge>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
