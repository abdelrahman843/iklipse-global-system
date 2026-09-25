import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Reply as ReplyIcon, SmilePlus } from "lucide-react";
import type { Activity as ActivityT, List as ListT, Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Spinner } from "@/components/ui/Spinner";
import { useAuth } from "@/lib/auth";
import { useBoardCan, useCurrentBoardAccess } from "@/lib/pm/boardAccess";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { keepFocus } from "@/lib/autosave";
import { useDraft } from "@/lib/drafts";
import { DraftNotice, DraftTag } from "@/components/ui/DraftNotice";
import {
  addComment,
  deleteComment,
  setReaction,
  updateComment,
  type CardDetailBundle,
  type CommentReaction,
} from "@/lib/pm/boardApi";
import { RichEditor, type MentionMember } from "@/components/pm/RichEditor";
import { Markdown } from "@/components/pm/Markdown";
import { EmojiPicker } from "@/components/pm/EmojiPicker";
import { cn } from "@/lib/cn";
import { readableText } from "@/components/pm/ColorPicker";

// -----------------------------------------------------------------------------
// Trello-style "Comments and activity": one newest-first timeline mixing root
// comments with activity entries. "Hide details" collapses it to comments (plus
// the card-created line, like Trello). Comments support emoji reactions, edit,
// delete, and Slack-style threads (replies live in the thread panel only).
// -----------------------------------------------------------------------------

export type CommentWithAuthor = CardDetailBundle["comments"][number];
export type ActivityWithActor = ActivityT & {
  actor: { id?: string; display_name: string; avatar_url: string | null } | null;
};

const DETAILS_KEY = "card-activity-details";
const readDetails = () => {
  try {
    return localStorage.getItem(DETAILS_KEY) !== "0";
  } catch {
    return true;
  }
};

interface Shared {
  cardId: string;
  boardMembers: Profile[];
  reactions: CommentReaction[];
  onAttachFiles: (files: FileList) => void;
}

// ================================================================ main feed ==

export function CommentsFeed({
  cardId,
  roots,
  repliesByParent,
  activity,
  activityLoading,
  boardLists,
  boardMembers,
  reactions,
  onOpenThread,
  onAttachFiles,
}: Shared & {
  roots: CommentWithAuthor[];
  repliesByParent: Map<string, CommentWithAuthor[]>;
  activity: ActivityWithActor[];
  activityLoading: boolean;
  boardLists: ListT[];
  onOpenThread: (id: string) => void;
}) {
  const can = useBoardCan();
  const [details, setDetails] = useState(readDetails);
  const toggleDetails = () =>
    setDetails((v) => {
      try {
        localStorage.setItem(DETAILS_KEY, v ? "0" : "1");
      } catch {
        /* storage unavailable — keep it in memory */
      }
      return !v;
    });

  const items = useMemo(() => {
    type Item = { kind: "comment"; at: string; c: CommentWithAuthor } | { kind: "activity"; at: string; a: ActivityWithActor };
    const out: Item[] = roots.map((c) => ({ kind: "comment" as const, at: c.created_at, c }));
    const cloned = activity.some((a) => a.action === "card.cloned");
    for (const a of activity) {
      if (cloned && a.action === "card.created") continue; // a copy reads as "copied", not "added"
      if (!details && a.action !== "card.created" && a.action !== "card.cloned") continue;
      out.push({ kind: "activity", at: a.created_at, a });
    }
    return out.sort((x, y) => (x.at < y.at ? 1 : -1));
  }, [roots, activity, details]);


  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="flex items-center gap-2 text-base font-semibold text-ink">
          <MessageSquare size={16} className="text-muted" />
          Comments and activity
        </h3>
        <Button variant="secondary" size="sm" onClick={toggleDetails}>
          {details ? "Hide details" : "Show details"}
        </Button>
      </div>

      {can("pm.manage_comments") && (
        <CommentComposer cardId={cardId} boardMembers={boardMembers} onAttachFiles={onAttachFiles} />
      )}

      <div className="mt-4 space-y-4">
        {items.map((it) =>
          it.kind === "comment" ? (
            <CommentItem
              key={it.c.id}
              c={it.c}
              cardId={cardId}
              boardMembers={boardMembers}
              reactions={reactions}
              onAttachFiles={onAttachFiles}
              replies={repliesByParent.get(it.c.id) ?? []}
              onOpenThread={() => onOpenThread(it.c.id)}
            />
          ) : (
            <ActivityItem key={it.a.id} a={it.a} boardLists={boardLists} />
          ),
        )}
        {activityLoading && <Spinner size={14} />}
        {!activityLoading && items.length === 0 && <p className="text-sm text-subtle">No comments yet.</p>}
      </div>
    </section>
  );
}

