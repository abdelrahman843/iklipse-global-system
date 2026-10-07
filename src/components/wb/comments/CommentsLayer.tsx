import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, MessageCircle, MessageCirclePlus, RotateCcw, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Segmented, Toggle } from "@/components/ui/Controls";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useWbPeople, type WbPerson } from "@/lib/wb/people";
import { useWb, setTool, worldToScreen } from "@/lib/wb/store";
import type { Pt } from "@/lib/wb/geometry";
import {
  PIN,
  TYPE_NAMES,
  anchorOf,
  goToThread,
  itemText,
  pendingIds,
  useComments,
  useCommentOps,
  useCommentsUi,
  useThreads,
  when,
  type CommentFilter,
  type Thread,
} from "./data";
import { Composer, ThreadPopover } from "./ThreadPopover";

// -----------------------------------------------------------------------------
// Miro-style comments: a pin per thread on the canvas (screen space, constant
// size, follows its item), the open thread / new-comment card beside it, the
// right-side list, and the unresolved count for the top bar. Mentions and
// reply notifications are sent by the database trigger.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const set = useWb.setState;

/** Pins, the open thread and the composer (inside the canvas root). */
export function CommentsLayer({ boardId, focusThread }: { boardId: string; focusThread?: string | null }) {
  const { user, profile } = useAuth();
  const toast = useToast();
  const { rows, threads, ready } = useThreads(boardId);
  const ops = useCommentOps(boardId);
  const byId = useWbPeople().data?.byId;
  const vp = useWb((s) => s.viewport);
  const screen = useWb((s) => s.screen);
  const loaded = useWb((s) => s.loaded);
  const openThread = useWb((s) => s.openThread);
  const draft = useWb((s) => s.draftComment);
  const canComment = useWb((s) => s.canComment);
  const presenting = useWb((s) => s.presenting);
  // Re-render while items move so pins on them follow.
  useWb((s) => s.items);
  useWb((s) => s.live);
  useWb((s) => s.remoteLive);
  const showResolved = useCommentsUi((s) => s.showResolved);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftText, setDraftText] = useState("");
  const draftTextRef = useRef(draftText);
  draftTextRef.current = draftText;

  // A press on the board closes the thread; the composer only while it's empty.
  useEffect(() => {
    const host = rootRef.current?.parentElement;
    if (!host) return;
    const down = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.("[data-wb-ui]")) return;
      const s = S();
      if (s.openThread) set({ openThread: null });
      if (s.draftComment && !draftTextRef.current.trim()) set({ draftComment: null });
    };
    host.addEventListener("pointerdown", down);
    return () => host.removeEventListener("pointerdown", down);
  }, []);

  useEffect(() => {
    if (!draft) setDraftText("");
  }, [draft]);

  // The open thread was deleted (here or by someone else).
  useEffect(() => {
    if (ready && openThread && !threads.has(openThread) && !pendingIds.has(openThread)) set({ openThread: null });
  }, [ready, openThread, threads]);

  // Deep link (?comment=): open the thread and fly to it once everything is loaded.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focusThread) {
      focused.current = null;
      return;
    }
    if (focused.current === focusThread || !rows || !loaded) return;
    focused.current = focusThread;
    const hit = rows.find((c) => c.id === focusThread);
    const root = hit ? (hit.thread_id ? threads.get(hit.thread_id)?.root : hit) : null;
    if (!root) {
      toast.push({ kind: "info", title: "Comment not found", description: "It may have been deleted." });
      return;
    }
    set({ openThread: root.id, draftComment: null });
    // After the page's first placement of the view.
    requestAnimationFrame(() => goToThread(root));
  }, [focusThread, rows, loaded, threads, toast]);

  if (presenting) return <div ref={rootRef} className="hidden" />;

  const s = S();
  const toScreen = (p: Pt | null) => (p ? worldToScreen(p, vp) : null);
  const onScreen = (p: Pt) => p.x > -PIN && p.y > -8 && p.x < screen.w + 8 && p.y < screen.h + PIN;

  const pins: { t: Thread; at: Pt; open: boolean }[] = [];
  for (const t of threads.values()) {
    const open = t.root.id === openThread;
    if (t.root.resolved && !showResolved && !open) continue;
    const at = toScreen(anchorOf(s, t.root));
    if (!at || (!open && !onScreen(at))) continue;
    pins.push({ t, at, open });
  }
  // The open one on top.
  pins.sort((a, b) => Number(a.open) - Number(b.open));

  const current = openThread ? threads.get(openThread) ?? null : null;
  const currentAt = current ? toScreen(anchorOf(s, current.root)) : null;
  const draftAt = draft && canComment ? toScreen(anchorOf(s, draft)) : null;

  const post = () => {
    const body = draftText.trim();
    if (!body || !draft || !user) return;
    const id = ops.add({ body, author_id: user.id, item_id: draft.item_id, x: draft.x, y: draft.y });
    setDraftText("");
    set({ draftComment: null, openThread: id });
  };

  return (
    <div ref={rootRef} className="absolute inset-0 pointer-events-none overflow-hidden">
      {pins.map(({ t, at, open }) => (
        <Pin
          key={t.root.id}
          t={t}
          at={at}
          open={open}
          author={byId?.get(t.root.author_id)}
          onClick={() => set({ openThread: open ? null : t.root.id, draftComment: null })}
        />
      ))}

      {draftAt && (
        <div
          className="absolute left-0 top-0 z-10 animate-scale-in origin-bottom-left"
          style={{ transform: `translate(${draftAt.x}px, ${draftAt.y - PIN}px)` }}
        >
          <span className="grid place-items-center h-9 w-9 rounded-full rounded-bl-none bg-surface border-2 border-accent shadow-pop">
            <Avatar name={profile?.display_name ?? "You"} src={profile?.avatar_url} size={26} />
          </span>
        </div>
      )}

      {current && !draft && <ThreadPopover key={current.root.id} boardId={boardId} thread={current} anchor={currentAt} />}
      {draft && canComment && (
        <Composer key={`${draft.item_id ?? ""}:${draft.x}:${draft.y}`} anchor={draftAt} text={draftText} onText={setDraftText} onPost={post} />
      )}
    </div>
  );
}

