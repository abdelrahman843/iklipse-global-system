import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "2xl";
  hideClose?: boolean;
  // When set, the panel is height-capped to the viewport and its body becomes a
  // flex column that owns its own scrolling — the overlay / page never scrolls.
  // The card modal uses this so each pane inside scrolls independently.
  fitViewport?: boolean;
}

const sizes = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
};

export function Modal({ open, onClose, title, children, footer, size = "md", hideClose, fitViewport }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock background scroll. Compensate for the removed scrollbar width with
    // right-padding so the page behind doesn't jump sideways for a frame — that
    // lateral jump is the "shake" seen the instant a modal opens.
    const scrollBarW = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = document.body.style.overflow;
    const prevPad = document.body.style.paddingRight;
    document.body.style.overflow = "hidden";
    if (scrollBarW > 0) document.body.style.paddingRight = `${scrollBarW}px`;
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
    };
  }, [open, onClose]);

  if (!open) return null;

  const panel = (
    <div
      className={cn(
        "relative w-full bg-surface rounded-lg shadow-pop border border-border overflow-hidden animate-scale-in",
        sizes[size],
        fitViewport &&
          "flex flex-col max-h-[calc(100dvh-1rem)] sm:max-h-[calc(100dvh-2rem)] md:max-h-[calc(100dvh-3rem)]",
      )}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
    >
      {(title || !hideClose) && (
        <div
          className={cn(
            "flex items-start justify-between gap-3 px-3 sm:px-5 py-3 sm:py-4 border-b border-line bg-surface/95 backdrop-blur rounded-t-lg z-10",
            fitViewport ? "shrink-0" : "sticky top-0",
          )}
        >
          <div className="text-lg font-semibold text-ink">{title}</div>
          {!hideClose && (
            <button
              aria-label="Close"
              onClick={onClose}
              className="rounded-md p-1 text-subtle hover:bg-inset hover:text-ink transition-colors duration-150"
            >
              <X size={18} />
            </button>
          )}
        </div>
      )}

      {fitViewport ? (
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      ) : (
        <div className="px-3 sm:px-5 py-3 sm:py-4">{children}</div>
      )}

      {footer && (
        <div
          className={cn(
            "px-3 sm:px-5 py-3 border-t border-line bg-surface rounded-b-lg flex items-center justify-end gap-2 z-10",
            fitViewport ? "shrink-0" : "sticky bottom-0",
          )}
        >
          {footer}
        </div>
      )}
    </div>
  );

  // fitViewport: overlay is a non-scrolling flex centering box, panel caps its
  // own height and scrolls internally. Default: overlay scrolls the whole panel.
  // Portaled to <body> so no transformed / overflow-clipped ancestor can trap
  // the fixed overlay inside part of the page.
  if (fitViewport) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in flex items-start sm:items-center justify-center p-2 sm:p-4 md:p-6"
        onClick={onClose}
      >
        {panel}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="flex min-h-full items-start justify-center p-2 sm:p-4 md:p-8">{panel}</div>
    </div>,
    document.body,
  );
}
