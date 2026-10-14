import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { IdentifyFirst, type VisitorComment, type VisitorItem } from "@/lib/deliveriesApi";
import { cn } from "@/lib/cn";
import { CommentList, Composer } from "./Comments";
import { Watermark, hiddenBlur, useProtection } from "./Protection";
import { VideoPlayer, type Marker, type PlayerHandle } from "./VideoPlayer";
import { isTyping, sortComments } from "./util";

// -----------------------------------------------------------------------------
// Full-screen look at one image or video, with its comments beside it (lg) or
// under it (phones). Arrow keys, the side buttons or a swipe go to the next one.
// -----------------------------------------------------------------------------

interface Props {
  items: VisitorItem[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  urls: Record<string, string>;
  onMediaError: (id: string) => void;
  comments: VisitorComment[];
  /** The round is open: comments can be added and removed. */
  open: boolean;
  canDownload: boolean;
  onDownload: (id: string) => void;
  onAdd: (item: string, body: string, at: number | null) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export function MediaViewer(p: Props) {
  const { items, index, onIndex, onClose } = p;
  const item = items[index];
  const { hidden, email } = useProtection();
  const toast = useToast();
  const player = useRef<PlayerHandle>(null);
  const [time, setTime] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const isVideo = item?.kind === "video";
  const count = items.length;
  const go = (d: number) => count > 1 && onIndex((index + d + count) % count);

  const mine = useMemo(
    () => sortComments(p.comments.filter((c) => c.item_id === item?.id), isVideo),
    [p.comments, item?.id, isVideo],
  );
  const markers: Marker[] = useMemo(
    () =>
      mine
        .filter((c) => c.at_seconds != null)
        .map((c) => ({ id: c.id, at: c.at_seconds!, text: c.body.length > 90 ? `${c.body.slice(0, 90)}...` : c.body })),
    [mine],
  );

  // Keys: arrows move, Esc closes, Space plays (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === " " && isVideo) {
        e.preventDefault();
        const v = player.current?.box()?.querySelector("video");
        if (v) void (v.paused ? v.play().catch(() => undefined) : v.pause());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The page behind doesn't scroll.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => setTime(0), [item?.id]);

  if (!item) return null;
  const url = p.urls[item.id];

  const seek = (t: number) => {
    player.current?.seek(t);
    setTime(t);
    // Phones: the player is above the comments.
    player.current?.box()?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  return (
    <div className="dv-protect fixed inset-0 z-[60] bg-black text-white flex flex-col animate-fade-in" role="dialog" aria-modal="true" aria-label={item.name}>
      {/* Top bar */}
      <div className="shrink-0 h-14 px-2 sm:px-4 flex items-center gap-2 border-b border-white/10">
        <div className="min-w-0 flex-1 pl-2">
          <div className="text-base font-semibold truncate">{item.name}</div>
          {count > 1 && (
            <div className="text-sm text-white/60 tabular-nums">
              {index + 1} of {count}
            </div>
          )}
        </div>
        {p.canDownload && (
          <button
            type="button"
            onClick={() => p.onDownload(item.id)}
            className="h-10 px-3 inline-flex items-center gap-2 rounded-md text-base hover:bg-white/10"
          >
            <Download size={18} />
            <span className="hidden sm:inline">Download</span>
          </button>
        )}
        <button type="button" aria-label="Close" onClick={onClose} className="h-10 w-10 grid place-items-center rounded-md hover:bg-white/10">
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain lg:overflow-hidden flex flex-col lg:flex-row">
        {/* Media */}
        <div
          className="relative shrink-0 h-[56dvh] lg:h-auto lg:flex-1 lg:min-w-0"
          onTouchStart={(e) => {
            if ((e.target as HTMLElement).closest("button, [role='slider'], input")) return (touch.current = null);
            touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          }}
          onTouchEnd={(e) => {
            const s = touch.current;
            touch.current = null;
            if (!s) return;
            const dx = e.changedTouches[0].clientX - s.x;
            const dy = e.changedTouches[0].clientY - s.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
          }}
        >
          {isVideo ? (
            <VideoPlayer
              key={item.id}
              ref={player}
              src={url}
              markers={markers}
              onError={() => p.onMediaError(item.id)}
              onTime={setTime}
              canDownload={p.canDownload}
              onDownload={() => p.onDownload(item.id)}
            />
          ) : (
            <div className="absolute inset-0 overflow-hidden" onContextMenu={(e) => e.preventDefault()}>
              {url ? (
                <img
                  key={item.id}
                  src={url}
                  alt={item.name}
                  draggable={false}
                  onError={() => p.onMediaError(item.id)}
                  className={cn("absolute inset-0 h-full w-full object-contain p-2 sm:p-6 select-none pointer-events-none", hiddenBlur(hidden))}
                />
              ) : (
                <span className="absolute left-1/2 top-1/2 -ml-4 -mt-4 h-8 w-8 rounded-full border-2 border-white/80 border-r-transparent animate-spin" />
              )}
              <Watermark email={email} tone="media" />
            </div>
          )}

          {count > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous"
                onClick={() => go(-1)}
                className="absolute left-2 top-1/2 -translate-y-1/2 z-20 h-11 w-11 rounded-full bg-black/50 grid place-items-center hover:bg-black/70"
              >
                <ChevronLeft size={22} />
              </button>
              <button
                type="button"
                aria-label="Next"
                onClick={() => go(1)}
                className="absolute right-2 top-1/2 -translate-y-1/2 z-20 h-11 w-11 rounded-full bg-black/50 grid place-items-center hover:bg-black/70"
              >
                <ChevronRight size={22} />
              </button>
            </>
          )}
        </div>

        {/* Comments */}
        <aside className="lg:w-[380px] lg:shrink-0 lg:border-l lg:border-line bg-surface text-ink flex flex-col lg:min-h-0">
          <div className="px-4 pt-4 pb-2 flex items-baseline gap-2 border-b border-line">
            <h2 className="text-base font-semibold text-ink">Comments</h2>
            {mine.length > 0 && <span className="text-sm text-muted">{mine.length}</span>}
          </div>
          <div className={cn("flex-1 px-4 lg:overflow-y-auto lg:min-h-0", hiddenBlur(hidden))}>
            <CommentList
              comments={mine}
              canEdit={p.open}
              onSeek={isVideo ? seek : undefined}
              onRemove={async (id) => {
                try {
                  await p.onRemove(id);
                } catch (e) {
                  // IdentifyFirst: the page is already switching to the form.
                  if (!(e instanceof IdentifyFirst)) toast.push({ kind: "error", title: (e as Error).message || "Couldn't remove it" });
                }
              }}
            />
          </div>
          {p.open && (
            <div className="sticky bottom-0 shrink-0 border-t border-line bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <Composer
                key={item.id}
                video={isVideo}
                currentTime={time}
                onFocus={() => {
                  if (!isVideo) return;
                  player.current?.pause();
                  setTime(player.current?.time() ?? time);
                }}
                onSubmit={async (body, at) => {
                  try {
                    await p.onAdd(item.id, body, at);
                  } catch (e) {
                    if (!(e instanceof IdentifyFirst)) toast.push({ kind: "error", title: (e as Error).message || "Couldn't add the comment" });
                    throw e;
                  }
                }}
              />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