// ============================================================== composers ==

const toMentionMembers = (ms: Profile[]): MentionMember[] =>
  ms.map((m) => ({ id: m.id, username: m.username, display_name: m.display_name, avatar_url: m.avatar_url }));

function usePostComment(cardId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { body: string; parentId: string | null }) => addComment(cardId, v.body, v.parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      qc.invalidateQueries({ queryKey: ["activity", cardId] });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Comment failed", description: e.message }),
  });
}

// Markdown the editor emits for an "empty" document can still hold whitespace.
const isBlank = (md: string) => md.replace(/[\s\\]/g, "") === "";

function CommentComposer({ cardId, boardMembers, onAttachFiles }: { cardId: string; boardMembers: Profile[]; onAttachFiles: (f: FileList) => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  // Unsent text stays as a draft (click away, close the card, reload) until
  // Save — it is never posted on its own.
  const draft = useDraft(`comment:${cardId}`);
  const post = usePostComment(cardId);
  const members = useMemo(() => toMentionMembers(boardMembers), [boardMembers]);

  const send = () => {
    const body = draft.value.trim();
    if (isBlank(body) || post.isPending) return;
    setOpen(false);
    post.mutate({ body, parentId: null }, { onSuccess: draft.discard });
  };

  if (!open) {
    return (
      <div className="flex gap-2">
        <Avatar name={user?.user_metadata?.display_name ?? user?.email ?? "?"} size={32} />
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-1 min-w-0 flex items-center gap-2 text-left h-10 rounded-md border border-rule bg-inset px-3 text-sm text-subtle hover:bg-border/70 transition-colors"
        >
          {draft.hasDraft ? <DraftTag text={draft.value} className="max-w-full" /> : "Write a comment…"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Avatar name={user?.user_metadata?.display_name ?? user?.email ?? "?"} size={32} />
      <div className="flex-1 min-w-0">
        <RichEditor
          autoFocus
          value={draft.value}
          onChange={draft.set}
          onSubmit={send}
          onLeave={() => setOpen(false)}
          members={members}
          onAttachFiles={onAttachFiles}
          placeholder="Write a comment… use @ to mention"
          footer={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="primary" disabled={isBlank(draft.value)} onMouseDown={keepFocus} onClick={send} loading={post.isPending}>
                Save
              </Button>
              {draft.hasDraft && (
                <Button
                  size="sm"
                  variant="ghost"
                  onMouseDown={keepFocus}
                  onClick={() => {
                    draft.discard();
                    setOpen(false);
                  }}
                >
                  Discard
                </Button>
              )}
              <span className="text-[11px] text-subtle hidden sm:inline">Ctrl+Enter to save · kept as draft if you click away</span>
            </div>
          }
        />
      </div>
    </div>
  );
}

// ============================================================ comment item ==

function useReactions(cardId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { commentId: string; emoji: string; on: boolean; userId: string }) => setReaction(v.commentId, v.emoji, v.on),
    onMutate: (v) => {
      qc.setQueryData<CardDetailBundle>(["card", cardId], (b) => {
        if (!b) return b;
        const rest = b.reactions.filter((r) => !(r.comment_id === v.commentId && r.user_id === v.userId && r.emoji === v.emoji));
        return {
          ...b,
          reactions: v.on
            ? [...rest, { comment_id: v.commentId, user_id: v.userId, emoji: v.emoji, created_at: new Date().toISOString() }]
            : rest,
        };
      });
    },
    onError: (e: Error) => {
      qc.invalidateQueries({ queryKey: ["card", cardId] });
      toast.push({ kind: "error", title: "Reaction failed", description: e.message });
    },
  });
}

