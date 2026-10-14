import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EyeOff } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Content protection for the client delivery page.
//
// Be honest about what this is: a web page cannot stop an operating system
// screenshot, a screen recorder or a phone camera. Everything here is a
// deterrent that makes casual copying harder and every leak traceable:
//  - a moving watermark with the viewer's email over the page and the media,
//  - the content blurs while the window is not in front (switching apps, the
//    Windows snipping tool, the mouse leaving the window on desktop),
//  - screenshot / print / save / devtools shortcuts hide the content for a
//    moment and empty the clipboard where the browser lets us,
//  - right click, drag, copy and text selection are off outside the inputs,
//  - printing prints a notice instead of the page.
// -----------------------------------------------------------------------------

interface Ctx {
  /** The content should be hidden right now. */
  hidden: boolean;
  /** Who is looking: printed into the watermark. */
  email: string;
}
const ProtectionCtx = createContext<Ctx>({ hidden: false, email: "" });
export const useProtection = () => useContext(ProtectionCtx);

const FLASH_MS = 2000;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Inputs keep normal text behaviour (typing, selecting, pasting). */
const editable = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, [data-allow-select]");

function clearClipboard() {
  try {
    void navigator.clipboard?.writeText("").catch(() => undefined);
  } catch {
    /* not allowed here */
  }
}

/** True for the shortcuts people use to grab, print, save or inspect a page. */
function grabShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "PrintScreen" || e.key === "F12") return true;
  // macOS screenshots: Cmd+Shift+3/4/5 (the OS usually takes these first).
  if (e.metaKey && e.shiftKey && /^Digit[345]$/.test(e.code)) return true;
  if (mod && (k === "p" || k === "s" || k === "u")) return true;
  if (mod && e.shiftKey && (k === "i" || k === "j" || k === "c")) return true;
  if (e.metaKey && e.altKey && (k === "i" || k === "j" || k === "c" || e.code === "KeyI" || e.code === "KeyJ" || e.code === "KeyC")) return true;
  // Windows key on Windows: Win+Shift+S (snipping tool) starts with it.
  if (!isMac && e.key === "Meta") return true;
  return false;
}

export function ProtectionProvider({ email, children }: { email: string; children: ReactNode }) {
  const [away, setAway] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number>();
  const hidden = away || flash;

  const hideBriefly = useCallback(() => {
    setFlash(true);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(false), FLASH_MS);
  }, []);

  useEffect(() => {
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const onVisibility = () => setAway(document.visibilityState === "hidden");
    const onBlur = () => setAway(true);
    const onFocus = () => setAway(document.visibilityState === "hidden");
    // Mouse leaving the window (desktop only; touch has no hover).
    const onOut = (e: MouseEvent) => {
      if (fine.matches && !e.relatedTarget) setAway(true);
    };
    const onOver = () => {
      if (fine.matches && document.hasFocus()) setAway(document.visibilityState === "hidden");
    };
    const onKey = (e: KeyboardEvent) => {
      if (!grabShortcut(e)) return;
      // Typing in a comment box: Ctrl+C / Ctrl+S style keys still blocked, but
      // only the real grab keys hide the page.
      e.preventDefault();
      hideBriefly();
      clearClipboard();
    };
    const block = (e: Event) => {
      if (!editable(e.target)) e.preventDefault();
    };
    const onCopy = (e: ClipboardEvent) => {
      if (editable(e.target)) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", "");
    };
    const onPrint = () => hideBriefly();

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mouseover", onOver);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    document.addEventListener("contextmenu", block);
    document.addEventListener("dragstart", block);
    document.addEventListener("selectstart", block);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    window.addEventListener("beforeprint", onPrint);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mouseover", onOver);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      document.removeEventListener("contextmenu", block);
      document.removeEventListener("dragstart", block);
      document.removeEventListener("selectstart", block);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      window.removeEventListener("beforeprint", onPrint);
      window.clearTimeout(flashTimer.current);
    };
  }, [hideBriefly]);

  // Nothing keeps playing behind the blur.
  useEffect(() => {
    if (hidden) document.querySelectorAll("video").forEach((v) => v.pause());
  }, [hidden]);

  return (
    <ProtectionCtx.Provider value={{ hidden, email }}>
      <ProtectionStyles />
      {children}
      {/* Above everything on the page, dialogs included; clicks pass through. */}
      <div className="fixed inset-0 z-[90] pointer-events-none overflow-hidden" aria-hidden>
        <Watermark email={email} tone="page" />
      </div>
      {hidden && <HiddenNotice className="fixed z-[95]" />}
    </ProtectionCtx.Provider>
  );
}

/** "Content hidden" over the page (or over the player in full screen). */
export function HiddenNotice({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "inset-0 grid place-items-center bg-bg/80 backdrop-blur-2xl text-center px-4 animate-fade-in",
        className,
      )}
    >
      <div>
        <EyeOff size={28} className="mx-auto text-muted" />
        <p className="mt-3 text-lg font-semibold text-ink">Content hidden</p>
        <p className="mt-1 text-base text-muted">Come back to this window to keep viewing.</p>
      </div>
    </div>
  );
}

