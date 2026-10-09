import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Eye, Link2Off, MessageCircle, MessageSquarePlus, Send, X } from "lucide-react";
import { Canvas } from "@/components/wb/Canvas";
import { ZoomControls } from "@/components/wb/ZoomControls";
import { Button } from "@/components/ui/Button";
import { PageSpinner } from "@/components/ui/Spinner";
import { Textarea, Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/format";
import { useWb, resetBoard, loadItems, zoomToFit, screenToWorld, worldToScreen } from "@/lib/wb/store";
import { seedMediaUrls } from "@/lib/wb/api";
import { docBlocks } from "@/lib/wb/docBlocks";
import { str, type WbItem } from "@/lib/wb/types";
import {
  commentShared,
  openShared,
  savedGuestName,
  saveGuestName,
  sharedMediaUrls,
  type SharedBoard,
  type SharedComment,
} from "@/lib/wb/share";

// -----------------------------------------------------------------------------
// A Miro board opened from a client link (/s/<token>): no account, read only,
// plus comments when the link allows them. The board refreshes every 20s.
// -----------------------------------------------------------------------------

const S = useWb.getState;
const REFRESH = 20_000;

/** Storage paths of the board's images, videos and doc pictures. */
function mediaPaths(items: WbItem[]): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const p = str(it.data.path);
    if (p && (it.type === "image" || it.type === "embed")) out.add(p);
    if (it.type === "doc") for (const b of docBlocks(it)) if (b.p) out.add(b.p);
  }
  return [...out];
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: SharedBoard };

export default function ShareViewPage() {
  const { token = "" } = useParams();
  const [state, setState] = useState<State>({ status: "loading" });
  const signed = useRef(new Set<string>());
  const sig = useRef("");

  const load = useCallback(
    async (first: boolean) => {
      try {
        const data = await openShared(token, savedGuestName() || undefined);
        // Sign new media before the items render, so pictures show straight away.
        const fresh = mediaPaths(data.items).filter((p) => !signed.current.has(p));
        if (fresh.length) {
          seedMediaUrls(await sharedMediaUrls(token, fresh));
          for (const p of fresh) signed.current.add(p);
        }
        if (first) {
          resetBoard(data.board.id, "guest", false, false);
          useWb.setState({ canCopy: false, tool: "select" });
        }
        const next = JSON.stringify(data.items.map((i) => [i.id, i.updated_at ?? "", i.x, i.y, i.w, i.h]));
        if (first || next !== sig.current) {
          sig.current = next;
          loadItems(data.items);
        }
        // Fit once the canvas has measured itself.
        if (first) for (const ms of [0, 250]) setTimeout(() => zoomToFit(), ms);
        setState({ status: "ready", data });
      } catch (e) {
        setState({ status: "error", message: (e as Error).message || "This link is not valid" });
      }
    },
    [token],
  );

  useEffect(() => {
    void load(true);
    const t = setInterval(() => document.visibilityState === "visible" && void load(false), REFRESH);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (state.status === "ready") document.title = `${state.data.board.title} · Iklipse`;
  }, [state]);

  if (state.status === "loading") return <PageSpinner />;
  if (state.status === "error") {
    return (
      <div className="h-dvh grid place-items-center bg-bg px-4">
        <div className="max-w-sm w-full rounded-xl border border-border bg-surface shadow-raise p-6 text-center animate-scale-in">
          <div className="mx-auto h-12 w-12 rounded-full bg-inset grid place-items-center text-muted">
            <Link2Off size={22} />
          </div>
          <h1 className="mt-3 text-lg font-semibold text-ink">{state.message}</h1>
          <p className="mt-1 text-sm text-muted">Ask the person who shared this board for a new link.</p>
        </div>
      </div>
    );
  }
  return <SharedBoardView token={token} data={state.data} reload={() => load(false)} />;
}

