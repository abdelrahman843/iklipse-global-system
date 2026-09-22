import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
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

  const { data, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchCards(debounced),
    enabled: debounced.trim().length > 0,
  });

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <div className="eyebrow text-subtle mb-1">Search everything</div>
        <h1 className="text-3xl font-semibold text-ink tracking-tight">Search</h1>
        <p className="text-sm text-muted mt-1">Titles, descriptions, across every board you can see.</p>
      </div>

      <div className="relative">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search cards…"
          className="pl-9 h-10 text-base shadow-card focus-visible:shadow-pop"
        />
        <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" size={16} />
        {isFetching && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 text-subtle">
            <Spinner size={14} />
          </div>
        )}
      </div>

      <div className="mt-5">
        {debounced.trim().length === 0 ? (
          <EmptyState title="Type to search" description="Search by any word in a card's title or description." />
        ) : (data ?? []).length === 0 ? (
          <EmptyState title="No results found." />
        ) : (
          <ul className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
            {(data ?? []).map((h) => (
              <li key={h.card_id}>
                <Link
                  to={`/pm/boards/${h.board_id}/cards/${h.card_id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-inset transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-subtle">
                      {h.board_title} · {h.list_title}
                    </div>
                    <div className="font-medium text-ink truncate">{h.title}</div>
                    {h.description && (
                      <div className="text-sm text-muted line-clamp-1">{h.description}</div>
                    )}
                  </div>
                  {h.due_date && <div className="text-xs text-subtle">{shortDate(h.due_date)}</div>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
