import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  hideClose?: boolean;
}

const sizes = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({ open, onClose, title, children, footer, size = "md", hideClose }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    // Overlay itself scrolls — a Trello-style card modal is a document, so we
    // let the entire panel move inside the viewport instead of chopping it
    // into a fixed header + inner scroll pane. `items-start` + `min-h-full`
    // keeps a tall panel top-aligned; a short one still floats near the top.
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-ink/40 animate-fade-in"
      onClick={onClose}
    >
      <div className="flex min-h-full items-start justify-center p-2 sm:p-4 md:p-8">
        <div
          className={cn(
            "relative w-full bg-surface rounded-lg shadow-pop border border-border overflow-hidden",
            "animate-scale-in",
            sizes[size],
          )}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
        >
          {(title || !hideClose) && (
            <div className="flex items-start justify-between gap-3 px-3 sm:px-5 py-3 sm:py-4 border-b border-line sticky top-0 bg-surface/95 backdrop-blur rounded-t-lg z-10">
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
          <div className="px-3 sm:px-5 py-3 sm:py-4">{children}</div>
          {footer && (
            <div className="px-3 sm:px-5 py-3 border-t border-line bg-surface rounded-b-lg flex items-center justify-end gap-2 sticky bottom-0 z-10">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
