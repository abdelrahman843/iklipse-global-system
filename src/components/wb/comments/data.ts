import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { useToast } from "@/components/ui/Toast";
import { relativeTime } from "@/lib/format";
import { addComment, deleteComment, fetchComments, updateComment, type WbComment } from "@/lib/wb/api";
import { useWb, geomOf, animateViewport, viewportFor, type WbState } from "@/lib/wb/store";
import { geomBounds, unionRects, type Pt, type Rect } from "@/lib/wb/geometry";
import { str, type ItemType, type WbItem } from "@/lib/wb/types";

// -----------------------------------------------------------------------------
// Comment threads on the canvas. A thread is its root row (thread_id null,
// carries the position) plus the replies pointing at it. Rows live in the
// react-query cache ["wb-comments", board]; sync.ts invalidates it on every
// wb_comment change, writes here patch it first so the UI never waits.
// -----------------------------------------------------------------------------

export type CommentRow = WbComment & { pending?: boolean };

export interface Thread {
  root: CommentRow;
  replies: CommentRow[];
  /** Newest message (list order). */
  last: number;
  lastAt: string;
}

/** Bubble size of a pin on screen (px). Its bottom-left corner is the spot. */
export const PIN = 36;

export const commentsKey = (boardId: string) => ["wb-comments", boardId] as const;

export function useComments(boardId: string) {
  return useQuery({
    queryKey: commentsKey(boardId),
    queryFn: () => fetchComments(boardId) as Promise<CommentRow[]>,
    enabled: !!boardId,
    staleTime: 60_000,
  });
}

export function buildThreads(rows: CommentRow[] | undefined): Map<string, Thread> {
  const map = new Map<string, Thread>();
  for (const c of rows ?? []) {
    if (!c.thread_id) map.set(c.id, { root: c, replies: [], last: Date.parse(c.created_at), lastAt: c.created_at });
  }
  for (const c of rows ?? []) {
    const t = c.thread_id ? map.get(c.thread_id) : null;
    if (!t) continue;
    t.replies.push(c);
    const at = Date.parse(c.created_at);
    if (at > t.last) {
      t.last = at;
      t.lastAt = c.created_at;
    }
  }
  return map;
}

export function useThreads(boardId: string) {
  const q = useComments(boardId);
  const threads = useMemo(() => buildThreads(q.data), [q.data]);
  return { rows: q.data, threads, ready: !!q.data, isLoading: q.isLoading };
}

// ------------------------------------------------------------------- ui --
export type CommentFilter = "open" | "resolved" | "all";

/** Panel filter and whether resolved pins stay on the board. */
export const useCommentsUi = create<{ filter: CommentFilter; showResolved: boolean }>()(() => ({
  filter: "open",
  showResolved: false,
}));

/** Unsent replies per thread (kept when the popover closes). */
export const replyDrafts = new Map<string, string>();

/** Rows inserted here and not yet confirmed (a refetch may briefly miss them). */
export const pendingIds = new Set<string>();

// --------------------------------------------------------------- writes --
export function useCommentOps(boardId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMemo(() => {
    const key = commentsKey(boardId);
    const run = async (change: (rows: CommentRow[]) => CommentRow[], call: () => Promise<unknown>, failTitle: string) => {
      // A fetch cancelled mid-flight reverts its query, so let that settle first.
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<CommentRow[]>(key);
      qc.setQueryData<CommentRow[]>(key, (rows) => change(rows ?? []));
      try {
        await call();
        return true;
      } catch (e) {
        qc.setQueryData(key, before);
        toast.push({ kind: "error", title: failTitle, description: (e as Error).message });
        return false;
      } finally {
        void qc.invalidateQueries({ queryKey: key });
      }
    };

    return {
      /** New thread (with a position) or a reply (thread_id). Returns the new row's id. */
      add(input: { body: string; author_id: string; thread_id?: string | null; item_id?: string | null; x?: number | null; y?: number | null }) {
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const row: CommentRow = {
          id,
          board_id: boardId,
          thread_id: input.thread_id ?? null,
          item_id: input.item_id ?? null,
          x: input.x ?? null,
          y: input.y ?? null,
          author_id: input.author_id,
          body: input.body,
          resolved: false,
          created_at: now,
          updated_at: now,
          pending: true,
        };
        // The id is picked here so the pin and the open thread stay put when the row lands.
        const insert = { id, board_id: boardId, body: row.body, author_id: row.author_id, thread_id: row.thread_id, item_id: row.item_id, x: row.x, y: row.y };
        pendingIds.add(id);
        void run((rows) => [...rows, row], () => addComment(insert), "Couldn't post comment").finally(() => pendingIds.delete(id));
        return id;
      },
      edit: (id: string, body: string) =>
        run((rows) => rows.map((c) => (c.id === id ? { ...c, body } : c)), () => updateComment(id, { body }), "Couldn't edit comment"),
      setResolved: (id: string, resolved: boolean) =>
        run(
          (rows) => rows.map((c) => (c.id === id ? { ...c, resolved } : c)),
          () => updateComment(id, { resolved }),
          resolved ? "Couldn't resolve comment" : "Couldn't reopen comment",
        ),
      /** Deleting a root takes its replies with it (the database cascades). */
      remove: (id: string) =>
        run((rows) => rows.filter((c) => c.id !== id && c.thread_id !== id), () => deleteComment(id), "Couldn't delete comment"),
    };
  }, [qc, toast, boardId]);
}

// ------------------------------------------------------------- position --
/** World point a pin marks, or null when its item is gone (or not loaded yet). */
export function anchorOf(s: WbState, c: Pick<WbComment, "item_id" | "x" | "y">): Pt | null {
  if (c.x == null || c.y == null) return null;
  if (!c.item_id) return { x: c.x, y: c.y };
  const g = geomOf(s, c.item_id);
  return g ? { x: g.x + c.x, y: g.y + c.y } : null;
}

/** Bring a thread's pin (and its item) into view. False when it has no place on the board. */
export function goToThread(c: Pick<WbComment, "item_id" | "x" | "y">): boolean {
  const s = useWb.getState();
  const p = anchorOf(s, c);
  if (!p) return false;
  const spot: Rect = { x: p.x - 1, y: p.y - 1, w: 2, h: 2 };
  const g = c.item_id ? geomOf(s, c.item_id) : null;
  const r = (g && unionRects([geomBounds(g), spot])) || spot;
  // Phones can't spare 160px of padding on each side.
  const vp = viewportFor(r, Math.min(160, s.screen.w / 5), 1);
  // Centre it in the part of the board the side panel leaves visible.
  if (s.panel && s.screen.w >= 640) vp.x -= 176;
  animateViewport(vp);
  return true;
}

// --------------------------------------------------------------- labels --
export const TYPE_NAMES: Record<ItemType, string> = {
  sticky: "Sticky note",
  shape: "Shape",
  text: "Text",
  frame: "Frame",
  image: "Image",
  connector: "Connector",
  pen: "Drawing",
  card: "Card",
  emoji: "Emoji",
  doc: "Doc",
};

/** One-line text of an item (sticky / shape / text body, card or frame title, image name). */
export function itemText(it: WbItem): string {
  const d = it.data;
  const raw =
    it.type === "card" || it.type === "frame" || it.type === "doc" ? str(d.title) : it.type === "image" ? str(d.name) : it.type === "emoji" ? str(d.emoji) : str(d.text);
  return raw.replace(/\s+/g, " ").trim();
}

/** "just now" for fresh rows, else "3 minutes ago". */
export function when(iso: string) {
  return Date.now() - Date.parse(iso) < 45_000 ? "just now" : relativeTime(iso);
}
