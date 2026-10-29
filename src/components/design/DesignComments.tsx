import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageCircle, Trash2, X, RotateCcw } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { resolved, select, useDesign, zoomTo } from "@/lib/design/store";
import { addDesignComment, deleteDesignComment, fetchDesignComments, updateDesignComment, type DesignComment } from "@/lib/design/sync";

// -----------------------------------------------------------------------------
// Design comments: threads pinned to a layer (they move with it) or a point
// on a page. Same rules as whiteboard comments: commenters and up write,
// authors edit their own, board admins delete any.
// -----------------------------------------------------------------------------

export const designCommentsKey = (boardId: string) => ["design-comments", boardId] as const;

export function useDesignComments(boardId: string) {
  return useQuery({ queryKey: designCommentsKey(boardId), queryFn: () => fetchDesignComments(boardId), staleTime: 60_000 });
}

interface Thread {
  root: DesignComment;
  replies: DesignComment[];
}

function threads(rows: DesignComment[] | undefined): Thread[] {
  const map = new Map<string, Thread>();
  for (const c of rows ?? []) if (!c.thread_id) map.set(c.id, { root: c, replies: [] });
  for (const c of rows ?? []) if (c.thread_id) map.get(c.thread_id)?.replies.push(c);
  return [...map.values()];
}

/** Where a thread sits on the page now (pinned layers move their pins). */
function pinPos(t: DesignComment): { x: number; y: number } | null {
  if (t.x === null || t.y === null) return null;
  if (t.node_id) {
    const r = resolved().byId.get(t.node_id);
    if (r) return { x: r.ax + t.x, y: r.ay + t.y };
  }
  return { x: t.x, y: t.y };
}

