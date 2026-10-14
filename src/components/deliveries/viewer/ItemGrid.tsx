import { useEffect, useState } from "react";
import { Download, ExternalLink, Image as ImageIcon, Link2, MessageSquare, Play } from "lucide-react";
import { clock, type VisitorItem } from "@/lib/deliveriesApi";
import { cn } from "@/lib/cn";
import { extOf, fileIcon, fileSize, hostOf } from "./util";

// -----------------------------------------------------------------------------
// The delivery as a folder of previews: pictures and video frames as rounded
// thumbnails, files as a big type icon, links as their site. No boxes around
// the tiles, the name sits under the preview.
// -----------------------------------------------------------------------------

interface Props {
  items: VisitorItem[];
  urls: Record<string, string>;
  /** Comment count per item; empty when the round is closed. */
  counts: Record<string, number> | null;
  canDownload: boolean;
  onOpen: (item: VisitorItem) => void;
  onDownload: (id: string) => void;
  onMediaError: (id: string) => void;
}

export function ItemGrid(p: Props) {
  return (
    <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-6">
      {p.items.map((it) => (
        <li key={it.id} className="min-w-0">
          <Tile item={it} {...p} />
        </li>
      ))}
    </ul>
  );
}

function Tile({ item, urls, counts, canDownload, onOpen, onDownload, onMediaError }: Props & { item: VisitorItem }) {
  const url = urls[item.id];
  const media = item.kind === "image" || item.kind === "video";
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  useEffect(() => setFailed(false), [url]);
  const fail = () => {
    setFailed(true);
    onMediaError(item.id);
  };
  const n = counts?.[item.id] ?? 0;

  const preview = (() => {
    if (item.kind === "image") {
      return url && !failed ? (
        <img
          src={url}
          alt={item.name}
          draggable={false}
          loading="lazy"
          decoding="async"
          onError={fail}
          className="h-full w-full object-cover select-none pointer-events-none transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : (
        <Placeholder loading={!url}>
          <ImageIcon size={32} />
        </Placeholder>
      );
    }
    if (item.kind === "video") {
      return (
        <>
          {url && !failed ? (
            <video
              src={`${url}#t=0.5`}
              preload="metadata"
              muted
              playsInline
              draggable={false}
              disablePictureInPicture
              disableRemotePlayback
              controlsList="nodownload noplaybackrate noremoteplayback"
              onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
              onError={fail}
              className="h-full w-full object-cover bg-black pointer-events-none"
            />
          ) : (
            <Placeholder loading={!url} dark />
          )}
          <span className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="h-11 w-11 rounded-full bg-black/55 text-white grid place-items-center transition-transform duration-200 group-hover:scale-110">
              <Play size={18} fill="currentColor" className="translate-x-px" />
            </span>
          </span>
          {duration != null && (
            <span className="absolute right-2 bottom-2 rounded-sm bg-black/70 px-1.5 text-xs font-medium text-white tabular-nums">
              {clock(duration)}
            </span>
          )}
        </>
      );
    }
    if (item.kind === "link") {
      return (
        <Placeholder>
          <Link2 size={36} />
          <span className="mt-2 text-sm font-medium text-muted truncate max-w-[85%]">{hostOf(item.external_url)}</span>
        </Placeholder>
      );
    }
    const Icon = fileIcon(item.name, item.mime_type);
    const ext = extOf(item.name);
    return (
      <Placeholder>
        <Icon size={40} strokeWidth={1.5} />
        {ext && <span className="mt-2 text-xs font-semibold tracking-eyebrow text-muted">{ext}</span>}
      </Placeholder>
    );
  })();

  const badges = (
    <>
      {item.is_new && (
        <span className="absolute left-2 top-2 rounded-full bg-accent px-2 h-5 inline-flex items-center text-xs font-semibold text-white">
          New
        </span>
      )}
      {media && n > 0 && (
        <span className="absolute right-2 top-2 rounded-full bg-black/65 px-2 h-5 inline-flex items-center gap-1 text-xs font-medium text-white tabular-nums">
          <MessageSquare size={11} />
          {n}
        </span>
      )}
    </>
  );

  const meta =
    item.kind === "link"
      ? hostOf(item.external_url)
      : [item.kind === "file" ? fileSize(item.size) : item.kind === "video" ? "Video" : "Image", media && n > 0 ? `${n} comment${n === 1 ? "" : "s"}` : ""]
          .filter(Boolean)
          .join(" · ");

  const frame = (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-inset" onContextMenu={(e) => e.preventDefault()}>
      {preview}
      {badges}
    </div>
  );

  const caption = (
    <div className="mt-2 flex items-start gap-1.5 min-w-0">
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-ink truncate" title={item.name}>
          {item.name}
        </div>
        {meta && <div className="text-sm text-muted truncate">{meta}</div>}
      </div>
      {item.kind === "link" && <ExternalLink size={14} className="mt-1 shrink-0 text-subtle" />}
    </div>
  );

  if (item.kind === "link" && item.external_url) {
    return (
      <a href={item.external_url} target="_blank" rel="noopener noreferrer" className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
        {frame}
        {caption}
      </a>
    );
  }

  if (media) {
    return (
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="group block w-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        {frame}
        {caption}
      </button>
    );
  }

  // Files: no preview in the browser; a download when the link allows it.
  return (
    <div className="group">
      {canDownload ? (
        <button
          type="button"
          onClick={() => onDownload(item.id)}
          className="relative block w-full text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          {frame}
          <span className="absolute right-2 bottom-2 h-8 w-8 rounded-full bg-surface text-ink grid place-items-center shadow-pop opacity-90 group-hover:opacity-100">
            <Download size={15} />
          </span>
        </button>
      ) : (
        frame
      )}
      {caption}
    </div>
  );
}

function Placeholder({ children, loading, dark }: { children?: React.ReactNode; loading?: boolean; dark?: boolean }) {
  return (
    <div className={cn("h-full w-full flex flex-col items-center justify-center", dark ? "bg-black text-white/60" : "text-subtle")}>
      {loading ? <span className="h-6 w-6 rounded-full border-2 border-current border-r-transparent animate-spin opacity-60" /> : children}
    </div>
  );
}
