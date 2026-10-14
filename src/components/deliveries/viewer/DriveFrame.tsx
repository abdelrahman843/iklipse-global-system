import { useEffect, useRef, useState } from "react";
import { Maximize, Minimize } from "lucide-react";
import { cn } from "@/lib/cn";
import { Watermark, hiddenBlur, useProtection } from "./Protection";

// -----------------------------------------------------------------------------
// A file kept in Google Drive, in Google's own preview (it plays a video or
// shows a document; the file is "anyone with the link can view", download
// off). Nothing passes through us, so the page can't read the time or pause
// it. The client's copy gets the watermark over it; it never takes clicks.
// With a watermark, Google's own full screen is off (it would enlarge only the
// frame and leave the watermark behind): our button takes the whole box,
// watermark included, full screen instead.
// -----------------------------------------------------------------------------

/** className places and sizes it ("absolute inset-0", or "relative" with a height). */
export function DriveFrame({ src, title, watermark, className }: { src: string; title: string; watermark?: boolean; className: string }) {
  const { hidden } = useProtection();
  const [loaded, setLoaded] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const canFull = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void box.current?.requestFullscreen().catch(() => undefined);
  };
  return (
    <div ref={box} className={cn("overflow-hidden bg-black", className)} onContextMenu={(e) => e.preventDefault()}>
      {/* Mounted per file (keyed by the caller): a renewed page of links with
          the same src leaves the frame, and what's playing in it, alone. */}
      <iframe
        src={src}
        title={title}
        allow={watermark ? "autoplay" : "autoplay; fullscreen"}
        allowFullScreen={!watermark}
        onLoad={() => setLoaded(true)}
        className={cn("absolute inset-0 h-full w-full border-0", hiddenBlur(hidden))}
      />
      {!loaded && (
        <span className="absolute left-1/2 top-1/2 -ml-4 -mt-4 h-8 w-8 rounded-full border-2 border-white/80 border-r-transparent animate-spin pointer-events-none" />
      )}
      {watermark && <Watermark />}
      {watermark && canFull && (
        <button
          type="button"
          onClick={toggleFull}
          aria-label={full ? "Exit full screen" : "Full screen"}
          title={full ? "Exit full screen" : "Full screen"}
          className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75"
        >
          {full ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      )}
    </div>
  );
}
