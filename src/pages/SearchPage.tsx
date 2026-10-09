import { useEffect, useState } from "react";
import { SearchField } from "@/components/ui/SearchField";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { EmptyState } from "@/components/ui/EmptyState";
import { LogoLoader } from "@/components/ui/Spinner";
import { shortDate } from "@/lib/format";
import { searchCards } from "@/lib/pm/searchApi";

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(q), 250);
    return () => window.clearTimeout(h);
  }, [q]);

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (debounced) next.set("q", debounced);
    else next.delete("q");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const { data, isFetching, isLoading, error } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchCards(debounced),
    enabled: debounced.trim().length > 0,
  });

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <div className="eyebrow text-subtle mb-1">Search everything</div>
        <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Search</h1>
        <p className="text-sm text-muted mt-1 hidden sm:block">Titles, descriptions, across every board you can see.</p>
      </div>

      <SearchField autoFocus size="lg" value={q} onChange={setQ} loading={isFetching} placeholder="Search cards…" aria-label="Search cards" />

      <div className="mt-5">
        {debounced.trim().length === 0 ? (
          <EmptyState title="Type to search" description="Search by any word in a card's title or description." />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-14 text-subtle">
            <LogoLoader width={84} />
          </div>
        ) : error ? (
          <EmptyState title="Search failed" description={(error as Error).message} />
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="No results found." />
        ) : (
          <ul className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
            {(data ?? []).map((h) => (
              <li key={h.card_id}>
                <Link
                  to={`/pm/boards/${h.board_id}/cards/${h.card_id}`}
                  className="flex items-center gap-3 px-3 sm:px-4 py-3 hover:bg-inset transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-subtle truncate">
                      {h.board_title} · {h.list_title}
                    </div>
                    <div className="font-medium text-ink truncate">{h.title}</div>
                    {h.description && (
                      <div className="text-sm text-muted line-clamp-1 break-words">{h.description}</div>
                    )}
                  </div>
                  {h.due_date && <div className="text-xs text-subtle shrink-0 whitespace-nowrap">{shortDate(h.due_date)}</div>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
