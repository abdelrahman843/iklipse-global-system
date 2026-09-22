import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Kanban, Users2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input, Label, FieldError, Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { listBoards, createBoard } from "@/lib/pm/boardApi";

export function BoardsHomePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const { data, isLoading, error } = useQuery({ queryKey: ["boards"], queryFn: listBoards });

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return data ?? [];
    return (data ?? []).filter((b) => b.title.toLowerCase().includes(s));
  }, [data, q]);

  const create = useMutation({
    mutationFn: createBoard,
    onSuccess: () => {
      toast.push({ kind: "success", title: "Board created" });
      qc.invalidateQueries({ queryKey: ["boards"] });
      setCreating(false);
    },
    onError: (e: Error) =>
      toast.push({ kind: "error", title: "Couldn't create board", description: e.message }),
  });

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load boards" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold text-ink">Boards</h1>
          <p className="text-sm text-muted">Your team's project boards.</p>
        </div>
        {can("pm.create_board") && (
          <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)}>
            New board
          </Button>
        )}
      </div>

      <div className="mb-4 max-w-sm">
        <div className="flex items-center gap-2 rounded-md border border-border bg-white px-2.5 h-9 text-sm">
          <Search size={14} className="text-subtle" />
          <input
            className="flex-1 bg-transparent outline-none"
            placeholder="Search boards…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Kanban size={28} />}
          title={q ? "No boards match your search." : "Create your first board."}
          description={q ? undefined : "Boards contain lists, cards, and everything your team needs to move work forward."}
          action={
            !q &&
            can("pm.create_board") && (
              <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)}>
                New board
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((b) => (
            <Link
              key={b.id}
              to={`/pm/boards/${b.id}`}
              className="group rounded-lg border border-border bg-white shadow-card p-4 hover:border-rule hover:shadow-pop hover:-translate-y-0.5 transition-[transform,box-shadow,border-color] duration-150 ease-out"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-ink truncate group-hover:text-accent">
                    {b.title}
                  </div>
                  <div className="text-xs text-subtle mt-0.5">
                    Updated {relativeTime(b.updated_at)}
                  </div>
                </div>
                <div className="flex items-center text-xs text-muted gap-1 shrink-0">
                  <Users2 size={14} />
                  {b.member_count}
                </div>
              </div>
              {b.description && (
                <p className="mt-2 text-sm text-muted line-clamp-2">{b.description}</p>
              )}
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <CreateBoardModal
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          busy={create.isPending}
        />
      )}
    </div>
  );
}

function CreateBoardModal({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (v: { title: string; description?: string }) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title="New board"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              if (!title.trim()) return setErr("Board title is required.");
              setErr(null);
              onSubmit({ title: title.trim(), description: description.trim() || undefined });
            }}
          >
            Create board
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <Label htmlFor="t">Title</Label>
          <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div>
          <Label htmlFor="d">Description (optional)</Label>
          <Textarea id="d" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <FieldError>{err}</FieldError>
      </div>
    </Modal>
  );
}
