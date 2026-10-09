import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Shapes, Users2, Lock, Globe2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input, Label, FieldError } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageSpinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { listBoards, createBoard, type BoardSummary } from "@/lib/pm/boardApi";
import { useBoardsListRealtime } from "@/lib/pm/useBoardRealtime";
import type { TeamAccess } from "@/lib/database.types";
import { TEAM_ACCESS, wbRoleLabel } from "@/lib/permissions";
import { Select } from "@/components/ui/Select";
import { supabase } from "@/lib/supabase";

const teamVerb = (t: TeamAccess | undefined) =>
  t === "edit" ? "can edit" : t === "comment" ? "can comment" : "can view";
import { Badge } from "@/components/ui/Badge";
import type { WbPreview } from "@/lib/wb/api";
import { cssColor } from "@/lib/wb/types";

export function WhiteboardsHomePage() {
  const { can, user, miroRole } = useAuth();
  const isGuest = miroRole === "guest";
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [creating, setCreatingState] = useState(false);
  // The header's Create button lands here with ?create=1 on whiteboard routes.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("create") === "1" && can("pm.create_board", "whiteboard")) setCreatingState(true);
  }, [params, can]);
  const setCreating = (v: boolean) => {
    setCreatingState(v);
    if (!v && params.has("create")) setParams({}, { replace: true });
  };

  // Same cache as the boards page; whiteboards are boards with kind 'whiteboard'.
  const { data, isLoading, error } = useQuery({
    queryKey: ["boards", user?.id],
    queryFn: () => listBoards(user!.id),
    enabled: !!user,
  });
  useBoardsListRealtime(user?.id);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const boards = (data ?? []).filter((b) => b.kind === "whiteboard");
    if (!s) return boards;
    return boards.filter((b) => b.title.toLowerCase().includes(s));
  }, [data, q]);
  const mine = filtered.filter((b) => b.my_role);
  const others = filtered.filter((b) => !b.my_role);

  const create = useMutation({
    mutationFn: async (v: { title: string; teamAccess: TeamAccess }) => {
      const id = await createBoard({ title: v.title, visibility: v.teamAccess === "none" ? "private" : "workspace", kind: "whiteboard" });
      // New boards start at "can edit" for the workspace (Miro's default); other levels are set right after.
      if (v.teamAccess === "view" || v.teamAccess === "comment") {
        const { error } = await supabase.from("board").update({ wb_team_access: v.teamAccess }).eq("id", id);
        if (error) throw error;
      }
      return id;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["boards"] });
      // Straight onto the canvas; ?new=1 opens the templates there.
      nav(`/wb/${id}?new=1`, { replace: params.has("create") });
    },
    onError: (e: Error) =>
      toast.push({ kind: "error", title: "Couldn't create board", description: e.message }),
  });

  if (isLoading) return <PageSpinner />;
  if (error)
    return (
      <div className="p-6">
        <EmptyState title="Couldn't load Miro boards" description={(error as Error).message} />
      </div>
    );

  return (
    <div className="p-3 sm:p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex items-start sm:items-center gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <div className="eyebrow text-subtle mb-1">Workspace</div>
          <h1 className="text-2xl sm:text-3xl font-semibold text-ink tracking-tight">Miro</h1>
          <p className="text-sm text-muted mt-1 hidden sm:block">
            {isGuest ? "Boards you've been invited to." : "Your team's shared canvases."}
          </p>
        </div>
        {can("pm.create_board", "whiteboard") && (
          <Button variant="primary" size="sm" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)} className="shrink-0 max-sm:h-10">
            <span className="hidden sm:inline">New board</span>
            <span className="sm:hidden">New</span>
          </Button>
        )}
      </div>

      <div className="mb-5 max-w-sm">
        <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 h-10 sm:h-9 text-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
          <Search size={14} className="text-subtle shrink-0" />
          {/* 16px on phones so iOS doesn't zoom in on focus. */}
          <input
            className="flex-1 min-w-0 bg-transparent outline-none text-ink placeholder:text-subtle text-lg sm:text-sm"
            placeholder="Search boards…"
            aria-label="Search boards"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Shapes size={28} />}
          title={q ? "No boards match your search." : "Create your first board."}
          description={q ? undefined : "An endless canvas to sketch, plan and brainstorm together."}
          action={
            !q &&
            can("pm.create_board", "whiteboard") && (
              <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setCreating(true)}>
                New board
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-8">
          {mine.length > 0 && <WhiteboardGrid title="Your boards" boards={mine} />}
          {others.length > 0 && (
            <WhiteboardGrid
              title="Workspace boards"
              hint="Visible to everyone in the workspace. Open one to view or join."
              boards={others}
              offset={mine.length}
            />
          )}
        </div>
      )}

      {creating && (
        <CreateWhiteboardModal
          onClose={() => setCreating(false)}
          onSubmit={(input) => create.mutate(input)}
          busy={create.isPending}
        />
      )}
    </div>
  );
}

