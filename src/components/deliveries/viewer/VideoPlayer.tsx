import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Download, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { clock } from "@/lib/deliveriesApi";
import { cn } from "@/lib/cn";
import { HiddenNotice, Watermark, hiddenBlur, useProtection } from "./Protection";

// -----------------------------------------------------------------------------
// The delivery's own video player: no native controls (so no download / speed /
// picture-in-picture menus), comment markers on the seek bar, and full screen
// of the whole player box so the watermark stays on top of the picture.
// -----------------------------------------------------------------------------

export interface PlayerHandle {
  pause: () => void;
  /** Jump to a second and stop there. */
  seek: (t: number) => void;
  time: () => number;
  box: () => HTMLDivElement | null;
}

export interface Marker {
  id: string;
  at: number;
  text: string;
}

interface Props {
  src: string | undefined;
  markers: Marker[];
  onError: () => void;
  /** Current second, on every time update and seek. */
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  canDownload?: boolean;
  onDownload?: () => void;
}

/** Fresh links asked for one video after it failed, before giving up. */
const MAX_RENEWS = 2;
/** Stuck loading this long: the link may have run out, ask for a new one. */
const STALL_MS = 5000;

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };

const fsElement = () => document.fullscreenElement ?? (document as FsDoc).webkitFullscreenElement ?? null;