export function CommentPins({ boardId, draft, setDraft, open, setOpen }: { boardId: string; draft: { x: number; y: number; node: string | null } | null; setDraft: (d: null) => void; open: string | null; setOpen: (id: string | null) => void }) {
  const q = useDesignComments(boardId);
  const page = useDesign((s) => s.page);
  const v = useDesign((s) => s.viewport);
  useDesign((s) => s.doc);
  const list = threads(q.data).filter((t) => t.root.page === page && !t.root.resolved);
  return (
    <div className="absolute inset-0 pointer-events-none">
      {list.map((t, i) => {
        const p = pinPos(t.root);
        if (!p) return null;
        const sx = p.x * v.zoom + v.x;
        const sy = p.y * v.zoom + v.y;
        return (
          <div key={t.root.id} data-design-ui className="absolute pointer-events-auto" style={{ left: sx, top: sy - 32 }} onPointerDown={(e) => e.stopPropagation()}>
            <button
              className={cn("h-8 min-w-8 px-1.5 rounded-full rounded-bl-none bg-surface border-2 shadow-pop text-xs font-semibold text-ink grid place-items-center", open === t.root.id ? "border-accent" : "border-white")}
              onClick={() => setOpen(open === t.root.id ? null : t.root.id)}
              title={t.root.body.slice(0, 80)}
            >
              {i + 1}
            </button>
            {open === t.root.id && <ThreadCard boardId={boardId} thread={t} onClose={() => setOpen(null)} />}
          </div>
        );
      })}
      {draft && (
        <div
          data-design-ui
          className="absolute pointer-events-auto"
          style={{ left: draft.x * v.zoom + v.x, top: draft.y * v.zoom + v.y - 32 }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="h-8 w-8 rounded-full rounded-bl-none bg-accent text-white grid place-items-center">
            <MessageCircle size={14} />
          </span>
          <Composer
            boardId={boardId}
            autoFocus
            placeholder="Add a comment"
            onCancel={() => setDraft(null)}
            onSend={async (body, uid) => {
              const r = draft.node ? resolved().byId.get(draft.node) : null;
              await addDesignComment({
                board_id: boardId,
                body,
                author_id: uid,
                page: useDesign.getState().page,
                node_id: r ? draft.node : null,
                x: r ? draft.x - r.ax : draft.x,
                y: r ? draft.y - r.ay : draft.y,
              });
              setDraft(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function ThreadCard({ boardId, thread, onClose }: { boardId: string; thread: Thread; onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const canComment = useDesign((s) => s.canComment);
  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
      qc.invalidateQueries({ queryKey: designCommentsKey(boardId) });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't update the comment", description: (e as Error).message });
    }
  };
  return (
    <div className="absolute left-10 top-0 w-72 bg-surface border border-border rounded-lg shadow-raise text-xs">
      <div className="flex items-center justify-end gap-1 px-2 h-8 border-b border-border">
        {canComment && (
          <button className="h-6 w-6 grid place-items-center rounded hover:bg-hover text-muted" title={thread.root.resolved ? "Reopen" : "Resolve"} onClick={() => act(() => updateDesignComment(thread.root.id, { resolved: !thread.root.resolved }))}>
            {thread.root.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
          </button>
        )}
        <button className="h-6 w-6 grid place-items-center rounded hover:bg-hover text-muted" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="max-h-72 overflow-auto p-2 space-y-2">
        {[thread.root, ...thread.replies].map((c) => (
          <div key={c.id} className="group flex gap-2">
            <Avatar name={c.author?.display_name ?? "?"} src={c.author?.avatar_url ?? null} size={22} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="font-semibold text-ink truncate">{c.author?.display_name ?? "Someone"}</span>
                <span className="text-subtle">{relativeTime(c.created_at)}</span>
                {c.author_id === user?.id && (
                  <button className="ml-auto hidden group-hover:block text-subtle hover:text-danger" title="Delete" onClick={() => act(() => deleteDesignComment(c.id))}>
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <p className="text-ink whitespace-pre-wrap break-words">{c.body}</p>
            </div>
          </div>
        ))}
      </div>
      {canComment && (
        <div className="border-t border-border p-2">
          <Composer
            boardId={boardId}
            inline
            placeholder="Reply"
            onSend={async (body, uid) => {
              await addDesignComment({ board_id: boardId, body, author_id: uid, thread_id: thread.root.id });
            }}
          />
        </div>
      )}
    </div>
  );
}

function Composer({ boardId, onSend, onCancel, placeholder, autoFocus, inline }: { boardId: string; onSend: (body: string, uid: string) => Promise<void>; onCancel?: () => void; placeholder: string; autoFocus?: boolean; inline?: boolean }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const b = body.trim();
    if (!b || !user || busy) return;
    setBusy(true);
    try {
      await onSend(b.slice(0, 10000), user.id);
      setBody("");
      qc.invalidateQueries({ queryKey: designCommentsKey(boardId) });
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't post the comment", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn(!inline && "absolute left-10 top-0 w-72 bg-surface border border-border rounded-lg shadow-raise p-2")}>
      <textarea
        autoFocus={autoFocus}
        value={body}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-none rounded border border-border bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") onCancel?.();
        }}
      />
      <div className="flex justify-end gap-1 pt-1">
        {onCancel && (
          <button className="h-7 px-2 rounded text-xs text-muted hover:bg-hover" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="h-7 px-2.5 rounded bg-accent text-white text-xs disabled:opacity-50" disabled={!body.trim() || busy} onClick={send}>
          Post
        </button>
      </div>
    </div>
  );
}

/** Panel listing every thread (all pages), resolved ones on request. */
export function CommentsPanel({ boardId, onOpen }: { boardId: string; onOpen: (id: string) => void }) {
  const q = useDesignComments(boardId);
  const [showResolved, setShowResolved] = useState(false);
  const pages = useDesign((s) => s.doc.data.pages);
  const list = useMemo(() => threads(q.data).filter((t) => showResolved || !t.root.resolved).reverse(), [q.data, showResolved]);
  return (
    <div className="flex-1 overflow-auto">
      <label className="flex items-center gap-2 px-3 py-2 text-xs text-ink border-b border-border">
        <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
      </label>
      {q.isLoading && <p className="p-3 text-xs text-subtle">Loading…</p>}
      {!q.isLoading && !list.length && <p className="p-3 text-xs text-subtle">No comments yet. Press C and click the canvas to add one.</p>}
      {list.map((t) => (
        <button
          key={t.root.id}
          className="w-full text-left px-3 py-2 border-b border-border hover:bg-hover"
          onClick={() => {
            if (t.root.page && t.root.page !== useDesign.getState().page) useDesign.setState({ page: t.root.page });
            setTimeout(() => {
              const p = pinPos(t.root);
              if (p) zoomTo({ x: p.x - 200, y: p.y - 150, w: 400, h: 300 }, 40, 1.5);
              if (t.root.node_id && resolved().byId.has(t.root.node_id)) select([t.root.node_id]);
              onOpen(t.root.id);
            }, 0);
          }}
        >
          <div className="flex items-center gap-1.5 text-[11px] text-subtle">
            <span className="font-semibold text-ink">{t.root.author?.display_name ?? "Someone"}</span>
            <span>{relativeTime(t.root.created_at)}</span>
            <span className="ml-auto">{pages.find((p) => p.id === t.root.page)?.name}</span>
          </div>
          <p className={cn("text-xs text-ink line-clamp-2", t.root.resolved && "line-through text-subtle")}>{t.root.body}</p>
          {t.replies.length > 0 && <span className="text-[11px] text-accent">{t.replies.length} repl{t.replies.length === 1 ? "y" : "ies"}</span>}
        </button>
      ))}
    </div>
  );
}
