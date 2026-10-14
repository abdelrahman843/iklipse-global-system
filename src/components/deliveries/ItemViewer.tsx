import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, Send } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { CommentRow, fileSize } from "./parts";
import { addTeamComment, clock, fileKey, setResolved, teamDownloadUrl, type Delivery, type DeliveryItem } from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// A picture or video full size, next to what was said about it this round.
// The team can reply (on a video, optionally at the moment it's paused on),
// tick comments resolved, and click "at 3:05" to jump the video there.
// -----------------------------------------------------------------------------

export function ItemViewer({
  delivery,
  items,
  index,
  urls,
  onIndex,
  onClose,
  onChanged,
}: {
  delivery: Delivery;
  /** The pictures and videos to step through. */
  items: DeliveryItem[];
  index: number;
  urls: Record<string, string>;
  onIndex: (i: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const item = items[index];
  const fresh = item ? urls[fileKey(item) ?? ""] : undefined;
  // The signed links are renewed in the background: keep the first one per
  // file so a playing video doesn't restart, and switch only when it fails
  // (picking up where it was).
  const [pinned, setPinned] = useState<Record<string, string>>({});
  const resumeAt = useRef<number | null>(null);
  useEffect(() => {
    if (item && fresh && !pinned[item.id]) setPinned((p) => ({ ...p, [item.id]: fresh }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, fresh]);
  const url = item ? pinned[item.id] ?? fresh : undefined;
  const renew = () => {
    if (!item || !fresh || fresh === url) return;
    resumeAt.current = video.current?.currentTime ?? null;
    setPinned((p) => ({ ...p, [item.id]: fresh }));
  };
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [atTime, setAtTime] = useState(true);
  const [body, setBody] = useState("");

  useEffect(() => {
    setNow(0);
    setBody("");
  }, [item?.id]);

  // Arrow keys step through the files (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "VIDEO")) return;
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex]);

  const comments = useMemo(() => {
    const list = delivery.comments.filter((c) => c.item_id === item?.id && c.round === delivery.round);
    // Videos read in playing order; pictures in the order they were written.
    return item?.kind === "video"
      ? [...list].sort((a, b) => (a.at_seconds ?? Infinity) - (b.at_seconds ?? Infinity) || a.created_at.localeCompare(b.created_at))
      : list;
  }, [delivery.comments, delivery.round, item?.id, item?.kind]);

  const post = useMutation({
    mutationFn: () => addTeamComment(delivery.id, item.id, body, item.kind === "video" && atTime ? Math.round(now * 100) / 100 : null),
    onSuccess: () => {
      setBody("");
      onChanged();
    },
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't post the reply", description: e.message }),
  });
  const resolve = useMutation({
    mutationFn: ({ id, v }: { id: string; v: boolean }) => setResolved(id, v),
    onSuccess: onChanged,
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't update the comment", description: e.message }),
  });
  const download = useMutation({
    mutationFn: () => teamDownloadUrl(fileKey(item)!, item.name),
    onSuccess: (href) => (window.location.href = href),
    onError: (e: Error) => toast.push({ kind: "error", title: "Couldn't get the file", description: e.message }),
  });

  if (!item) return null;

  const seek = (s: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = s;
    void v.play().catch(() => {});
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      fitViewport
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">{item.name}</span>
          {items.length > 1 && <span className="shrink-0 text-sm font-normal text-subtle tabular-nums">{index + 1} of {items.length}</span>}
        </span>
      }
    >
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* The media, with arrows to step through the delivery. */}
        <div className="relative shrink-0 lg:flex-1 lg:min-w-0 bg-black grid place-items-center max-lg:max-h-[45vh] lg:min-h-0">
          {!url ? (
            <span className="py-20 text-sm text-white/70">Loading…</span>
          ) : item.kind === "video" ? (
            <video
              key={item.id}
              ref={video}
              src={url}
              controls
              playsInline
              preload="metadata"
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              onError={renew}
              onLoadedMetadata={(e) => {
                if (resumeAt.current == null) return;
                e.currentTarget.currentTime = resumeAt.current;
                resumeAt.current = null;
                void e.currentTarget.play().catch(() => {});
              }}
              onSeeked={(e) => setNow(e.currentTarget.currentTime)}
              className="max-h-[45vh] lg:max-h-[calc(100dvh-10rem)] w-full h-full object-contain"
            />
          ) : (
            <img key={item.id} src={url} alt={item.name} onError={renew} className="max-h-[45vh] lg:max-h-[calc(100dvh-10rem)] w-full h-full object-contain" />
          )}
          {index > 0 && (
            <button
              type="button"
              aria-label="Previous file"
              onClick={() => onIndex(index - 1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 h-9 w-9 grid place-items-center rounded-full bg-black/50 text-white hover:bg-black/70"
            >
              <ChevronLeft size={18} />
            </button>
          )}
          {index < items.length - 1 && (
            <button
              type="button"
              aria-label="Next file"
              onClick={() => onIndex(index + 1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 grid place-items-center rounded-full bg-black/50 text-white hover:bg-black/70"
            >
              <ChevronRight size={18} />
            </button>
          )}
        </div>

        {/* This round's comments on it, and a reply box. */}
        <aside className="flex-1 lg:flex-none lg:w-[22rem] min-h-0 flex flex-col border-t lg:border-t-0 lg:border-l border-line">
          <div className="shrink-0 px-4 py-3 border-b border-line flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-base font-semibold text-ink">Comments · Round {delivery.round}</div>
              <div className="text-xs text-muted truncate">{[fileSize(item.size), item.added_round > 1 && `Added in round ${item.added_round}`].filter(Boolean).join(" · ")}</div>
            </div>
            {fileKey(item) && (
              <Button size="sm" variant="ghost" iconLeft={<Download size={14} />} loading={download.isPending} onClick={() => download.mutate()}>
                Download
              </Button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-4">
            {!comments.length ? (
              <p className="py-6 text-sm text-subtle">No comments on this one yet.</p>
            ) : (
              <div className="divide-y divide-line">
                {comments.map((c) => (
                  <CommentRow
                    key={c.id}
                    c={c}
                    onSeek={item.kind === "video" ? seek : undefined}
                    onResolve={(v) => resolve.mutate({ id: c.id, v })}
                    busy={resolve.isPending}
                  />
                ))}
              </div>
            )}
          </div>
          <div className="shrink-0 border-t border-line p-3 space-y-2">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              maxLength={4000}
              placeholder="Reply as the team…"
              aria-label="Reply"
              className="block w-full min-w-0 resize-none rounded-md border border-border bg-surface px-3 py-2 text-lg sm:text-base text-ink placeholder:text-subtle outline-none focus:border-accent"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) post.mutate();
              }}
            />
            <div className="flex items-center justify-between gap-2">
              {item.kind === "video" ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={atTime}
                  onClick={() => setAtTime(!atTime)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium tabular-nums transition-colors",
                    atTime ? "bg-accent-soft text-accent" : "bg-inset text-muted hover:text-ink",
                  )}
                  title="Attach the moment the video is on"
                >
                  {atTime ? `At ${clock(now)}` : "No time"}
                </button>
              ) : (
                <span className="text-xs text-subtle">The client sees team replies on their link.</span>
              )}
              <Button size="sm" variant="primary" iconLeft={<Send size={14} />} disabled={!body.trim()} loading={post.isPending} onClick={() => post.mutate()}>
                Reply
              </Button>
            </div>
          </div>
        </aside>
      </div>
    </Modal>
  );
}
