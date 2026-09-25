import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Kanban, Users2, Lock, Globe2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input, Label, FieldError, Textarea } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { listBoards, createBoard, type BoardSummary } from "@/lib/pm/boardApi";
import { useBoardsListRealtime } from "@/lib/pm/useBoardRealtime";
import type { BoardVisibility } from "@/lib/database.types";
import { boardRoleLabel } from "@/lib/permissions";
import { Segmented } from "@/components/ui/Controls";
import { AiBoardGenerator } from "@/components/pm/AiBoardGenerator";
import { createBoardFromPlan, useAiStatus, type AiBoardPlan } from "@/lib/ai";

export function BoardsHomePage() {
  const { can, user, isGuest } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [creating, setCreatingState] = useState(false);
  // The header's Create button lands here with ?create=1.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("create") === "1" && can("pm.create_board")) setCreatingState(true);
  }, [params, can]);
  const setCreating = (v: boolean) => {
    setCreatingState(v);
    if (!v && params.has("create")) setParams({}, { replace: true });
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: () => listBoards(user!.id),
    enabled: !!user,
  });
  useBoardsListRealtime(user?.id);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return data ?? [];
    return (data ?? []).filter((b) => b.title.toLowerCase().includes(s));
  }, [data, q]);
  // Trello splits "Your boards" from workspace boards you can see but haven't joined.
  const mine = filtered.filter((b) => b.my_role);
  const others = filtered.filter((b) => !b.my_role);

  const navigate = useNavigate();
  const aiStatus = useAiStatus();

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

  const createFromPlan = useMutation({
    mutationFn: (v: { plan: AiBoardPlan; visibility: BoardVisibility }) => createBoardFromPlan(v.plan, v.visibility),
    onSuccess: (id) => {
      toast.push({ kind: "success", title: "Board created with AI" });
      qc.invalidateQueries({ queryKey: ["boards"] });
      setCreating(false);
      navigate(`/pm/boards/${id}`);
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
    <div className="p-3 sm:p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-start sm:items-center gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-subtle mb-1">Workspace</div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Boards</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">
            {isGuest ? "Boards you've been invited to." : "Your team's project boards."}
          </p>
        </div>
        {can("pm.create_board") && (
          <Button variant="primary" size="sm" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)} className="shrink-0">
            <span className="hidden sm:inline">New board</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <div className="mb-5 max-w-sm">
        <div className="flex items-center gap-2 rounded-md border border-rule bg-surface px-2.5 h-9 text-sm shadow-card focus-within:border-ink focus-within:shadow-pop transition-[border-color,box-shadow] duration-150">
          <Search size={14} className="text-subtle" />
          <input
            className="flex-1 bg-transparent outline-none text-ink placeholder:text-subtle"
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
        <div className="space-y-8">
          {mine.length > 0 && <BoardGrid title="Your boards" boards={mine} />}
          {others.length > 0 && (
            <BoardGrid
              title="Workspace boards"
              hint="Visible to everyone in the workspace. Open one to view or join."
              boards={others}
              offset={mine.length}
            />
          )}
        </div>
      )}

      {creating && (
        <CreateBoardModal
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          onSubmitPlan={(plan, visibility) => createFromPlan.mutate({ plan, visibility })}
          aiAvailable={!!aiStatus.data?.available}
          busy={create.isPending || createFromPlan.isPending}
        />
      )}
    </div>
  );
}

