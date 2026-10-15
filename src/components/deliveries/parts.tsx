import { useMemo, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { File as FileIcon, FileText, Film, Image as ImageIcon, Link2, Play } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  STATE_LABEL,
  clock,
  teamFileUrls,
  type DeliveryComment,
  type DeliveryRound,
  type DeliveryState,
  type DrivePreview,
  type ItemKind,
  type MediaLinks,
} from "@/lib/deliveriesApi";

// -----------------------------------------------------------------------------
// Small pieces shared by the Deliveries pages and the project page's
// Deliveries / Feedback tabs: state badge, file previews, headings, comments.
// -----------------------------------------------------------------------------

const STATE_TONE = { open: "accent", submitted: "warn", approved: "success" } as const;

export function StateBadge({ state, className }: { state: DeliveryState; className?: string }) {
  return (
    <Badge tone={STATE_TONE[state]} className={className}>
      {STATE_LABEL[state]}
    </Badge>
  );
}

/** Everything that shows a delivery, refreshed after a change. */
export function useRefreshDeliveries() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["delivery"] });
    void qc.invalidateQueries({ queryKey: ["deliveries"] });
  };
}

const NO_LINKS: MediaLinks = { urls: {}, drive: {} };

/**
 * What shows a delivery's files, both maps by fileKey: signed links (an hour)
 * for uploaded files, and Google's previews for files kept in Drive.
 */
export function useTeamUrls(paths: (string | null | undefined)[]): MediaLinks {
  const key = useMemo(() => [...new Set(paths.filter(Boolean) as string[])].sort(), [paths]);
  const q = useQuery({
    queryKey: ["delivery-urls", key],
    queryFn: () => teamFileUrls(key),
    enabled: key.length > 0,
    staleTime: 45 * 60_000,
    refetchInterval: 50 * 60_000,
    // A new upload changes the key: keep showing the old previews meanwhile.
    placeholderData: keepPreviousData,
  });
  // A copy saved on the device by an older version is a plain map: ignore it.
  return q.data?.urls && q.data.drive ? q.data : NO_LINKS;
}

/** "12 Oct", with the year when it isn't this year. */
export function day(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
}

export function fileSize(n: number | null | undefined): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "Link";
  } catch {
    return "Link";
  }
};

export function KindIcon({ kind, mime, size = 16, className }: { kind: ItemKind; mime?: string | null; size?: number; className?: string }) {
  const Icon = kind === "link" ? Link2 : kind === "image" ? ImageIcon : kind === "video" ? Film : mime === "application/pdf" ? FileText : FileIcon;
  return <Icon size={size} className={className} />;
}

/**
 * A file's preview: the picture, the video's first frame, or its icon. A file
 * kept in Drive shows Google's small still (a frame for a video) instead.
 */
export function Thumb({
  item,
  url,
  drive,
  className,
  iconSize = 20,
}: {
  item: { kind: ItemKind; name: string; mime_type: string | null };
  url: string | null | undefined;
  drive?: DrivePreview | null;
  className?: string;
  iconSize?: number;
}) {
  // Google has no still for this one (yet): show the icon, not a broken picture.
  const [broken, setBroken] = useState<string | null>(null);
  const media = item.kind === "image" || item.kind === "video";
  const still = drive && media && drive.thumb !== broken ? drive.thumb : null;
  const play = (
    <span className="relative grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white">
      <Play size={14} className="ml-0.5" fill="currentColor" />
    </span>
  );
  return (
    <span className={cn("relative grid place-items-center overflow-hidden rounded-lg bg-inset text-muted", className)}>
      {still ? (
        <>
          <img
            src={still}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBroken(still)}
            className={cn("absolute inset-0 h-full w-full object-cover", item.kind === "video" && "bg-black")}
          />
          {item.kind === "video" && play}
        </>
      ) : !drive && url && item.kind === "image" ? (
        <img src={url} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      ) : !drive && url && item.kind === "video" ? (
        <>
          <video src={`${url}#t=0.1`} preload="metadata" muted playsInline className="absolute inset-0 h-full w-full object-cover bg-black" />
          {play}
        </>
      ) : (
        <KindIcon kind={item.kind} mime={item.mime_type} size={iconSize} />
      )}
    </span>
  );
}

/** A section's heading: readable size, a hairline under it, an action on the right. */
export function Heading({ title, count, action, className }: { title: ReactNode; count?: number; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 min-h-9 pb-2 mb-1 border-b border-rule", className)}>
      <h2 className="text-base font-semibold text-ink inline-flex items-center gap-2 min-w-0">
        <span className="truncate">{title}</span>
        {!!count && <span className="text-sm font-medium text-subtle tabular-nums">{count}</span>}
      </h2>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** What happened in a round, in a few words. */
export function roundSummary(r: DeliveryRound): string {
  const who = r.submitted_name || "The client";
  if (r.outcome === "approved") return `Approved by ${who}${r.submitted_at ? ` · ${day(r.submitted_at)}` : ""}`;
  if (r.outcome === "feedback") return `Feedback from ${who}${r.submitted_at ? ` · ${day(r.submitted_at)}` : ""}`;
  return r.closed_at ? `Closed without feedback · ${day(r.closed_at)}` : "Waiting for the client";
}

/** One comment: who, when, the video moment, the text and the resolved tick. */
export function CommentRow({
  c,
  onSeek,
  onResolve,
  busy,
}: {
  c: DeliveryComment;
  /** Videos: jump the player to the comment's moment. */
  onSeek?: (seconds: number) => void;
  /** Ticking resolved; left out where it can't change. */
  onResolve?: (resolved: boolean) => void;
  busy?: boolean;
}) {
  const resolved = !!c.resolved_at;
  return (
    <div className="flex gap-3 py-3">
      <Avatar src={c.author_avatar} name={c.author_name || "?"} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-medium text-ink">{c.author_name}</span>
          {c.guest ? <span className="text-xs text-accent">Client</span> : <span className="text-xs text-subtle">Team</span>}
          <span className="text-xs text-subtle">{relativeTime(c.created_at)}</span>
          {c.at_seconds != null &&
            (onSeek ? (
              <button
                type="button"
                onClick={() => onSeek(c.at_seconds!)}
                className="rounded-full bg-accent-soft px-2 py-px text-xs font-medium text-accent tabular-nums hover:bg-accent hover:text-white transition-colors"
                title="Play from here"
              >
                at {clock(c.at_seconds)}
              </button>
            ) : (
              <span className="rounded-full bg-inset px-2 py-px text-xs font-medium text-muted tabular-nums">at {clock(c.at_seconds)}</span>
            ))}
        </div>
        <p className={cn("mt-0.5 text-base whitespace-pre-wrap break-words leading-relaxed", resolved ? "text-muted line-through decoration-line" : "text-ink")}>{c.body}</p>
        {resolved && c.resolved_by_name && <div className="mt-0.5 text-xs text-success">Resolved by {c.resolved_by_name}</div>}
      </div>
      {onResolve ? (
        <label className="shrink-0 inline-flex items-start gap-1.5 pt-0.5 text-xs text-muted cursor-pointer select-none" title={resolved ? "Mark not resolved" : "Mark resolved"}>
          <input
            type="checkbox"
            checked={resolved}
            disabled={busy}
            onChange={(e) => onResolve(e.target.checked)}
            className="mt-px h-4 w-4 accent-[rgb(var(--c-success))] cursor-pointer"
          />
          <span className="hidden sm:inline">Resolved</span>
        </label>
      ) : (
        resolved && <span className="shrink-0 text-xs text-success pt-0.5">Resolved</span>
      )}
    </div>
  );
}