function SharedBoardView({ token, data, reload }: { token: string; data: SharedBoard; reload: () => Promise<void> }) {
  const canComment = data.link.access === "comment";
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-bg">
      <Canvas />

      {canComment && (
        <CommentPins comments={data.comments} open={openThread} onOpen={(id) => (setOpenThread(id), setDraft(null))} />
      )}

      {/* Adding a comment: the next click on the board places it. */}
      {adding && (
        <div
          data-wb-ui
          className="absolute inset-0 z-20 cursor-crosshair"
          onPointerDown={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setDraft(screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top }));
            setAdding(false);
            setOpenThread(null);
          }}
        />
      )}

      {/* Header */}
      <div
        data-wb-ui
        className="absolute z-30 top-3 left-3 right-3 sm:right-auto flex items-center gap-2 px-3 h-11 rounded-lg bg-surface border border-border shadow-pop max-w-[calc(100%-24px)]"
      >
        <span className="display text-[16px] text-ink shrink-0">Iklipse</span>
        <span className="w-px h-5 bg-line shrink-0" />
        <span className="font-semibold text-ink truncate min-w-0">{data.board.title}</span>
        <span className="shrink-0 inline-flex items-center gap-1 px-2 h-6 rounded-full bg-inset text-xs text-muted">
          {canComment ? <MessageCircle size={12} /> : <Eye size={12} />}
          {canComment ? "Can comment" : "View only"}
        </span>
        {data.link.expires_at && (
          <span className="shrink-0 text-xs text-subtle max-sm:hidden">Link expires {relativeTime(data.link.expires_at)}</span>
        )}
      </div>

      {canComment && (
        <div data-wb-ui className="absolute z-30 left-3 bottom-3 flex items-center gap-1 p-1 rounded-lg bg-surface border border-border shadow-pop">
          <Button
            size="sm"
            variant={adding ? "primary" : "ghost"}
            iconLeft={<MessageSquarePlus size={15} />}
            onClick={() => (setAdding((a) => !a), setDraft(null), setOpenThread(null))}
          >
            {adding ? "Click where to comment" : "Add comment"}
          </Button>
        </div>
      )}

      <ZoomControls map={false} />

      {draft && (
        <CommentBox
          token={token}
          at={draft}
          onClose={() => setDraft(null)}
          onSent={async () => {
            setDraft(null);
            await reload();
          }}
        />
      )}
      {openThread && (
        <ThreadBox
          token={token}
          thread={openThread}
          comments={data.comments}
          onClose={() => setOpenThread(null)}
          onSent={reload}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------- comments --
/** Where a thread sits on the board (pinned to an item, or a free point). */
function threadPoint(c: SharedComment, items: Record<string, WbItem>) {
  const host = c.item_id ? items[c.item_id] : null;
  return host ? { x: host.x + (c.x ?? 0), y: host.y + (c.y ?? 0) } : { x: c.x ?? 0, y: c.y ?? 0 };
}

function CommentPins({ comments, open, onOpen }: { comments: SharedComment[]; open: string | null; onOpen: (id: string) => void }) {
  useWb((s) => s.viewport); // follow pans and zooms
  const items = useWb((s) => s.items);
  const roots = comments.filter((c) => !c.thread_id);
  const replies = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of comments) if (c.thread_id) m.set(c.thread_id, (m.get(c.thread_id) ?? 0) + 1);
    return m;
  }, [comments]);
  return (
    <>
      {roots.map((c) => {
        const p = worldToScreen(threadPoint(c, items));
        const n = 1 + (replies.get(c.id) ?? 0);
        return (
          <button
            key={c.id}
            data-wb-ui
            type="button"
            title={`${c.author}: ${c.body.slice(0, 80)}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onOpen(c.id)}
            className={cn(
              "absolute z-10 -translate-y-full h-8 min-w-8 px-1.5 rounded-full rounded-bl-none grid place-items-center text-xs font-semibold shadow-pop border-2 border-surface",
              open === c.id ? "bg-accent text-white" : c.guest ? "bg-warn text-white" : "bg-accent text-white",
            )}
            style={{ left: p.x, top: p.y }}
          >
            {n > 1 ? n : (c.author[0] ?? "?").toUpperCase()}
          </button>
        );
      })}
    </>
  );
}

function NameField({ name, setName }: { name: string; setName: (v: string) => void }) {
  return <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Your name" aria-label="Your name" className="mb-2" />;
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      data-wb-ui
      className="absolute z-40 right-3 top-16 w-[340px] max-w-[calc(100%-24px)] max-h-[calc(100%-8rem)] flex flex-col rounded-lg bg-surface border border-border shadow-raise animate-slide-up"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="shrink-0 flex items-center gap-2 px-3 h-11 border-b border-line">
        <span className="text-sm font-semibold text-ink">{title}</span>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto h-8 w-8 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink">
          <X size={16} />
        </button>
      </div>
      {children}
    </div>
  );
}

function useSend(token: string, onSent: () => void | Promise<void>) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const send = async (name: string, body: string, at: Parameters<typeof commentShared>[3]) => {
    if (!name.trim()) return toast.push({ kind: "error", title: "Add your name first" });
    if (!body.trim()) return;
    setBusy(true);
    try {
      saveGuestName(name.trim());
      await commentShared(token, name.trim(), body.trim(), at);
      await onSent();
      return true;
    } catch (e) {
      toast.push({ kind: "error", title: "Couldn't send", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}

function CommentBox({ token, at, onClose, onSent }: { token: string; at: { x: number; y: number }; onClose: () => void; onSent: () => Promise<void> }) {
  const [name, setName] = useState(savedGuestName());
  const [body, setBody] = useState("");
  const { busy, send } = useSend(token, onSent);
  // Pinned to whatever item sits under the point, so the comment moves with it.
  const host = useMemo(() => {
    const list = Object.values(S().items).filter((i) => i.type !== "connector" && i.type !== "pen" && at.x >= i.x && at.x <= i.x + i.w && at.y >= i.y && at.y <= i.y + i.h);
    return list.sort((a, b) => b.z - a.z)[0] ?? null;
  }, [at]);
  return (
    <Panel title="New comment" onClose={onClose}>
      <form
        className="p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(name, body, host ? { item: host.id, x: at.x - host.x, y: at.y - host.y } : { x: at.x, y: at.y });
        }}
      >
        {!savedGuestName() && <NameField name={name} setName={setName} />}
        <Textarea autoFocus rows={3} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment" aria-label="Comment" />
        <div className="mt-2 flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={busy} iconLeft={<Send size={14} />} disabled={!body.trim()}>
            Comment
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ThreadBox({
  token,
  thread,
  comments,
  onClose,
  onSent,
}: {
  token: string;
  thread: string;
  comments: SharedComment[];
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const [name, setName] = useState(savedGuestName());
  const [body, setBody] = useState("");
  const { busy, send } = useSend(token, onSent);
  const list = comments.filter((c) => c.id === thread || c.thread_id === thread);
  if (!list.length) return null;
  return (
    <Panel title="Comments" onClose={onClose}>
      <ul className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {list.map((c) => (
          <li key={c.id}>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold text-ink">{c.author}</span>
              {c.guest && <span className="text-[11px] text-subtle">Guest</span>}
              <span className="ml-auto text-[11px] text-subtle">{relativeTime(c.created_at)}</span>
            </div>
            <p className="text-sm text-ink whitespace-pre-wrap break-words">{c.body}</p>
          </li>
        ))}
      </ul>
      <form
        className="shrink-0 p-3 border-t border-line"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await send(name, body, { thread })) setBody("");
        }}
      >
        {!savedGuestName() && <NameField name={name} setName={setName} />}
        <Textarea rows={2} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="Reply" aria-label="Reply" />
        <div className="mt-2 flex justify-end">
          <Button type="submit" variant="primary" size="sm" loading={busy} iconLeft={<Send size={14} />} disabled={!body.trim()}>
            Reply
          </Button>
        </div>
      </form>
    </Panel>
  );
}
