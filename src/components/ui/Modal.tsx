import { useEffect, useId, useRef, type ReactNode } from "react";
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
  // Accessible name for dialogs that render no visible title.
  label?: string;
}

const sizes = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  "2xl": "max-w-6xl",
};

// Open modals, innermost last. Only the top one reacts to Esc / Tab, so a
// confirm dialog stacked over the card modal closes on its own.
const openStack: object[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement) {
  // Only rendered controls: `hidden` / breakpoint-hidden ones can't take focus.
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

export function Modal({ open, onClose, title, children, footer, size = "md", hideClose, fitViewport, label }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Latest onClose without re-running the open effect on every render (callers
  // pass inline closures, and re-running would steal focus back each time).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = {};
    openStack.push(token);
    const isTop = () => openStack[openStack.length - 1] === token;

    // Remember who had focus so it can be restored on close, then move focus
    // into the panel unless a child already grabbed it (autoFocus inputs).
    const prevFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (!isTop()) return;
      // An inner popover / editor that handled Esc marks it handled first.
      if (e.key === "Escape" && !e.defaultPrevented) {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const active = document.activeElement as HTMLElement | null;
      // Focus inside a portaled popover (menu, picker) manages itself.
      if (active && !panel.contains(active) && active !== document.body && active.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!active || !panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
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
      const i = openStack.indexOf(token);
      if (i >= 0) openStack.splice(i, 1);
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPad;
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") {
        prevFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;

  // Phones: the panel never outgrows the screen. The overlay keeps clear of
  // the notch / home indicator and the panel caps at the space left, with its
  // body scrolling between a fixed header and footer (the keyboard opening
  // can't push them away). sm+ keeps the centred panel; a long default modal
  // scrolls the overlay with its header / footer sticky (overflow-clip keeps
  // the rounded corners without breaking sticky).
  const panel = (
    <div
      className={cn(
        "relative w-full bg-surface rounded-lg shadow-pop border border-border overflow-hidden animate-scale-in outline-none",
        sizes[size],
        fitViewport
          ? "flex flex-col max-h-full"
          : "max-sm:flex max-sm:flex-col max-sm:max-h-full sm:supports-[overflow:clip]:overflow-clip",
      )}
      onClick={(e) => e.stopPropagation()}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={!title ? label : undefined}
    >
      {(title || !hideClose) && (
        <div
          className={cn(
            "flex items-start justify-between gap-3 px-3 sm:px-5 py-3 sm:py-4 border-b border-line bg-surface/95 backdrop-blur rounded-t-lg z-10",
            fitViewport ? "shrink-0" : "shrink-0 sticky top-0",
          )}
        >
          <div id={titleId} className="min-w-0 text-lg font-semibold text-ink [overflow-wrap:anywhere]">{title}</div>
          {!hideClose && (
            <button
              aria-label="Close"
              onClick={onClose}
              className="h-10 w-10 -m-1 sm:m-0 sm:h-8 sm:w-8 shrink-0 grid place-items-center rounded-md text-muted hover:bg-inset hover:text-ink transition-colors duration-150"
            >
              <X size={18} />
            </button>
          )}
        </div>
      )}

      {fitViewport ? (
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      ) : (
        <div className="px-3 sm:px-5 py-3 sm:py-4 max-sm:flex-1 max-sm:min-h-0 max-sm:overflow-y-auto max-sm:overscroll-contain">
          {children}
        </div>
      )}

      {footer && (
        <div
          className={cn(
            "px-3 sm:px-5 py-3 border-t border-line bg-surface rounded-b-lg flex flex-wrap items-center justify-end gap-2 z-10",
            fitViewport ? "shrink-0" : "shrink-0 sticky bottom-0",
          )}
        >
          {footer}
        </div>
      )}
    </div>
  );

  // fitViewport: overlay is a non-scrolling flex centering box, panel caps its
  // own height (max-h-full of the fixed overlay = the dynamic viewport minus
  // gutters / safe areas) and scrolls internally. Default: overlay scrolls the
  // whole panel (sm+). Portaled to <body> so no transformed / overflow-clipped
  // ancestor can trap the fixed overlay inside part of the page.
  if (fitViewport) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 bg-black/50 animate-fade-in flex items-start sm:items-center justify-center safe-pad [--gutter:0.5rem] sm:[--gutter:1rem] md:[--gutter:1.5rem]"
        onClick={onClose}
      >
        {panel}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="flex min-h-full max-sm:h-full items-start justify-center safe-pad [--gutter:0.5rem] sm:[--gutter:1rem] md:[--gutter:2rem]">
        {panel}
      </div>
    </div>,
    document.body,
  );
}
