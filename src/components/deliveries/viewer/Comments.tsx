import { useState } from "react";
import { Clock, MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { clock, parseClock, type VisitorComment } from "@/lib/deliveriesApi";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// The comments on one image or video, and the box to add one. On a video the
// box pins the comment to the second the video was paused at ("At 3:05"); on
// a Drive video (Google's player, which keeps its time to itself) the client
// types the moment in.
// -----------------------------------------------------------------------------

export function CommentList({
  comments,
  canEdit,
  onSeek,
  onRemove,
}: {
  comments: VisitorComment[];
  canEdit: boolean;
  onSeek?: (t: number) => void;
  onRemove: (id: string) => Promise<void>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);

  if (!comments.length) {
    return (
      <div className="py-8 text-center">
        <MessageSquare size={20} className="mx-auto text-subtle" />
        <p className="mt-2 text-base text-muted">No comments yet.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {comments.map((c) => {
        const team = !c.guest;
        return (
          <li key={c.id} className={cn("py-3", team && "border-l-2 border-l-accent pl-3")}>
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  "h-6 w-6 shrink-0 rounded-full grid place-items-center text-xs font-semibold",
                  team ? "bg-accent text-white" : "bg-inset text-ink",
                )}
                aria-hidden
              >
                {(team ? "i" : c.author.trim()[0] || "?").toUpperCase()}
              </span>
              <span className="text-base font-semibold text-ink truncate min-w-0">{c.author}</span>
              {team && <span className="shrink-0 text-xs font-medium text-accent">iklipse team</span>}
              {c.mine && <span className="shrink-0 rounded-full bg-inset px-1.5 text-xs font-medium text-muted">You</span>}
              <span className="ml-auto shrink-0 text-sm text-subtle">{relativeTime(c.created_at)}</span>
            </div>
            <div className="mt-1.5 pl-8 text-base text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">
              {c.at_seconds != null &&
                (onSeek ? (
                  <button
                    type="button"
                    onClick={() => onSeek(c.at_seconds!)}
                    className="mr-1.5 inline-flex items-center rounded-sm bg-accent-soft px-1.5 text-sm font-semibold tabular-nums text-accent hover:underline align-[1px]"
                    aria-label={`Go to ${clock(c.at_seconds)}`}
                  >
                    {clock(c.at_seconds)}
                  </button>
                ) : (
                  // Google's preview of a Drive video: the page can't move it.
                  <span className="mr-1.5 inline-flex items-center rounded-sm bg-accent-soft px-1.5 text-sm font-semibold tabular-nums text-accent align-[1px]">
                    {clock(c.at_seconds)}
                  </span>
                ))}
              {c.body}
            </div>
            {(c.resolved || (c.mine && canEdit)) && (
              <div className="mt-1 pl-8 flex items-center gap-3 text-sm">
                {c.resolved && <span className="text-success">Done by the team</span>}
                {c.mine && canEdit && (
                  <button
                    type="button"
                    disabled={removing === c.id}
                    onClick={async () => {
                      setRemoving(c.id);
                      try {
                        await onRemove(c.id);
                      } finally {
                        setRemoving(null);
                      }
                    }}
                    className="text-muted hover:text-danger disabled:opacity-50"
                  >
                    {removing === c.id ? "Removing..." : "Remove"}
                  </button>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "At" a moment typed by hand (m:ss or h:mm:ss), for a video whose player
 * can't tell the page its time (Google's preview of a Drive file). Empty is
 * fine: no time. Read it with parseClock.
 */
export function AtField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const bad = parseClock(value) === undefined;
  return (
    <label className="inline-flex items-center gap-1.5 text-sm font-medium text-muted" title="The moment in the video, like 1:05">
      <Clock size={12} />
      At
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0:00"
        maxLength={9}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={bad || undefined}
        className={cn(
          "h-7 w-[4.5rem] rounded-md border bg-surface px-2 text-lg sm:text-base font-normal tabular-nums text-ink placeholder:text-subtle outline-none focus:border-accent",
          bad ? "border-danger" : "border-border",
        )}
      />
    </label>
  );
}

export function Composer({
  video,
  currentTime,
  typedTime,
  onFocus,
  onSubmit,
}: {
  video: boolean;
  /** The video's current second (live). */
  currentTime: number;
  /** The player can't tell its time (Google's preview): the moment is typed in. */
  typedTime?: boolean;
  /** Composing started: the viewer pauses the video. */
  onFocus: () => void;
  onSubmit: (body: string, at: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [noTime, setNoTime] = useState(false);
  const [atText, setAtText] = useState("");
  const [busy, setBusy] = useState(false);
  const composing = focused || draft.trim() !== "";
  const typed = video && typedTime ? parseClock(atText) : null;
  const badTime = typed === undefined;
  const at = video && typedTime ? typed ?? null : video && composing && !noTime ? currentTime : null;

  const send = async () => {
    const body = draft.trim();
    if (!body || busy || badTime) return;
    setBusy(true);
    try {
      await onSubmit(body, at);
      setDraft("");
      setNoTime(false);
      setAtText("");
    } catch {
      /* the viewer shows the error; keep the text */
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {video && typedTime ? (
        <div className="flex items-center gap-2 text-sm">
          <AtField value={atText} onChange={setAtText} />
          <span className={badTime ? "text-danger" : "text-subtle"}>{badTime ? "Write it like 1:05" : "Optional"}</span>
        </div>
      ) : video && composing && (
        <div className="flex items-center gap-2 text-sm">
          {at != null ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft pl-2 pr-1 h-6 font-semibold text-accent tabular-nums">
              <Clock size={12} />
              At {clock(at)}
              <button
                type="button"
                aria-label="Comment without a time"
                // Keep the box focused while clicking the chip.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setNoTime(true)}
                className="h-5 w-5 grid place-items-center rounded-full hover:bg-accent/15"
              >
                <X size={12} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setNoTime(false)}
              className="inline-flex items-center gap-1 rounded-full border border-border px-2 h-6 text-muted hover:text-ink"
            >
              <Clock size={12} />
              Add the time
            </button>
          )}
          {at != null && <span className="text-subtle">Move the video to change it</span>}
        </div>
      )}
      <Textarea
        rows={2}
        value={draft}
        maxLength={4000}
        placeholder={video ? "Comment on this moment..." : "Write a comment..."}
        className="resize-none max-h-40"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          setFocused(true);
          onFocus();
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="hidden sm:inline text-sm text-subtle">Ctrl + Enter to send</span>
        <Button type="submit" variant="primary" size="md" loading={busy} disabled={!draft.trim() || badTime} className="ml-auto">
          Comment
        </Button>
      </div>
    </form>
  );
}