export const VideoPlayer = forwardRef<PlayerHandle, Props>(function VideoPlayer({ src, markers, onError, onTime, onDuration, canDownload, onDownload }, ref) {
  const { hidden } = useProtection();
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const lastTime = useRef(0);
  // Keep the link the video started with until it fails: swapping a working
  // source would restart playback. A failed (expired) one is swapped and the
  // video carries on from the same second.
  const [activeSrc, setActiveSrc] = useState(src);
  const broken = useRef(false);
  const wantPlay = useRef(false);
  /** Where to carry on once a renewed link has loaded (taken when it failed,
   *  because loading a new source resets the time to 0 first). */
  const resume = useRef<{ t: number; play: boolean } | null>(null);
  const fails = useRef(0);
  const [cantPlay, setCantPlay] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [fs, setFs] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const canFs =
    typeof document !== "undefined" &&
    !!(document.fullscreenEnabled || (document.documentElement as FsEl).webkitRequestFullscreen);

  const seekTo = useCallback((t: number) => {
    const v = video.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : t;
    v.currentTime = Math.max(0, Math.min(t, d));
    setCur(v.currentTime);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      pause: () => video.current?.pause(),
      seek: (t) => {
        video.current?.pause();
        seekTo(t);
      },
      time: () => video.current?.currentTime ?? 0,
      box: () => box.current,
    }),
    [seekTo],
  );

  useEffect(() => {
    if (!src) return;
    setActiveSrc((cur) => {
      if (!cur || broken.current) {
        broken.current = false;
        return src;
      }
      return cur;
    });
  }, [src]);

  // The link failed or stalled: take note of where we were, then use a fresher
  // link if the page already has one, or ask for one (the page limits how often).
  const renew = (countFail: boolean) => {
    if (!activeSrc || cantPlay) return;
    if (countFail && ++fails.current > MAX_RENEWS) {
      setCantPlay(true);
      return;
    }
    const v = video.current;
    if (!resume.current) resume.current = { t: lastTime.current, play: wantPlay.current || (!!v && !v.paused) };
    if (src && src !== activeSrc) {
      broken.current = false;
      setActiveSrc(src);
      return;
    }
    broken.current = true;
    onError();
  };
  const renewRef = useRef(renew);
  renewRef.current = renew;

  useEffect(() => {
    if (!waiting || !activeSrc) return;
    const t = window.setTimeout(() => renewRef.current(false), STALL_MS);
    return () => window.clearTimeout(t);
  }, [waiting, activeSrc]);

  useEffect(() => {
    const on = () => setFs(fsElement() === box.current);
    document.addEventListener("fullscreenchange", on);
    document.addEventListener("webkitfullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      document.removeEventListener("webkitfullscreenchange", on);
    };
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v || !activeSrc) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  const toggleFs = () => {
    const el = box.current as FsEl | null;
    if (!el) return;
    if (fsElement()) {
      const d = document as FsDoc;
      void (document.exitFullscreen ? document.exitFullscreen() : d.webkitExitFullscreen?.())?.catch?.(() => undefined);
    } else {
      void (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.())?.catch?.(() => undefined);
    }
  };

  const fromPointer = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || !dur) return;
    seekTo(((clientX - r.left) / r.width) * dur);
  };

  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;

  return (
    <div
      ref={box}
      data-no-swipe-video
      className="relative h-full w-full bg-black text-white overflow-hidden select-none"
      onContextMenu={(e) => e.preventDefault()}
    >
      <video
        ref={video}
        src={activeSrc}
        className={cn("absolute inset-0 h-full w-full object-contain", hiddenBlur(hidden))}
        preload="metadata"
        playsInline
        controls={false}
        draggable={false}
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload noplaybackrate noremoteplayback"
        onClick={toggle}
        onPlay={() => {
          wantPlay.current = true;
          setPlaying(true);
        }}
        onPause={() => {
          wantPlay.current = false;
          setPlaying(false);
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => {
          setWaiting(false);
          // Playing fine again (a stall that recovered on its own, or the
          // renewed link): nothing to carry over, and failures count afresh.
          fails.current = 0;
          resume.current = null;
          broken.current = false;
        }}
        onCanPlay={() => setWaiting(false)}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          setDur(v.duration || 0);
          onDuration?.(v.duration || 0);
          // A renewed link: carry on from the same second, playing if it was.
          const r = resume.current;
          resume.current = null;
          if (r) {
            if (r.t > 0) v.currentTime = r.t;
            setCur(r.t);
            if (r.play) void v.play().catch(() => undefined);
          }
        }}
        onTimeUpdate={(e) => {
          // Loading a renewed link reports 0 first; keep the real position.
          if (resume.current) return;
          const t = e.currentTarget.currentTime;
          lastTime.current = t;
          setCur(t);
          onTime?.(t);
        }}
        onSeeked={(e) => !resume.current && onTime?.(e.currentTarget.currentTime)}
        onVolumeChange={(e) => {
          setVolume(e.currentTarget.volume);
          setMuted(e.currentTarget.muted);
        }}
        onError={() => {
          setWaiting(false);
          renew(true);
        }}
      />

      {/* Watermark sits over the picture, under the controls. */}
      <Watermark />

      {!playing && activeSrc && !hidden && !cantPlay && (
        <button
          type="button"
          aria-label="Play"
          onClick={toggle}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-16 w-16 rounded-full bg-black/55 grid place-items-center hover:bg-black/70 transition-colors"
        >
          <Play size={28} className="translate-x-0.5" fill="currentColor" />
        </button>
      )}
      {(waiting || !activeSrc) && !cantPlay && (
        <span className="absolute left-1/2 top-1/2 -ml-4 -mt-4 h-8 w-8 rounded-full border-2 border-white/80 border-r-transparent animate-spin pointer-events-none" />
      )}

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 z-10 px-3 pt-8 pb-2 bg-gradient-to-t from-black/80 via-black/40 to-transparent">
        <div
          ref={bar}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(dur)}
          aria-valuenow={Math.round(cur)}
          tabIndex={0}
          className="group relative h-5 flex items-center cursor-pointer touch-none"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("[data-marker]")) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            fromPointer(e.clientX);
          }}
          onPointerMove={(e) => dragging && fromPointer(e.clientX)}
          onPointerUp={(e) => {
            setDragging(false);
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={(e) => {
            setDragging(false);
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onLostPointerCapture={() => setDragging(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              e.stopPropagation();
              seekTo(cur + (e.key === "ArrowRight" ? 5 : -5));
            }
          }}
        >
          <div className="relative h-1 w-full rounded-full bg-white/25 group-hover:h-1.5 transition-[height]">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <span
            className="absolute top-1/2 h-3 w-3 -ml-1.5 -mt-1.5 rounded-full bg-white shadow pointer-events-none"
            style={{ left: `${pct}%` }}
          />
          {dur > 0 &&
            markers.map((m) => (
              <button
                key={m.id}
                type="button"
                data-marker
                aria-label={`Comment at ${clock(m.at)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  video.current?.pause();
                  seekTo(m.at);
                }}
                className="group/m absolute top-1/2 -translate-y-1/2 -ml-2 h-5 w-4 grid place-items-center"
                style={{ left: `${Math.min(100, (m.at / dur) * 100)}%` }}
              >
                <span className="h-2.5 w-1 rounded-full bg-warn ring-1 ring-black/40" />
                <span className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 hidden group-hover/m:block w-max max-w-[220px] rounded-md bg-black/90 px-2 py-1 text-left text-sm text-white">
                  <span className="font-semibold tabular-nums">{clock(m.at)}</span>{" "}
                  <span className="text-white/80 [overflow-wrap:anywhere] whitespace-normal">{m.text}</span>
                </span>
              </button>
            ))}
        </div>

        <div className="mt-1 flex items-center gap-1">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={toggle}
            className="h-9 w-9 grid place-items-center rounded-md hover:bg-white/10"
          >
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
          </button>
          <button
            type="button"
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            onClick={() => {
              const v = video.current;
              if (!v) return;
              v.muted = !v.muted;
              if (!v.muted && v.volume === 0) v.volume = 0.6;
            }}
            className="h-9 w-9 grid place-items-center rounded-md hover:bg-white/10"
          >
            {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(e) => {
              const v = video.current;
              if (!v) return;
              v.volume = Number(e.target.value);
              v.muted = v.volume === 0;
            }}
            className="hidden sm:block w-20 accent-white"
          />
          <span className="ml-2 text-sm tabular-nums text-white/90">
            {clock(cur)} / {clock(dur)}
          </span>
          <span className="flex-1" />
          {canFs && (
            <button
              type="button"
              aria-label={fs ? "Exit full screen" : "Full screen"}
              onClick={toggleFs}
              className="h-9 w-9 grid place-items-center rounded-md hover:bg-white/10"
            >
              {fs ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          )}
        </div>
      </div>

      {cantPlay && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-black px-4 text-center">
          <div>
            <p className="text-base font-semibold text-white">Can't play this file here</p>
            {canDownload && onDownload ? (
              <button
                type="button"
                onClick={onDownload}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-md bg-white/10 px-3 text-base font-medium text-white hover:bg-white/20"
              >
                <Download size={16} />
                Download
              </button>
            ) : (
              <p className="mt-1 text-sm text-white/60">Try again later, or ask the team for another format.</p>
            )}
          </div>
        </div>
      )}

      {/* In full screen the page's own notice is not visible, so repeat it here. */}
      {hidden && fs && <HiddenNotice className="absolute z-20" />}
    </div>
  );
});
