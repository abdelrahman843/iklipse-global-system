import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { shortDate } from "@/lib/format";
import { fetchArchivedCards, setCardArchived } from "@/lib/pm/boardApi";

interface Props {
  boardId: string;
  onOpenCard: (id: string) => void;
}

export function ArchiveView({ boardId, onOpenCard }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const { data, isLoading, error } = useQuery({
    queryKey: ["archived-cards", boardId],
    queryFn: () => fetchArchivedCards(boardId),
  });

  const restore = useMutation({
    mutationFn: (cardId: string) => setCardArchived(cardId, false),
    onSuccess: () => {
      toast.push({ kind: "success", title: "Card restored" });
      qc.invalidateQueries({ queryKey: ["archived-cards", boardId] });
      qc.invalidateQueries({ queryKey: ["board", boardId] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Restore failed", description: e.message }),
  });

  const canRestore = can("pm.archive_card");

  if (isLoading)
    return (
      <div className="p-6 flex justify-center">
        <Spinner size={20} />
      </div>
    );
  if (error)
    return (
      <div className="p-4 sm:p-6">
        <EmptyState title="Couldn't load archive" description={(error as Error).message} />
      </div>
    );

  const cards = data ?? [];

  return (
    <div className="p-2 sm:p-4 h-full overflow-auto">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-4 text-muted">
          <Archive size={16} />
          <h2 className="text-sm font-semibold text-ink">Archived cards</h2>
          <Badge tone="neutral">{cards.length}</Badge>
        </div>

        {cards.length === 0 ? (
          <EmptyState
            icon={<Archive size={28} />}
            title="Nothing archived."
            description="Cards you archive from a board land here. You can restore them any time."
          />
        ) : (
          <ul className="rounded-lg border border-border bg-surface shadow-card divide-y divide-line overflow-hidden">
            {cards.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 sm:px-4 py-2.5 hover:bg-inset transition-colors">
                <button
                  className="flex-1 min-w-0 text-left"
                  onClick={() => onOpenCard(c.id)}
                  title={c.title}
                >
                  <div className="font-medium text-ink truncate">{c.title}</div>
                  <div className="text-xs text-subtle truncate">
                    {c.list_title ? <>in {c.list_title} · </> : null}#{c.short_id} · archived {shortDate(c.updated_at)}
                  </div>
                </button>
                {canRestore && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    iconLeft={<RotateCcw size={14} />}
                    loading={restore.isPending && restore.variables === c.id}
                    onClick={() => restore.mutate(c.id)}
                  >
                    <span className="hidden sm:inline">Restore</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