function BoardGrid({
  title,
  hint,
  boards,
  offset = 0,
}: {
  title: string;
  hint?: string;
  boards: BoardSummary[];
  offset?: number;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint && <p className="text-xs text-muted mt-0.5">{hint}</p>}
      </div>
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {boards.map((b, i) => (
          <Link
            key={b.id}
            to={`/pm/boards/${b.id}`}
            style={{ "--i": i + offset } as React.CSSProperties}
            className="rise group relative rounded-lg border border-border bg-surface shadow-card p-5 overflow-hidden hover:border-ink hover:shadow-raise hover:-translate-y-1 transition-[transform,box-shadow,border-color] duration-200 ease-out"
          >
            <span
              className="absolute inset-y-0 left-0 w-1 bg-accent scale-y-0 group-hover:scale-y-100 origin-top transition-transform duration-200 ease-out"
              aria-hidden
            />
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink text-base leading-tight truncate group-hover:text-accent transition-colors">
                  {b.title}
                </div>
                <div className="text-xs text-subtle mt-1.5 flex items-center gap-1.5">
                  {b.visibility === "private" ? <Lock size={11} /> : <Globe2 size={11} />}
                  {b.visibility === "private" ? "Private" : "Workspace"} · Updated {relativeTime(b.updated_at)}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <div className="flex items-center text-xs text-muted gap-1 bg-inset border border-line rounded-full px-2 py-0.5">
                  <Users2 size={12} />
                  {b.member_count}
                </div>
                {b.my_role && b.my_role !== "normal" && (
                  <span className="text-[11px] text-subtle">{boardRoleLabel(b.my_role)}</span>
                )}
              </div>
            </div>
            {b.description && <p className="mt-3 text-sm text-muted line-clamp-2 leading-snug">{b.description}</p>}
          </Link>
        ))}
      </div>
    </section>
  );
}

function CreateBoardModal({
  onClose,
  onSubmit,
  onSubmitPlan,
  aiAvailable,
  busy,
}: {
  onClose: () => void;
  onSubmit: (v: { title: string; description?: string; visibility: BoardVisibility }) => void;
  onSubmitPlan: (plan: AiBoardPlan, visibility: BoardVisibility) => void;
  aiAvailable: boolean;
  busy: boolean;
}) {
  const [mode, setMode] = useState<"blank" | "ai">("blank");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<BoardVisibility>("workspace");
  const [plan, setPlan] = useState<AiBoardPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ai = mode === "ai";
  return (
    <Modal
      open
      onClose={onClose}
      title="New board"
      size={ai && plan ? "xl" : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {(!ai || plan) && (
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                if (ai && plan) {
                  if (!plan.title.trim()) return setErr("Board title is required.");
                  setErr(null);
                  return onSubmitPlan({ ...plan, title: plan.title.trim() }, visibility);
                }
                if (!title.trim()) return setErr("Board title is required.");
                setErr(null);
                onSubmit({ title: title.trim(), description: description.trim() || undefined, visibility });
              }}
            >
              Create board
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {aiAvailable && (
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-inset border border-line p-1">
            {(["blank", "ai"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={
                  "h-8 rounded-md text-sm inline-flex items-center justify-center gap-1.5 transition " +
                  (mode === m
                    ? m === "ai"
                      ? "bg-gradient-to-r from-[#7c3aed] via-[#db2777] to-[#f06a2a] text-white font-medium shadow-card"
                      : "bg-surface text-ink font-medium shadow-card"
                    : "text-muted hover:text-ink")
                }
              >
                {m === "ai" ? (
                  <>
                    <Sparkles size={14} /> Generate with AI
                  </>
                ) : (
                  "Blank board"
                )}
              </button>
            ))}
          </div>
        )}
        {ai ? (
          <AiBoardGenerator plan={plan} onPlan={setPlan} />
        ) : (
          <>
            <div>
              <Label htmlFor="t">Title</Label>
              <Input id="t" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </div>
            <div>
              <Label htmlFor="d">Description (optional)</Label>
              <Textarea id="d" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </>
        )}
        {(!ai || plan) && (
        <div>
          <Label>Visibility</Label>
          <Segmented<BoardVisibility>
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: "workspace", label: "Workspace" },
              { value: "private", label: "Private" },
            ]}
          />
          <p className="text-xs text-muted mt-1.5">
            {visibility === "workspace"
              ? "Everyone in the workspace can see this board and join it."
              : "Only people you add to the board can see it."}
          </p>
        </div>
        )}
        <FieldError>{err}</FieldError>
      </div>
    </Modal>
  );
}
