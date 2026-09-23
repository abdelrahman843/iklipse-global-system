import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

interface MenuProps {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}

// -----------------------------------------------------------------------------
// Menu — the dropdown is rendered in a portal on document.body with fixed
// positioning measured from the trigger. This is what keeps it from being
// clipped when the trigger lives inside an `overflow-hidden` ancestor such as
// the card modal (Trello-style: popovers float above everything). It clamps to
// the viewport and flips above the trigger when there isn't room below.
// -----------------------------------------------------------------------------

export function Menu({ trigger, children, align = "left" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4;
    const menuW = menuRef.current?.offsetWidth ?? 200;
    const menuH = menuRef.current?.offsetHeight ?? 0;

    let left = align === "right" ? r.right - menuW : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));

    let top = r.bottom + gap;
    if (menuH && top + menuH > window.innerHeight - 8 && r.top - gap - menuH > 8) {
      top = r.top - gap - menuH; // flip above when it would overflow the bottom
    }
    setPos({ top, left });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const reposition = () => place();
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="relative inline-block" ref={triggerRef}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className={cn(
              "z-[200] min-w-[180px] max-w-[calc(100vw-1rem)] max-h-[min(70vh,32rem)] rounded-md border border-border bg-surface shadow-pop py-1 overflow-x-hidden overflow-y-auto",
              "animate-slide-down origin-top",
            )}
            role="menu"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  destructive,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "block w-full text-left px-3 py-1.5 text-sm transition-colors duration-100",
        "hover:bg-inset disabled:opacity-50 disabled:cursor-not-allowed",
        destructive && "text-danger hover:bg-danger/10",
      )}
    >
      {children}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" />;
}
