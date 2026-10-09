import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// -----------------------------------------------------------------------------
// Tooltips — one app-wide layer that turns every `title="..."` into a styled
// tooltip instead of the browser's slow grey bubble. Mounted once at the root;
// components keep writing plain `title` props.
//  - Mouse: shows after a short pause; moving straight to the next control
//    shows its tooltip at once (like Miro / Figma toolbars).
//  - Keyboard: shows on focus-visible.
//  - Touch: left alone (no hover there).
// While a tooltip is up the element's `title` is parked so the browser's own
// bubble doesn't double it, and put back on leave. An icon-only control whose
// only name was its title keeps that name as aria-label.
// -----------------------------------------------------------------------------

interface Tip {
  text: string;
  x: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** `data-tip-side="right"` on the control (vertical toolbars). */
  side: "auto" | "right";
}

const DELAY = 450;
const WARM_MS = 500;

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; from: string; right: boolean } | null>(null);

  useEffect(() => {
    let el: HTMLElement | null = null;
    let text = "";
    let timer = 0;
    let watch = 0;
    let lastHide = 0;
    let shown = false;
    // The control just clicked: no tooltip again until the pointer leaves it.
    let quiet: Element | null = null;

    const release = () => {
      // React may have set a new title meanwhile: keep that one.
      if (el && !el.hasAttribute("title")) el.setAttribute("title", text);
      el = null;
    };
    const hide = () => {
      window.clearTimeout(timer);
      window.clearInterval(watch);
      if (shown) lastHide = performance.now();
      shown = false;
      setTip(null);
      release();
    };
    const show = (target: HTMLElement, instant: boolean) => {
      if (target === el) return;
      hide();
      const t = target.getAttribute("title")?.trim();
      if (!t) return;
      el = target;
      text = target.getAttribute("title")!;
      target.removeAttribute("title");
      if (!target.hasAttribute("aria-label") && !target.hasAttribute("aria-labelledby") && !target.textContent?.trim()) {
        target.setAttribute("aria-label", t);
      }
      const open = () => {
        if (!el?.isConnected) return hide();
        const r = el.getBoundingClientRect();
        shown = true;
        const side = el.closest("[data-tip-side]")?.getAttribute("data-tip-side") === "right" && window.innerWidth >= 768 ? "right" : "auto";
        setTip({ text: t, x: r.left + r.width / 2, top: r.top, bottom: r.bottom, left: r.left, right: r.right, side });
        // The control can vanish under a still mouse (a menu closing): drop the tip then.
        watch = window.setInterval(() => {
          if (!el?.isConnected) hide();
        }, 250);
      };
      if (instant || performance.now() - lastHide < WARM_MS) open();
      else timer = window.setTimeout(open, DELAY);
    };
    const targetOf = (n: EventTarget | null) => {
      const t = (n as Element | null)?.closest?.("[title]") as HTMLElement | null;
      // Frames and SVG use `title` for accessibility, not as a hint.
      if (!t || t.tagName === "IFRAME" || t instanceof SVGElement) return null;
      return t;
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      // Dragging (cards, canvas items): no hints.
      if (e.buttons) return hide();
      const node = e.target as Node;
      if (el?.contains(node)) return;
      if (quiet?.contains(node)) return;
      quiet = null;
      const t = targetOf(e.target);
      if (!t) return hide();
      show(t, false);
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) hide(); // left the window
    };
    const onFocus = (e: FocusEvent) => {
      const t = targetOf(e.target);
      if (t && t === e.target && t.matches(":focus-visible")) show(t, true);
    };
    const onDown = (e: PointerEvent) => {
      quiet = el ?? targetOf(e.target);
      hide();
    };
    const onBlur = (e: FocusEvent) => {
      if (el && e.target === el) hide();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", onBlur, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("wheel", hide, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", onBlur, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Above the control, or below when there's no room; kept inside the window.
  useLayoutEffect(() => {
    if (!tip) return setPlace(null);
    const box = boxRef.current;
    const w = box?.offsetWidth ?? 0;
    const h = box?.offsetHeight ?? 0;
    if (tip.side === "right") {
      const mid = (tip.top + tip.bottom) / 2;
      setPlace({ left: tip.right + 8, top: Math.max(4, mid - h / 2), from: "-3px", right: true });
      return;
    }
    const below = tip.top - h - 8 < 4;
    const left = Math.max(8 + w / 2, Math.min(tip.x, window.innerWidth - 8 - w / 2));
    setPlace({ left, top: below ? tip.bottom + 6 : tip.top - h - 6, from: below ? "-3px" : "3px", right: false });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={boxRef}
      role="tooltip"
      className={place ? (place.right ? "tip tip-right" : "tip") : undefined}
      style={{
        position: "fixed",
        left: place?.left ?? -9999,
        top: place?.top ?? -9999,
        transform: place?.right ? undefined : "translateX(-50%)",
        ["--tip-from" as string]: place?.from ?? "3px",
        zIndex: 300,
        pointerEvents: "none",
        maxWidth: "min(18rem, calc(100vw - 16px))",
      }}
    >
      <div className="rounded-md bg-ink text-bg text-xs font-medium leading-snug px-2 py-1 shadow-pop whitespace-pre-line [overflow-wrap:anywhere]">
        {tip.text}
      </div>
    </div>,
    document.body,
  );
}
