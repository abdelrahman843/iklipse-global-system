import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, CircleCheck, Ellipsis, Link2, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { commentAuthor } from "@/lib/wb/api";
import { Button } from "@/components/ui/Button";
import { Menu, MenuItem } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { cn } from "@/lib/cn";
import { useAuth } from "@/lib/auth";
import { useWbPeople } from "@/lib/wb/people";
import { useWb } from "@/lib/wb/store";
import type { Pt } from "@/lib/wb/geometry";
import { PIN, replyDrafts, useCommentOps, useCommentsUi, when, type CommentRow, type Thread } from "./data";
import { CommentBody, MentionInput } from "./MentionInput";

// -----------------------------------------------------------------------------
// The card that opens next to a pin: a thread (messages, reply, resolve, copy
// link, edit / delete your own) or the composer for a new one. Screen space,
// kept inside the canvas and clear of the side panel; on phones it sits above
// or below the pin at nearly full width.
// -----------------------------------------------------------------------------

const set = useWb.setState;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

const iconBtn =
  "h-9 w-9 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors";

/** Positioned card beside a pin (anchor = the pin's spot on screen; null = centred). */
export function Floating({ anchor, width, label, children }: { anchor: Pt | null; width: number; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const screen = useWb((s) => s.screen);
  const panelOpen = useWb((s) => !!s.panel);
  const [h, setH] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const narrow = screen.w < 640;
  const w = Math.min(width, screen.w - 16);
  // The side panel covers the right edge on wider screens.
  const right = screen.w - 8 - (panelOpen && !narrow ? 352 : 0);
  let left: number;
  let top: number;
  if (!anchor) {
    left = clamp((right - w) / 2, 8, right - w);
    top = clamp((screen.h - h) / 2, 8, screen.h - h - 8);
  } else if (!narrow) {
    left = anchor.x + PIN + 8;
    if (left + w > right) left = anchor.x - w - 8;
    left = clamp(left, 8, right - w);
    top = clamp(anchor.y - PIN, 8, screen.h - h - 8);
  } else {
    left = clamp(anchor.x - w / 2, 8, screen.w - w - 8);
    top = anchor.y + 8;
    if (top + h > screen.h - 8) top = anchor.y - PIN - 8 - h;
    top = clamp(top, 8, screen.h - h - 8);
  }

  return (
    <div
      ref={ref}
      data-wb-ui
      data-wb-scroll
      role="dialog"
      aria-label={label}
      className="absolute z-[25] flex flex-col bg-surface border border-border rounded-lg shadow-raise pointer-events-auto cursor-auto animate-scale-in"
      style={{ left, top, width: w, maxHeight: Math.min(screen.h - 16, 560) }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

// ----------------------------------------------------------------- thread --
export function ThreadPopover({ boardId, thread, anchor }: { boardId: string; thread: Thread; anchor: Pt | null }) {
  const { user } = useAuth();
  const me = user?.id ?? null;
  const canComment = useWb((s) => s.canComment);
  const byId = useWbPeople().data?.byId;
  const ops = useCommentOps(boardId);
  const toast = useToast();
  const confirm = useConfirm();
  const root = thread.root;
  const [reply, setReply] = useState(() => replyDrafts.get(root.id) ?? "");
  const [editing, setEditing] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const messages = [root, ...thread.replies];

  // Newest message in view when the thread opens or grows.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const close = () => set({ openThread: null });

  const typeReply = (v: string) => {
    setReply(v);
    if (v.trim()) replyDrafts.set(root.id, v);
    else replyDrafts.delete(root.id);
  };

  const send = () => {
    const body = reply.trim();
    if (!body || !me) return;
    ops.add({ body, author_id: me, thread_id: root.id });
    typeReply("");
  };

  const toggleResolved = async () => {
    const next = !root.resolved;
    // Resolved pins leave the board unless they're being shown.
    if (next && !useCommentsUi.getState().showResolved) close();
    const ok = await ops.setResolved(root.id, next);
    if (ok && next) {
      toast.push({ kind: "success", title: "Comment resolved", actionLabel: "Undo", onAction: () => void ops.setResolved(root.id, false) });
    }
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}#/wb/${boardId}?comment=${root.id}`;
    void navigator.clipboard?.writeText(url).catch(() => undefined);
    toast.push({ kind: "success", title: "Link copied" });
  };

  const remove = async (c: CommentRow) => {
    const isRoot = c.id === root.id;
    const ok = await confirm({
      title: isRoot ? "Delete thread?" : "Delete reply?",
      message: isRoot ? "This comment and all its replies will be deleted for everyone." : "This reply will be deleted for everyone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (isRoot) close();
    void ops.remove(c.id);
  };

  const saveEdit = (c: CommentRow, text: string) => {
    const body = text.trim();
    setEditing(null);
    if (body && body !== c.body) void ops.edit(c.id, body);
  };

  return (
    <Floating anchor={anchor} width={340} label="Comment thread">
      <div className="flex items-center gap-0.5 h-12 pl-3 pr-1.5 border-b border-line shrink-0">
        <div className="flex-1 min-w-0 truncate text-sm font-semibold text-ink">
          {root.resolved ? (
            <span className="inline-flex items-center gap-1.5 text-success">
              <CircleCheck size={15} /> Resolved
            </span>
          ) : messages.length > 1 ? (
            `${messages.length} comments`
          ) : (
            "Comment"
          )}
        </div>
        {canComment && (
          <button type="button" className={iconBtn} onClick={toggleResolved} title={root.resolved ? "Reopen" : "Resolve"} aria-label={root.resolved ? "Reopen" : "Resolve"}>
            {root.resolved ? <RotateCcw size={16} /> : <CircleCheck size={17} />}
          </button>
        )}
        <button type="button" className={iconBtn} onClick={copyLink} title="Copy link" aria-label="Copy link">
          <Link2 size={17} />
        </button>
        <button type="button" className={iconBtn} onClick={close} title="Close" aria-label="Close">
          <X size={17} />
        </button>
      </div>

      {!anchor && <div className="px-3 pt-2.5 text-xs text-subtle shrink-0">The item this comment was on has been deleted.</div>}

      <div ref={listRef} data-wb-scroll className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 space-y-4">
        {messages.map((c) => {
          const author = commentAuthor(c, byId);
          const mine = !!me && c.author_id === me;
          return (
            <div key={c.id} className={cn("group flex gap-2.5", c.pending && "opacity-60")}>
              <Avatar name={author?.display_name ?? "Someone"} src={author?.avatar_url} size={28} className="shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-h-7">
                  <span className="min-w-0 truncate text-sm font-semibold text-ink">{author?.display_name ?? "Someone"}</span>
                  <span className="shrink-0 text-xs text-subtle" title={new Date(c.created_at).toLocaleString()}>
                    {when(c.created_at)}
                  </span>
                  {mine && canComment && !c.pending && editing !== c.id && (
                    <Menu
                      align="right"
                      className="ml-auto shrink-0"
                      trigger={
                        <button
                          type="button"
                          className="h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity"
                          title="More"
                          aria-label="Comment actions"
                        >
                          <Ellipsis size={15} />
                        </button>
                      }
                    >
                      {(closeMenu) => (
                        <div className="min-w-[170px]">
                          <MenuItem onClick={() => (setEditing(c.id), closeMenu())}>
                            <span className="inline-flex items-center gap-2">
                              <Pencil size={14} /> Edit
                            </span>
                          </MenuItem>
                          <MenuItem destructive onClick={() => (void remove(c), closeMenu())}>
                            <span className="inline-flex items-center gap-2">
                              <Trash2 size={14} /> {c.id === root.id ? "Delete thread" : "Delete"}
                            </span>
                          </MenuItem>
                        </div>
                      )}
                    </Menu>
                  )}
                </div>
                {editing === c.id ? (
                  <EditBox initial={c.body} onSave={(t) => saveEdit(c, t)} onCancel={() => setEditing(null)} />
                ) : (
                  <CommentBody text={c.body} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {canComment && (
        <div className="shrink-0 border-t border-line p-2 flex items-end gap-1.5">
          <MentionInput
            className="flex-1 min-w-0"
            label="Reply"
            value={reply}
            onChange={typeReply}
            onSubmit={send}
            onCancel={close}
            placeholder="Reply, @ to mention"
          />
          <button
            type="button"
            disabled={!reply.trim()}
            onClick={send}
            title="Send (Enter)"
            aria-label="Send reply"
            className="h-9 w-9 shrink-0 grid place-items-center rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <ArrowUp size={17} />
          </button>
        </div>
      )}
    </Floating>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="mt-1 space-y-1.5">
      <MentionInput focus label="Edit comment" value={text} onChange={setText} onSubmit={() => onSave(text)} onCancel={onCancel} />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="[@media(pointer:coarse)]:h-9" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" className="[@media(pointer:coarse)]:h-9" disabled={!text.trim()} onClick={() => onSave(text)}>
          Save
        </Button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- composer --
/** New thread at the draft spot. The text lives in the layer so a click elsewhere can keep it. */
export function Composer({
  anchor,
  text,
  onText,
  onPost,
}: {
  anchor: Pt | null;
  text: string;
  onText: (v: string) => void;
  onPost: () => void;
}) {
  const cancel = () => set({ draftComment: null });
  return (
    <Floating anchor={anchor} width={300} label="New comment">
      <div className="p-2.5 space-y-2">
        <MentionInput focus label="Comment" value={text} onChange={onText} onSubmit={onPost} onCancel={cancel} placeholder="Add a comment, @ to mention" />
        <div className="flex items-center gap-1.5">
          <span className="flex-1 min-w-0 truncate text-xs text-subtle max-sm:invisible">Enter to post</span>
          <Button size="sm" variant="ghost" className="[@media(pointer:coarse)]:h-9" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" className="[@media(pointer:coarse)]:h-9" disabled={!text.trim()} onClick={onPost}>
            Comment
          </Button>
        </div>
      </div>
    </Floating>
  );
}