/** The class that blurs a block while the page is hidden. */
export const hiddenBlur = (hidden: boolean) => (hidden ? "dv-hidden" : "");

// ------------------------------------------------------------------ styles --
function ProtectionStyles() {
  return (
    <style>{`
@keyframes dv-wm-drift {
  0%   { transform: translate3d(0, 0, 0) rotate(-28deg); }
  25%  { transform: translate3d(3%, 2%, 0) rotate(-21deg); }
  50%  { transform: translate3d(0, 3%, 0) rotate(-15deg); }
  75%  { transform: translate3d(-3%, 1%, 0) rotate(-22deg); }
  100% { transform: translate3d(0, 0, 0) rotate(-28deg); }
}
.dv-wm-layer { position: absolute; left: 50%; top: 50%; animation: dv-wm-drift 52s linear infinite; }
.dv-wm-tag { transition: opacity .35s ease; }
.dv-protect { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.dv-protect input, .dv-protect textarea, .dv-protect [data-allow-select] { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.dv-protect img, .dv-protect video { -webkit-user-drag: none; -webkit-touch-callout: none; }
.dv-hidden { filter: blur(24px); transition: filter .12s ease; }
@media print {
  html, body { background: #fff !important; }
  body > * { display: none !important; }
  body::before {
    content: "Printing is turned off";
    display: block; padding: 40vh 0 0; text-align: center;
    font: 600 20px/1.4 Inter, system-ui, sans-serif; color: #111;
  }
}
`}</style>
  );
}

// --------------------------------------------------------------- watermark --
/**
 * Tiled "iklipse · email · date" on a square layer a little bigger than the
 * box's diagonal, so it covers the box at any angle while it slowly turns and
 * drifts (dv-wm-drift). A second small tag jumps somewhere new every few
 * seconds. Render it inside whatever goes full screen, so it stays on top.
 */
export function Watermark({ email, tone }: { email: string; tone: "page" | "media" }) {
  const box = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState(0);
  const pid = `wm-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const date = format(new Date(), "MMM d, yyyy");
  const text = `iklipse  ·  ${email}  ·  ${date}`;
  // Rough text width at 13px; the tile is the text plus some air.
  const tileW = Math.max(260, Math.round(text.length * 7.2) + 90);
  const tileH = 130;

  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const measure = () => setSide(Math.ceil(Math.hypot(el.clientWidth, el.clientHeight) * 1.12));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const media = tone === "media";
  return (
    <div ref={box} className="absolute inset-0 overflow-hidden pointer-events-none select-none" aria-hidden>
      {side > 0 && (
        <div className="dv-wm-layer" style={{ width: side, height: side, marginLeft: -side / 2, marginTop: -side / 2 }}>
          <svg width={side} height={side} className={media ? "text-white" : "text-ink"} style={{ opacity: media ? 0.24 : 0.13 }}>
            <defs>
              <pattern id={pid} width={tileW} height={tileH} patternUnits="userSpaceOnUse">
                {[
                  [12, 40],
                  [12 + tileW / 2, 40 + tileH / 2],
                  [12 - tileW / 2, 40 + tileH / 2],
                ].map(([x, y], i) => (
                  <text
                    key={i}
                    x={x}
                    y={y}
                    fill="currentColor"
                    stroke={media ? "rgba(0,0,0,0.55)" : "none"}
                    strokeWidth={media ? 2 : 0}
                    paintOrder="stroke"
                    fontFamily="Inter, system-ui, sans-serif"
                    fontSize={13}
                    fontWeight={600}
                  >
                    {text}
                  </text>
                ))}
              </pattern>
            </defs>
            <rect width={side} height={side} fill={`url(#${pid})`} />
          </svg>
        </div>
      )}
      <FloatingTag email={email} media={media} />
    </div>
  );
}

function FloatingTag({ email, media }: { email: string; media: boolean }) {
  const pick = () => ({ x: 4 + Math.random() * 62, y: 6 + Math.random() * 80, r: -12 + Math.random() * 24 });
  const [pos, setPos] = useState(pick);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    let fade = 0;
    const t = window.setInterval(() => {
      setShown(false);
      fade = window.setTimeout(() => {
        setPos(pick());
        setShown(true);
      }, 350);
    }, 3500);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(fade);
    };
  }, []);
  return (
    <span
      className={cn(
        "dv-wm-tag absolute whitespace-nowrap rounded-sm px-2 py-0.5 text-sm font-semibold",
        media ? "bg-black/35 text-white" : "bg-ink/10 text-ink",
      )}
      style={{
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transform: `rotate(${pos.r}deg)`,
        opacity: shown ? (media ? 0.55 : 0.32) : 0,
      }}
    >
      iklipse · {email}
    </span>
  );
}
