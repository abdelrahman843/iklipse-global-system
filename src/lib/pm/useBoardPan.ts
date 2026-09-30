import { useEffect } from "react";

// -----------------------------------------------------------------------------
// Mouse-friendly horizontal scrolling for the board canvas (laptop / desktop):
//  - The wheel scrolls the board sideways, except over a list that can still
//    scroll its cards in that direction (that list scrolls instead). Trackpad
//    sideways swipes and Ctrl+wheel zoom are left to the browser.
//  - Pressing and dragging on the empty board background pans it, like Trello.
// Touch and pen are untouched (only pointerType "mouse" pans, and touch sends
// no wheel events): phones and tablets keep their native swipe scrolling.
// -----------------------------------------------------------------------------

const INTERACTIVE = "button, a, input, textarea, select, label, [contenteditable='true'], [role='button']";

/** Nearest element between `from` and `root` that can scroll vertically by `dy`. */
function verticalScroller(from: Element | null, root: Element, dy: number) {
  for (let el = from; el && el !== root; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll") continue;
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return el;
  }
  return null;
}

/** Pass the scroll container element (a callback-ref state), or null. */
export function useBoardPan(el: HTMLElement | null) {
  useEffect(() => {
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.defaultPrevented) return;
      if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // already sideways (trackpad / shift+wheel)
      if (el.scrollWidth <= el.clientWidth) return;
      if (verticalScroller(e.target as Element, el, e.deltaY)) return;
      const step = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY;
      el.scrollLeft += step;
      e.preventDefault();
    };

    let drag: { x: number; left: number; id: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      const t = e.target as HTMLElement;
      // Only the bare background: the canvas itself or the row that holds the lists.
      if (t !== el && t.parentElement !== el) return;
      if (t.closest(INTERACTIVE)) return;
      drag = { x: e.clientX, left: el.scrollLeft, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
      el.style.userSelect = "none";
      // Any list snapping would fight the drag; it resumes on release.
      el.style.scrollSnapType = "none";
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      el.scrollLeft = drag.left - (e.clientX - drag.x);
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.style.cursor = "";
      el.style.userSelect = "";
      el.style.scrollSnapType = "";
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }, [el]);
}
