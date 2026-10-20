import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// A small (i) next to a label that holds its explanation. With a mouse or the
// keyboard it's the app's usual tooltip (its `title`, see Tooltips.tsx); a tap
// on a phone opens the same bubble under it, and a tap anywhere closes it.
// -----------------------------------------------------------------------------

const HALF = 152; // half the bubble's widest (18rem) plus a margin

export function InfoTip({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const touch = useRef(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const hide = () => setAt(null);
    const outside = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [at]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        title={at ? undefined : text}
        aria-label={text}
        onPointerDown={(e) => (touch.current = e.pointerType !== "mouse")}
        onClick={() => {
          if (!touch.current) return;
          if (at) return setAt(null);
          const r = ref.current!.getBoundingClientRect();
          const mid = r.left + r.width / 2;
          setAt({ left: Math.max(HALF, Math.min(mid, window.innerWidth - HALF)), top: r.bottom + 6 });
        }}
        className={cn(
          "relative inline-grid place-items-center h-4 w-4 shrink-0 rounded-full text-subtle hover:text-ink transition-colors after:absolute after:-inset-2",
          at && "text-ink",
          className,
        )}
      >
        <Info size={14} />
      </button>
      {at &&
        createPortal(
          <div
            role="tooltip"
            className="tip"
            style={{ position: "fixed", left: at.left, top: at.top, transform: "translateX(-50%)", zIndex: 300, width: "max-content", maxWidth: "min(18rem, calc(100vw - 16px))" }}
          >
            <div className="rounded-md bg-ink text-bg text-xs font-medium leading-snug px-2 py-1 shadow-pop whitespace-pre-line [overflow-wrap:anywhere]">{text}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
