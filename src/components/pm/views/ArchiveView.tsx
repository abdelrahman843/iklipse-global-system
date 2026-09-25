import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Columns3, CreditCard, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useBoardCan } from "@/lib/pm/boardAccess";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import { deleteCard, fetchArchivedCards, fetchArchivedLists, restoreList, setCardArchived } from "@/lib/pm/boardApi";

interface Props {
  boardId: string;
  onOpenCard: (id: string) => void;
}

type Tab = "cards" | "lists";

export function ArchiveView({ boardId, onOpenCard }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const can = useBoardCan();
  const [tab, setTab] = useState<Tab>("cards");
  const [q, setQ] = useState("");
  // Rows play a collapse animation before the refetch removes them.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  const cardsQ = useQuery({ queryKey: ["archived-cards", boardId], queryFn: () => fetchArchivedCards(boardId) });
  const listsQ = useQuery({ queryKey: ["archived-lists", boardId], queryFn: () => fetchArchivedLists(boardId) });

  // Fresh data no longer has the removed rows — drop the collapse markers so
  // a card archived again later isn't born hidden.
  useEffect(() => setLeaving(new Set()), [cardsQ.data, listsQ.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["archived-cards", boardId] });
    qc.invalidateQueries({ queryKey: ["archived-lists", boardId] });
    qc.invalidateQueries({ queryKey: ["board", boardId] });
  };
  const leave = (id: string) => setLeaving((s) => new Set(s).add(id));
  const unleave = (id: string) =>
    setLeaving((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });

  const restoreCard = useMutation({
    mutationFn: (id: string) => setCardArchived(id, false),
    onMutate: leave,
    onSuccess: () => {
      toast.push({ kind: "success", title: "Card restored" });
      setTimeout(refresh, 220);
    },
    onError: (e: Error, id) => {
      unleave(id);
      toast.push({ kind: "error", title: "Restore failed", description: e.message });
    },
  });

  const removeCard = useMutation({
    mutationFn: (id: string) => deleteCard(id),
    onMutate: leave,
    onSuccess: () => {
      toast.push({ kind: "info", title: "Card deleted" });
      setTimeout(refresh, 220);
    },
    onError: (e: Error, id) => {
      unleave(id);
      toast.push({ kind: "error", title: "Delete failed", description: e.message });
    },
  });

  const restoreL = useMutation({
    mutationFn: (id: string) => restoreList(id),
    onMutate: leave,
    onSuccess: () => {
      toast.push({ kind: "success", title: "List restored" });
      setTimeout(refresh, 220);
    },
    onError: (e: Error, id) => {
      unleave(id);
      toast.push({ kind: "error", title: "Restore failed", description: e.message });
    },
  });

  const canRestore = can("pm.archive_card");
  const canDelete = can("pm.delete_card");
  const canRestoreList = can("pm.archive_list");

  const needle = q.trim().toLowerCase();
  const cards = useMemo(
    () => (cardsQ.data ?? []).filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.list_title?.toLowerCase().includes(needle)),
    [cardsQ.data, needle],
  );
  const lists = useMemo(
    () => (listsQ.data ?? []).filter((l) => !needle || l.title.toLowerCase().includes(needle)),
    [listsQ.data, needle],
  );

  const loading = tab === "cards" ? cardsQ.isLoading : listsQ.isLoading;
  const error = tab === "cards" ? cardsQ.error : listsQ.error;

  return (
    <div className="p-2 sm:p-4 h-full overflow-auto">
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="flex items-center gap-2 mr-auto">
            <span className="h-8 w-8 rounded-md bg-inset border border-line grid place-items-center text-muted">
              <Archive size={16} />
            </span>
            <h2 className="text-lg font-semibold text-ink">Archive</h2>
          </div>

          <div className="inline-flex items-center gap-1 rounded-lg bg-inset border border-line p-1">
            {(
              [
                ["cards", "Cards", <CreditCard key="c" size={14} />, cardsQ.data?.length],
                ["lists", "Lists", <Columns3 key="l" size={14} />, listsQ.data?.length],
              ] as const
            ).map(([k, label, icon, n]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cn(
                  "inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-md font-medium transition-[background-color,color,box-shadow] duration-150",
                  tab === k ? "bg-surface text-ink shadow-card" : "text-muted hover:text-ink",
                )}
              >
                {icon}
                {label}
                {n !== undefined && (
                  <span className={cn("text-[11px] tabular-nums rounded-full px-1.5", tab === k ? "bg-accent-soft text-accent" : "bg-surface/70")}>{n}</span>
                )}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-56">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle pointer-events-none" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search archived ${tab}`}
              className="w-full h-9 pl-8 pr-8 rounded-md border border-border bg-surface text-sm text-ink placeholder:text-subtle outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring transition-[border-color,box-shadow] duration-150"
            />
            {q && (
              <button onClick={() => setQ("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 h-6 w-6 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors" aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="p-10 flex justify-center">
            <Spinner size={20} />
          </div>
        ) : error ? (
          <EmptyState title="Couldn't load archive" description={(error as Error).message} />
        ) : tab === "cards" ? (
          cards.length === 0 ? (
            <div key="empty-cards" className="view-enter">
              <EmptyState
                icon={<Archive size={22} />}
                title={needle ? "No matches." : "No archived cards."}
                description={needle ? "Try a different search." : "Cards you archive from the board land here. You can restore them any time."}
              />
            </div>
          ) : (
            <ul key="cards" className="rounded-lg border border-border bg-surface shadow-card overflow-hidden">
              {cards.map((c, i) => (
                <Row key={c.id} i={i} leaving={leaving.has(c.id)}>
                  <button data-card-id={c.id} className="flex-1 min-w-0 text-left group" onClick={() => onOpenCard(c.id)} title={c.title}>
                    <div className="font-medium text-ink truncate group-hover:text-accent transition-colors">{c.title}</div>
                    <div className="text-xs text-subtle truncate">
                      {c.list_title ? <>in {c.list_title}</> : null}
                      {c.list_archived && <span className="text-warn"> (list archived)</span>}
                      {" · "}archived {relativeTime(c.updated_at)}
                    </div>
                  </button>
                  {canRestore && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="shrink-0"
                      iconLeft={<RotateCcw size={14} />}
                      loading={restoreCard.isPending && restoreCard.variables === c.id}
                      onClick={() => restoreCard.mutate(c.id)}
                      title={c.list_archived ? "Its list is archived too — restore the list to see it on the board" : "Send back to the board"}
                    >
                      <span className="hidden sm:inline">Restore</span>
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-subtle hover:text-danger"
                      aria-label="Delete permanently"
                      title="Delete permanently"
                      onClick={() => confirm(`Delete "${c.title}" permanently? This can't be undone.`) && removeCard.mutate(c.id)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  )}
                </Row>
              ))}
            </ul>
          )
        ) : lists.length === 0 ? (
          <div key="empty-lists" className="view-enter">
            <EmptyState
              icon={<Columns3 size={22} />}
              title={needle ? "No matches." : "No archived lists."}
              description={needle ? "Try a different search." : "Lists you archive (with their cards) wait here until you restore them."}
            />
          </div>
        ) : (
          <ul key="lists" className="rounded-lg border border-border bg-surface shadow-card overflow-hidden">
            {lists.map((l, i) => (
              <Row key={l.id} i={i} leaving={leaving.has(l.id)}>
                <span className="h-8 w-1.5 rounded-full shrink-0" style={{ background: l.color ?? "rgb(var(--c-rule))" }} />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-ink truncate">{l.title}</div>
                  <div className="text-xs text-subtle">
                    {l.card_count} card{l.card_count === 1 ? "" : "s"} · archived {relativeTime(l.updated_at)}
                  </div>
                </div>
                {canRestoreList && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    iconLeft={<RotateCcw size={14} />}
                    loading={restoreL.isPending && restoreL.variables === l.id}
                    onClick={() => restoreL.mutate(l.id)}
                  >
                    <span className="hidden sm:inline">Restore</span>
                  </Button>
                )}
              </Row>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Row({ i, leaving, children }: { i: number; leaving: boolean; children: React.ReactNode }) {
  return (
    <li
      style={{ "--i": i } as React.CSSProperties}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out border-b border-line last:border-b-0",
        leaving ? "grid-rows-[0fr] opacity-0 border-b-0" : "rise grid-rows-[1fr]",
      )}
    >
      <div className="overflow-hidden">
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 hover:bg-inset transition-colors">{children}</div>
      </div>
    </li>
  );
}