function Pin({ t, at, open, author, onClick }: { t: Thread; at: Pt; open: boolean; author?: WbPerson; onClick: () => void }) {
  const n = t.replies.length;
  const name = author?.display_name ?? "Someone";
  const excerpt = t.root.body.replace(/\s+/g, " ").slice(0, 80);
  return (
    <button
      type="button"
      data-wb-ui
      className="absolute left-0 top-0 z-10 pointer-events-auto rounded-full rounded-bl-none outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      style={{ transform: `translate(${at.x}px, ${at.y - PIN}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onClick={onClick}
      title={`${name}: ${excerpt}`}
      aria-label={`Comment by ${name}${n ? `, ${n} ${n === 1 ? "reply" : "replies"}` : ""}`}
      aria-expanded={open}
    >
      <span
        className={cn(
          "grid place-items-center h-9 w-9 rounded-full rounded-bl-none bg-surface border-2 shadow-pop origin-bottom-left transition-transform duration-150 hover:scale-110",
          open ? "border-accent scale-110" : "border-surface",
          t.root.resolved && !open && "opacity-70",
          t.root.pending && "opacity-60",
        )}
      >
        {t.root.resolved ? <CircleCheck size={20} className="text-success" /> : <Avatar name={name} src={author?.avatar_url} size={26} />}
      </span>
      {n > 0 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-white text-[10px] font-semibold leading-none grid place-items-center ring-2 ring-surface">
          {n > 99 ? "99+" : n}
        </span>
      )}
    </button>
  );
}

