import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

interface MenuProps {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  /** Classes for the wrapper around the trigger (e.g. "w-full" for a field). */
  className?: string;
  /** Dropdown at least as wide as the trigger (select fields). */
  matchWidth?: boolean;
}

// -----------------------------------------------------------------------------
// Menu — the dropdown is rendered in a portal on document.body with fixed
// positioning measured from the trigger. This is what keeps it from being
// clipped when the trigger lives inside an `overflow-hidden` ancestor such as
// the card modal (Trello-style: popovers float above everything). It clamps to
// the viewport and flips above the trigger when there isn't room below.
// Keyboard: opening focuses the first item, arrows / Home / End move between
// items, Esc or picking an item hands focus back to the trigger.
// -----------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open menus, innermost last. A menu can open from inside another (a select
// in the filters panel): only the top one answers Esc.
const openStack: symbol[] = [];

const triggerButton = (root: HTMLElement | null) => root?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
// Focusable and actually rendered (skips `hidden` / breakpoint-hidden controls).
const focusablesIn = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);

export function Menu({ trigger, children, align = "left", className, matchWidth }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth?: number } | null>(null);
  const id = useRef(Symbol("menu"));

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4;
    const minWidth = matchWidth ? Math.min(Math.max(r.width, 160), window.innerWidth - 16) : undefined;
    const menuW = Math.max(menuRef.current?.offsetWidth ?? 200, minWidth ?? 0);
    const menuH = menuRef.current?.offsetHeight ?? 0;

    let left = align === "right" ? r.right - menuW : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));

    let top = r.bottom + gap;
    if (menuH && top + menuH > window.innerHeight - 8 && r.top - gap - menuH > 8) {
      top = r.top - gap - menuH; // flip above when it would overflow the bottom
    }
    setPos({ top, left, minWidth });
  };

  // Close and hand focus back to the trigger (Esc, or an item was picked). An
  // outside click closes without moving focus, since the user went elsewhere.
  const close = () => {
    setOpen(false);
    const active = document.activeElement;
    if (!active || active === document.body || menuRef.current?.contains(active)) {
      triggerButton(triggerRef.current)?.focus({ preventScroll: true });
    }
  };

  useLayoutEffect(() => {
    if (open) place();
    // The trigger is caller-supplied markup, so its popup state is set here.
    const btn = triggerButton(triggerRef.current);
    if (btn) {
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", String(open));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Move focus into the menu on open, unless something inside already took it.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    // Prefer a button/item: focusing a text field would pop the phone keyboard.
    const all = focusablesIn(menu);
    const first = all.find((el) => !el.matches("input, textarea, select, [contenteditable='true']")) ?? menu;
    first.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const me = id.current;
    openStack.push(me);
    const onPointer = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      // A click inside a menu opened from this one isn't "outside".
      if ((e.target as Element | null)?.closest?.("[data-menu-popover]")) return;
      setOpen(false);
    };
    // Esc closes only the innermost menu, not the modal it sits in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (openStack[openStack.length - 1] !== me) return;
        e.preventDefault();
        close();
        return;
      }
      const menu = menuRef.current;
      const target = e.target as HTMLElement | null;
      if (!menu || !target || !menu.contains(target)) return;
      // Text, date and number fields use arrows / Home / End themselves.
      const typing =
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type));
      if (e.key === "Tab") {
        // Keep Tab inside the floating menu; it lives in a portal at the end of <body>.
        const all = focusablesIn(menu);
        if (all.length === 0) return;
        const i = all.indexOf(target);
        const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i === -1 || i === all.length - 1 ? 0 : i + 1;
        e.preventDefault();
        all[next].focus();
        return;
      }
      if (typing) return;
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      // Menu items, plus whatever else is focusable (pickers mix in inputs).
      const items = focusablesIn(menu);
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(target);
      let next = 0;
      if (e.key === "End") next = items.length - 1;
      else if (e.key === "ArrowDown") next = i === -1 || i === items.length - 1 ? 0 : i + 1;
      else if (e.key === "ArrowUp") next = i <= 0 ? items.length - 1 : i - 1;
      items[next].focus();
    };
    const reposition = () => place();
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      const i = openStack.lastIndexOf(me);
      if (i >= 0) openStack.splice(i, 1);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className={cn("relative inline-block", className)} ref={triggerRef}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            data-menu-popover=""
            style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, minWidth: pos?.minWidth }}
            className={cn(
              "z-[200] outline-none min-w-[180px] max-w-[calc(100vw-1rem)] max-h-[min(70vh,32rem)] rounded-md border border-border bg-surface shadow-pop py-1 overflow-x-hidden overflow-y-auto",
              "animate-menu-in origin-top",
            )}
            role="menu"
            tabIndex={-1}
          >
            {children(close)}
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
