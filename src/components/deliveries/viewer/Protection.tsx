import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Content protection for the client delivery page.
//
// Be honest about what this is: a web page cannot stop an operating system
// screenshot, a screen recorder or a phone camera. Everything here is a
// deterrent that makes casual copying harder and every leak traceable:
//  - a moving "iklipse" watermark over the video player and over Google's
//    preview of a Drive file (which keeps playing behind the blur: a page
//    can't pause another site's player),
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
  /** Who is looking. */
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
    // Clicking into an embedded player (Google's preview of a Drive file)
    // moves the focus into its frame, which blurs this window: that is not
    // leaving the page. While the focus is in there the window gets no blur
    // of its own, so watch for the whole window losing focus instead (another
    // app, the snipping tool), where the browser can tell.
    const inFrame = () => document.activeElement instanceof HTMLIFrameElement;
    let frameWatch = 0;
    const watchFrame = () => {
      window.clearInterval(frameWatch);
      // A browser that doesn't count focus inside a frame as ours can't tell.
      if (!document.hasFocus()) return;
      let had = true;
      frameWatch = window.setInterval(() => {
        if (!inFrame()) return window.clearInterval(frameWatch);
        const has = document.hasFocus();
        if (has !== had) setAway(!has || document.visibilityState === "hidden");
        had = has;
      }, 400);
    };
    let blurCheck = 0;
    const onBlur = () => {
      if (inFrame()) return watchFrame();
      // Some browsers only point at the frame just after the blur.
      window.clearTimeout(blurCheck);
      blurCheck = window.setTimeout(() => (inFrame() ? watchFrame() : setAway(true)), 0);
    };
    const onFocus = () => setAway(document.visibilityState === "hidden");
    // Mouse leaving the window (desktop only; touch has no hover). Moving onto
    // an embedded frame has no related target either: that only counts when
    // the pointer is really outside the window.
    const onOut = (e: MouseEvent) => {
      if (!fine.matches || e.relatedTarget) return;
      const inside = e.clientX > 0 && e.clientY > 0 && e.clientX < window.innerWidth - 1 && e.clientY < window.innerHeight - 1;
      if (inside && document.elementFromPoint(e.clientX, e.clientY) instanceof HTMLIFrameElement) return;
      setAway(true);
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
      window.clearTimeout(blurCheck);
      window.clearInterval(frameWatch);
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
 * One word, "iklipse", gliding slowly to a new spot over the video every few
 * seconds and turning a little as it goes. Render it inside whatever goes full
 * screen, so it stays on top.
 */
export function Watermark() {
  const pick = () => ({ x: 8 + Math.random() * 64, y: 10 + Math.random() * 72, r: -18 + Math.random() * 36 });
  const [pos, setPos] = useState(pick);
  useEffect(() => {
    const t = window.setInterval(() => setPos(pick()), 4000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none select-none" aria-hidden>
      <span
        className="absolute whitespace-nowrap font-semibold tracking-wide text-white"
        style={{
          left: `${pos.x}%`,
          top: `${pos.y}%`,
          transform: `translate(-50%, -50%) rotate(${pos.r}deg)`,
          transition: "left 3.8s ease-in-out, top 3.8s ease-in-out, transform 3.8s ease-in-out",
          fontSize: "clamp(16px, 2.6vw, 30px)",
          opacity: 0.35,
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
        }}
      >
        iklipse
      </span>
    </div>
  );
}