// ------------------------------------------------------------------ panel --
/** Right-side list of threads. */
export function CommentsPanel({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const { threads, isLoading } = useThreads(boardId);
  const ops = useCommentOps(boardId);
  const byId = useWbPeople().data?.byId;
  const filter = useCommentsUi((s) => s.filter);
  const showResolved = useCommentsUi((s) => s.showResolved);
  const openThread = useWb((s) => s.openThread);
  const canComment = useWb((s) => s.canComment);
  const items = useWb((s) => s.items);
  const loaded = useWb((s) => s.loaded);

  const all = useMemo(() => [...threads.values()].sort((a, b) => b.last - a.last), [threads]);
  const openCount = all.filter((t) => !t.root.resolved).length;
  const list = all.filter((t) => filter === "all" || (filter === "open" ? !t.root.resolved : t.root.resolved));
  const phone = () => window.innerWidth < 640;

  const open = (t: Thread) => {
    set({ openThread: t.root.id, draftComment: null });
    goToThread(t.root);
    // On phones the panel covers the board.
    if (phone()) set({ panel: null });
  };

  return (
    <>
      <div className="flex items-center gap-2 h-12 pl-4 pr-1.5 border-b border-line shrink-0">
        <h2 className="flex-1 min-w-0 truncate text-base font-semibold text-ink">Comments</h2>
        <button type="button" onClick={onClose} className="h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink" title="Close" aria-label="Close">
          <X size={17} />
        </button>
      </div>
      <div className="px-3 pt-3 pb-3 space-y-3 border-b border-line shrink-0">
        <Segmented<CommentFilter>
          value={filter}
          onChange={(f) => useCommentsUi.setState({ filter: f })}
          options={[
            { value: "open", label: openCount ? `Open ${openCount}` : "Open" },
            { value: "resolved", label: "Resolved" },
            { value: "all", label: "All" },
          ]}
        />
        <Toggle checked={showResolved} onChange={(v) => useCommentsUi.setState({ showResolved: v })} label="Show resolved on board" />
      </div>

      <div data-wb-scroll className="flex-1 overflow-auto overscroll-contain">
        {isLoading ? (
          <div className="py-12 grid place-items-center text-subtle">
            <Spinner size={20} />
          </div>
        ) : list.length ? (
          list.map((t) => {
            const author = byId?.get(t.root.author_id);
            const it = t.root.item_id ? items[t.root.item_id] : null;
            const orphan = loaded && !!t.root.item_id && !it;
            const label = it ? itemText(it) : "";
            const n = t.replies.length;
            return (
              <div key={t.root.id} className={cn("relative border-b border-line", t.root.id === openThread && "bg-accent-soft/50")}>
                <button type="button" onClick={() => open(t)} className="w-full flex gap-2.5 px-3 py-3 text-left hover:bg-inset transition-colors">
                  <Avatar name={author?.display_name ?? "Someone"} src={author?.avatar_url} size={28} className="shrink-0" />
                  <div className={cn("flex-1 min-w-0", canComment && "pr-8")}>
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-ink">{author?.display_name ?? "Someone"}</span>
                      <span className="shrink-0 text-xs text-subtle">{when(t.lastAt)}</span>
                    </div>
                    {it && (
                      <div className="text-xs text-subtle truncate">
                        On {TYPE_NAMES[it.type].toLowerCase()}
                        {label ? `: ${label}` : ""}
                      </div>
                    )}
                    <p className="mt-0.5 text-sm text-muted line-clamp-2 [overflow-wrap:anywhere]">{t.root.body}</p>
                    {(n > 0 || t.root.resolved || orphan) && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle">
                        {n > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <MessageCircle size={12} /> {n} {n === 1 ? "reply" : "replies"}
                          </span>
                        )}
                        {t.root.resolved && (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CircleCheck size={12} /> Resolved
                          </span>
                        )}
                        {orphan && <span>Item deleted</span>}
                      </div>
                    )}
                  </div>
                </button>
                {canComment && (
                  <button
                    type="button"
                    onClick={() => void ops.setResolved(t.root.id, !t.root.resolved)}
                    className="absolute top-2 right-2 h-9 w-9 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink"
                    title={t.root.resolved ? "Reopen" : "Resolve"}
                    aria-label={t.root.resolved ? "Reopen" : "Resolve"}
                  >
                    {t.root.resolved ? <RotateCcw size={15} /> : <CircleCheck size={16} />}
                  </button>
                )}
              </div>
            );
          })
        ) : (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid place-items-center h-11 w-11 rounded-full bg-inset border border-line text-muted">
              <MessageCircle size={18} />
            </div>
            <div className="text-sm font-semibold text-ink">
              {filter === "resolved" ? "No resolved comments" : filter === "open" && all.length ? "All caught up" : "No comments yet"}
            </div>
            {canComment && filter !== "resolved" && (
              <p className="mt-1 text-sm text-muted">Pick the comment tool, then click anywhere on the board.</p>
            )}
          </div>
        )}
      </div>

      {canComment && (
        <div className="shrink-0 border-t border-line p-3">
          <Button
            className="w-full"
            iconLeft={<MessageCirclePlus size={15} />}
            onClick={() => {
              setTool("comment");
              if (phone()) set({ panel: null });
            }}
          >
            Add comment
          </Button>
        </div>
      )}
    </>
  );
}

/** Unresolved thread count (top bar badge). */
export function useOpenCommentCount(boardId: string): number {
  const { data } = useComments(boardId);
  return useMemo(() => (data ?? []).filter((c) => !c.thread_id && !c.resolved).length, [data]);
}