export function CommentItem({
  c,
  cardId,
  boardMembers,
  reactions,
  onAttachFiles,
  replies,
  onOpenThread,
  size = 32,
}: Shared & {
  c: CommentWithAuthor;
  replies?: CommentWithAuthor[];
  onOpenThread?: () => void;
  size?: number;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { can, access } = useCurrentBoardAccess();
  // Board admins moderate other people's comments (RLS mirrors this).
  const isAdmin = access === "admin";
  const me = user?.id;
  const mine = c.author_id === me;
  const [editing, setEditing] = useState(false);
  const draft = useDraft(`comment-edit:${c.id}`, c.body);
  const members = useMemo(() => toMentionMembers(boardMembers), [boardMembers]);
  const nameOf = useMemo(() => new Map(boardMembers.map((m) => [m.id, m.display_name])), [boardMembers]);
  const react = useReactions(cardId);

  const refresh = () => qc.invalidateQueries({ queryKey: ["card", cardId] });

  const edit = useMutation({
    mutationFn: (body: string) => updateComment(c.id, body),
    onSuccess: refresh,
    onError: (e: Error) => toast.push({ kind: "error", title: "Edit failed", description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => deleteComment(c.id),
    onSuccess: () => {
      refresh();
      toast.push({ kind: "info", title: "Comment deleted" });
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Delete failed", description: e.message }),
  });

  // An unfinished edit is a draft: it survives clicking away / closing the
  // card and is only written on Save.
  const saveEdit = () => {
    const body = draft.value.trim();
    setEditing(false);
    if (isBlank(body) || body === c.body.trim()) return draft.discard();
    edit.mutate(body, { onSuccess: draft.commit });
  };

  const groups = useMemo(() => {
    const m = new Map<string, { emoji: string; users: string[] }>();
    for (const r of reactions) {
      if (r.comment_id !== c.id) continue;
      const g = m.get(r.emoji) ?? { emoji: r.emoji, users: [] };
      g.users.push(r.user_id);
      m.set(r.emoji, g);
    }
    return [...m.values()];
  }, [reactions, c.id]);

  const toggleReaction = (emoji: string, on: boolean) => me && react.mutate({ commentId: c.id, emoji, on, userId: me });

  const participants = useMemo(() => {
    const seen = new Map<string, { name: string; avatar: string | null }>();
    for (const r of replies ?? []) {
      if (!r.author) continue;
      const key = r.author.id ?? r.author.display_name;
      if (!seen.has(key)) seen.set(key, { name: r.author.display_name, avatar: r.author.avatar_url });
    }
    return [...seen.values()].slice(0, 3);
  }, [replies]);
  const lastReply = replies?.[replies.length - 1];

  return (
    <div className="flex gap-2">
      <Avatar name={c.author?.display_name ?? "?"} src={c.author?.avatar_url} size={size} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold text-ink">{c.author?.display_name}</span>
          <span className="text-xs text-subtle" title={new Date(c.created_at).toLocaleString()}>
            {relativeTime(c.created_at)}
          </span>
          {c.edited_at && <span className="text-[11px] text-subtle">(edited)</span>}
        </div>

        {editing ? (
          <div className="mt-1">
            <RichEditor
              autoFocus
              value={draft.value}
              onChange={draft.set}
              onSubmit={saveEdit}
              onLeave={() => setEditing(false)}
              members={members}
              onAttachFiles={onAttachFiles}
              footer={
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" onMouseDown={keepFocus} onClick={saveEdit}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onMouseDown={keepFocus}
                    onClick={() => {
                      draft.discard();
                      setEditing(false);
                    }}
                  >
                    Discard changes
                  </Button>
                </div>
              }
            />
          </div>
        ) : (
          <>
            <div className="mt-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink shadow-card">
              <Markdown text={c.body} />
            </div>
            {mine && draft.hasDraft && (
              <DraftNotice
                label="You have an unsaved edit on this comment."
                onView={() => setEditing(true)}
                onDiscard={draft.discard}
              />
            )}
          </>
        )}

        {/* Reactions */}
        {groups.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {groups.map((g) => {
              const reacted = !!me && g.users.includes(me);
              return (
                <button
                  key={g.emoji}
                  type="button"
                  title={g.users.map((u) => (u === me ? "You" : nameOf.get(u) ?? "Someone")).join(", ")}
                  onClick={() => toggleReaction(g.emoji, !reacted)}
                  className={cn(
                    "inline-flex items-center gap-1 h-6 px-1.5 rounded-full border text-xs transition-colors",
                    reacted ? "border-accent bg-accent-soft text-ink" : "border-border bg-inset text-muted hover:border-rule",
                  )}
                >
                  <span className="text-sm leading-none">{g.emoji}</span>
                  <span className="tabular-nums">{g.users.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Actions row: react • Reply • Edit • Delete */}
        {!editing && (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-subtle">
            <Menu
              trigger={
                <button type="button" className="grid place-items-center w-6 h-6 rounded-md hover:bg-inset hover:text-ink transition-colors" aria-label="Add reaction" title="Add reaction">
                  <SmilePlus size={14} />
                </button>
              }
            >
              {(close) => (
                <div className="-my-1">
                  <EmojiPicker
                    onPick={(emo) => {
                      const has = groups.some((g) => g.emoji === emo && !!me && g.users.includes(me));
                      if (!has) toggleReaction(emo, true);
                      close();
                    }}
                  />
                </div>
              )}
            </Menu>
            {onOpenThread && can("pm.manage_comments") && (
              <>
                <Dot />
                <TextBtn onClick={onOpenThread}>Reply</TextBtn>
              </>
            )}
            {mine && (
              <>
                <Dot />
                <TextBtn
                  // Resumes an unsaved edit if there is one.
                  onClick={() => setEditing(true)}
                >
                  Edit
                </TextBtn>
              </>
            )}
            {(mine || isAdmin) && (
              <>
                <Dot />
                <TextBtn
                  onClick={() => {
                    const n = replies?.length ?? 0;
                    if (confirm(n ? `Delete this comment and its ${n} ${n === 1 ? "reply" : "replies"}?` : "Delete this comment?")) remove.mutate();
                  }}
                >
                  Delete
                </TextBtn>
              </>
            )}
          </div>
        )}

        {/* Thread indicator — replies never render inline in the timeline. */}
        {onOpenThread && replies && replies.length > 0 && (
          <button
            type="button"
            onClick={onOpenThread}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-inset px-2 py-1 text-xs font-medium text-accent hover:border-rule transition-colors"
          >
            <span className="flex -space-x-1.5">
              {participants.map((p, i) => (
                <Avatar key={i} name={p.name} src={p.avatar} size={18} />
              ))}
            </span>
            <span>
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </span>
            {lastReply && <span className="text-subtle font-normal">· last reply {relativeTime(lastReply.created_at)}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

function Dot() {
  return <span aria-hidden>•</span>;
}

function TextBtn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="underline underline-offset-2 hover:text-ink transition-colors">
      {children}
    </button>
  );
}

// ============================================================ thread panel ==

export function ThreadPanel({
  root,
  replies,
  cardId,
  boardMembers,
  reactions,
  onAttachFiles,
  onBack,
}: Shared & {
  root: CommentWithAuthor;
  replies: CommentWithAuthor[];
  onBack: () => void;
}) {
  const { user } = useAuth();
  const can = useBoardCan();
  // Reply text is a draft per thread until Reply is pressed.
  const draft = useDraft(`reply:${root.id}`);
  const post = usePostComment(cardId);
  const members = useMemo(() => toMentionMembers(boardMembers), [boardMembers]);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest reply in view as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [replies.length]);

  const send = () => {
    const body = draft.value.trim();
    if (isBlank(body) || post.isPending) return;
    post.mutate({ body, parentId: root.id }, { onSuccess: draft.discard });
  };

  const shared = { cardId, boardMembers, reactions, onAttachFiles };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-bg">
      <div className="flex items-center gap-2 px-4 sm:px-5 py-3 border-b border-line shrink-0">
        <button
          onClick={onBack}
          aria-label="Back to comments"
          className="h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">Thread</div>
          <div className="text-xs text-subtle">
            {replies.length === 0 ? "No replies yet" : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-4">
        <CommentItem c={root} {...shared} replies={replies} size={34} />
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-line" />
          <span className="text-[11px] text-subtle shrink-0">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </span>
          <div className="h-px flex-1 bg-line" />
        </div>
        <div className="space-y-4 border-l-2 border-line pl-3 ml-4">
          {replies.map((r) => (
            <CommentItem key={r.id} c={r} {...shared} size={28} />
          ))}
          {replies.length === 0 && <p className="text-sm text-subtle">No replies yet. Start the conversation.</p>}
        </div>
        <div ref={endRef} />
      </div>

      {can("pm.manage_comments") && (
        <div className="border-t border-line p-3 sm:px-5 shrink-0">
          <div className="flex gap-2">
            <Avatar name={user?.user_metadata?.display_name ?? user?.email ?? "?"} size={30} />
            <div className="flex-1 min-w-0">
              <RichEditor
                autoFocus
                menusUp
                value={draft.value}
                onChange={draft.set}
                onSubmit={send}
                members={members}
                onAttachFiles={onAttachFiles}
                placeholder="Reply to this thread…"
                footer={
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="primary" iconLeft={<ReplyIcon size={14} />} disabled={isBlank(draft.value)} onMouseDown={keepFocus} onClick={send} loading={post.isPending}>
                      Reply
                    </Button>
                    {draft.hasDraft && (
                      <>
                        <DraftTag />
                        <Button size="sm" variant="ghost" onMouseDown={keepFocus} onClick={draft.discard}>
                          Discard
                        </Button>
                      </>
                    )}
                  </div>
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================ activity item ==

const pad = (n: number) => String(n).padStart(2, "0");
function dayWord(d: Date): string {
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((d0 - t0) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}
function fmtDue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const h = d.getHours() % 12 || 12;
  return `${dayWord(d)} at ${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`;
}
function fmtDay(ymd?: string): string {
  if (!ymd) return "";
  const [y, m, dd] = ymd.slice(0, 10).split("-").map(Number);
  return dayWord(new Date(y!, (m ?? 1) - 1, dd ?? 1));
}

function B({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-ink">{children}</span>;
}

export function ActivityItem({ a, boardLists }: { a: ActivityWithActor; boardLists: ListT[] }) {
  const d = (a.data ?? {}) as Record<string, string | undefined>;
  const listTitle = (id?: string) => boardLists.find((l) => l.id === id)?.title;
  const self = d.user_id && d.user_id === a.actor_id;

  const text: ReactNode = (() => {
    switch (a.action) {
      case "card.created":
        return <>added this card to <B>{d.list_title ?? listTitle(d.list_id) ?? "a list"}</B></>;
      case "card.cloned":
        return (
          <>
            copied this card{d.source_title ? <> from <B>{d.source_title}</B></> : null}
            {d.list_title ? <> in list <B>{d.list_title}</B></> : null}
          </>
        );
      case "card.moved": {
        const from = d.from_title ?? listTitle(d.from_list);
        const to = d.to_title ?? listTitle(d.to_list);
        return from && to ? <>moved this card from <B>{from}</B> to <B>{to}</B></> : <>moved this card</>;
      }
      case "card.archived":
        return <>archived this card</>;
      case "card.restored":
        return <>sent this card to the board</>;
      case "card.renamed":
        return <>renamed this card (was “{d.from}”)</>;
      case "card.description_changed":
        return <>updated the description of this card</>;
      case "card.due_set":
        return <>set this card to be due {fmtDue(d.due)}</>;
      case "card.due_changed":
        return <>changed the due date of this card to {fmtDue(d.due)}</>;
      case "card.due_removed":
        return <>removed the due date from this card</>;
      case "card.start_set":
        return <>set the start date of this card to {fmtDay(d.start)}</>;
      case "card.start_removed":
        return <>removed the start date from this card</>;
      case "card.completed":
        return <>marked this card as complete</>;
      case "card.uncompleted":
        return <>marked this card as incomplete</>;
      case "card.cover_changed":
        return (
          <>
            changed the cover of this card{" "}
            {d.color && <span className="inline-block w-3 h-3 rounded-sm align-middle" style={{ background: d.color }} />}
          </>
        );
      case "card.cover_removed":
        return <>removed the cover from this card</>;
      case "card.member_added":
      case "card.self_assigned":
        return self || a.action === "card.self_assigned" ? <>joined this card</> : <>added <B>{d.name}</B> to this card</>;
      case "card.member_removed":
      case "card.self_unassigned":
        return self || a.action === "card.self_unassigned" ? <>left this card</> : <>removed <B>{d.name}</B> from this card</>;
      case "card.label_added":
      case "card.label_removed":
        return (
          <>
            {a.action === "card.label_added" ? "added the " : "removed the "}
            <span className="inline-flex items-center h-5 px-2 rounded-md text-xs font-medium align-middle" style={{ background: d.color, color: readableText(d.color ?? "") }}>
              {d.name || " "}
            </span>
            {a.action === "card.label_added" ? " label to this card" : " label from this card"}
          </>
        );
      case "checklist.added":
        return <>added <B>{d.name}</B> to this card</>;
      case "checklist.removed":
        return <>removed <B>{d.name}</B> from this card</>;
      case "checklist.item_completed":
        return <>completed <B>{d.text}</B> on this card</>;
      case "checklist.item_uncompleted":
        return <>marked <B>{d.text}</B> incomplete on this card</>;
      case "attachment.added":
        return <>attached <B>{d.name}</B> to this card</>;
      case "attachment.removed":
        return <>deleted the <B>{d.name}</B> attachment from this card</>;
      case "custom_field.updated":
        return <>updated the value for the <B>{d.name}</B> custom field on this card</>;
      case "card.templated":
        return <>made this card a template</>;
      case "card.untemplated":
        return <>made this card a regular card</>;
      default:
        return <>{a.action}</>;
    }
  })();

  return (
    <div className="flex gap-2">
      <Avatar name={a.actor?.display_name ?? "?"} src={a.actor?.avatar_url} size={32} />
      <div className="flex-1 min-w-0 text-sm text-muted leading-snug">
        <B>{a.actor?.display_name ?? "Someone"}</B> {text}
        <div className="mt-0.5 text-xs text-subtle underline underline-offset-2" title={new Date(a.created_at).toLocaleString()}>
          {relativeTime(a.created_at)}
        </div>
      </div>
    </div>
  );
}