function WhiteboardGrid({
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
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {boards.map((b, i) => {
          const preview = asPreview(b.preview);
          return (
            <Link
              key={b.id}
              to={`/wb/${b.id}`}
              style={{ "--i": i + offset } as React.CSSProperties}
              className="rise group relative rounded-lg border border-border bg-surface shadow-card overflow-hidden hover:border-rule hover:shadow-raise hover:-translate-y-1 transition-[transform,box-shadow,border-color] duration-200 ease-out"
            >
              {/* Thumbnail on the canvas' own dot grid. */}
              <div className="relative aspect-[16/9] bg-bg wb-grid border-b border-line" style={{ backgroundSize: "12px 12px" }}>
                {preview ? (
                  <div className="absolute inset-3">
                    <PreviewSketch p={preview} />
                  </div>
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-subtle/50">
                    <Shapes size={28} />
                  </div>
                )}
              </div>
              <span
                className="absolute inset-y-0 left-0 w-1 bg-accent scale-y-0 group-hover:scale-y-100 origin-top transition-transform duration-200 ease-out"
                aria-hidden
              />
              <div className="flex items-start justify-between gap-2 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-ink text-base leading-tight truncate group-hover:text-accent transition-colors">
                    {b.title}
                  </div>
                  <div className="text-xs text-subtle mt-1.5 flex items-center gap-1.5 min-w-0">
                    {b.visibility === "private" ? <Lock size={11} className="shrink-0" /> : <Globe2 size={11} className="shrink-0" />}
                    <span className="truncate">
                      {b.visibility === "private" ? "Private" : `Workspace ${teamVerb(b.wb_team_access)}`} · Updated {relativeTime(b.updated_at)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Badge>
                    <Users2 size={12} />
                    {b.member_count}
                  </Badge>
                  {b.my_wb_role && b.my_wb_role !== "editor" && (
                    <span className="text-[11px] text-subtle">{wbRoleLabel(b.my_wb_role)}</span>
                  )}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** The board row's preview, if it is a usable sketch. */
function asPreview(v: unknown): WbPreview | null {
  const p = v as WbPreview | null | undefined;
  if (!p || typeof p !== "object" || !(p.w > 0) || !(p.h > 0) || !Array.isArray(p.r) || !p.r.length) return null;
  return p;
}

// Frames outlined with their fill, boxes filled, lines and text as thin bars.
function PreviewSketch({ p }: { p: WbPreview }) {
  return (
    <svg viewBox={`0 0 ${p.w} ${p.h}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" aria-hidden>
      {p.r.map(([x, y, w, h, c, k], i) => {
        if (k === 1)
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={h}
              rx={1.5}
              style={{ fill: cssColor(c, "rgb(var(--c-surface))"), stroke: "rgb(var(--c-rule))", strokeWidth: 0.75 }}
            />
          );
        if (k === 2) {
          const t = 1.2;
          return w >= h ? (
            <rect key={i} x={x} y={y + h / 2 - t / 2} width={w} height={t} rx={t / 2} style={{ fill: cssColor(c, "rgb(var(--c-ink))") }} />
          ) : (
            <rect key={i} x={x + w / 2 - t / 2} y={y} width={t} height={h} rx={t / 2} style={{ fill: cssColor(c, "rgb(var(--c-ink))") }} />
          );
        }
        if (k === 3) {
          const bh = Math.max(1.2, Math.min(4, h * 0.45));
          return (
            <rect
              key={i}
              x={x}
              y={y + (h - bh) / 2}
              width={Math.max(2, w * 0.8)}
              height={bh}
              rx={bh / 2}
              style={{ fill: cssColor(c, "rgb(var(--c-ink))"), opacity: 0.65 }}
            />
          );
        }
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={w}
            height={h}
            rx={1.5}
            style={{ fill: cssColor(c, "rgb(var(--c-surface))"), stroke: "rgb(var(--c-ink) / 0.08)", strokeWidth: 0.5 }}
          />
        );
      })}
    </svg>
  );
}

function CreateWhiteboardModal({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (v: { title: string; teamAccess: TeamAccess }) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const [teamAccess, setTeamAccess] = useState<TeamAccess>("edit");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    if (!title.trim()) return setErr("Board title is required.");
    setErr(null);
    onSubmit({ title: title.trim(), teamAccess });
  };
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
          <Button variant="primary" loading={busy} onClick={submit}>
            Create board
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <div>
          <Label htmlFor="wb-title">Title</Label>
          <Input id="wb-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div>
          <Label>Anyone in the workspace</Label>
          <Select
            value={teamAccess}
            onChange={(v) => setTeamAccess(v as TeamAccess)}
            options={TEAM_ACCESS.map((t) => ({ value: t.value, label: t.label }))}
            aria-label="Workspace access"
            className="w-full"
          />
          <p className="text-xs text-muted mt-1.5">
            {TEAM_ACCESS.find((t) => t.value === teamAccess)?.summary}. You'll be the owner and can invite people with their own role.
          </p>
        </div>
        <FieldError>{err}</FieldError>
      </form>
    </Modal>
  );
}
