import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface MenuProps {
  trigger: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}

export function Menu({ trigger, children, align = "left" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div
          className={cn(
            "absolute z-40 mt-1 min-w-[180px] rounded-md border border-border bg-white shadow-pop py-1",
            "animate-slide-down origin-top",
            align === "right" ? "right-0" : "left-0",
          )}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
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
        "hover:bg-bg disabled:opacity-50 disabled:cursor-not-allowed",
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
