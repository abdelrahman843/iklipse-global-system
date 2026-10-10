import { useEffect, useMemo, useState } from "react";
import { BackButton } from "@/components/ui/BackButton";
import { SearchField } from "@/components/ui/SearchField";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { shortDate } from "@/lib/format";
import { searchCards, type SearchHit } from "@/lib/pm/searchApi";
import type { BoardBundle } from "@/lib/pm/boardApi";
import { useIsOnline } from "@/lib/offline/net";

/** Offline: the same search over the boards saved on this device. */
function searchOnDevice(qc: QueryClient, q: string, limit = 50): SearchHit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: SearchHit[] = [];
  for (const [, b] of qc.getQueriesData<BoardBundle>({ queryKey: ["board"] })) {
    if (!b?.board || !Array.isArray(b.cards)) continue;
    const lists = new Map(b.lists.map((l) => [l.id, l.title]));
    for (const c of b.cards) {
      const title = c.title.toLowerCase();
      const text = `${title} ${(c.description ?? "").toLowerCase()}`;
      if (!words.every((w) => text.includes(w))) continue;
      hits.push({
        card_id: c.id,
        board_id: b.board.id,
        board_title: b.board.title,
        list_id: c.list_id,
        list_title: lists.get(c.list_id) ?? "",
        title: c.title,
        description: c.description,
        due_date: c.due_date,
        rank: words.every((w) => title.includes(w)) ? 2 : 1,
      });
    }
  }
  return hits.sort((a, b) => b.rank - a.rank).slice(0, limit);
}

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

  const online = useIsOnline();
  const qc = useQueryClient();
  const server = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => searchCards(debounced),
    enabled: debounced.trim().length > 0 && online,
  });
  const local = useMemo(() => (online ? [] : searchOnDevice(qc, debounced)), [online, qc, debounced]);
  const data = online ? server.data : local;
  const isFetching = online && server.isFetching;
  const isLoading = online && server.isLoading;
  const error = online ? server.error : null;

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-6 flex items-start sm:items-center gap-3">
        <BackButton fallback="/pm/boards" />
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-subtle mb-1">Search everything</div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Search</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">Titles, descriptions, across every board you can see.</p>
        </div>
      </div>

      <SearchField autoFocus size="lg" value={q} onChange={setQ} loading={isFetching} placeholder="Search cards…" aria-label="Search cards" />

      <div className="mt-5">
        {!online && debounced.trim().length > 0 && (
          <p className="mb-3 text-xs text-subtle">You're offline: these results come from the boards saved on this device.</p>
        )}
        {debounced.trim().length === 0 ? (
          <EmptyState title="Type to search" description="Search by any word in a card's title or description." />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-14 text-subtle">
            <PageSpinner />
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
