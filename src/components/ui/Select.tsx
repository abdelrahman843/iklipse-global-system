import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Menu } from "@/components/ui/Menu";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// Select — the app's dropdown field. Replaces native <select> so every picker
// looks like the rest of the UI (menus, colours, radius) instead of the
// browser's own list. Built on Menu: portal, viewport clamping, flip above,
// arrow keys, Esc. Long lists get a search box; typing a letter jumps to the
// next option that starts with it.
// -----------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
  /** Shown before the label (a colour dot, an avatar...). */
  icon?: ReactNode;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Label when nothing matches `value` (e.g. "Select list…"). */
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** "sm" = 32px (inline rule editors), "md" = 36px (forms). */
  size?: "sm" | "md";
  /** Classes for the outer box: width / flex (e.g. "w-full", "flex-1 sm:flex-none"). */
  className?: string;
  "aria-label"?: string;
  /** Search box on top; defaults to on for more than 10 options. */
  searchable?: boolean;
  align?: "left" | "right";
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  invalid,
  size = "md",
  className,
  "aria-label": ariaLabel,
  searchable,
  align,
}: SelectProps) {
  const current = options.find((o) => o.value === value);
  const field = cn(
    "w-full min-w-0 inline-flex items-center gap-2 rounded-md border bg-surface text-left text-ink outline-none",
    "transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring",
    "disabled:bg-inset disabled:cursor-not-allowed disabled:text-muted",
    size === "sm" ? "h-8 px-2 text-sm" : "h-9 px-3 text-sm",
    invalid ? "border-danger" : "border-border hover:border-rule",
  );
  const shown = (
    <>
      {current?.icon && <span className="shrink-0 inline-flex">{current.icon}</span>}
      <span className={cn("flex-1 min-w-0 truncate", !current && "text-subtle")}>{current?.label ?? placeholder}</span>
      <ChevronDown size={14} className="shrink-0 text-subtle" aria-hidden />
    </>
  );

  if (disabled) {
    return (
      <div className={cn("inline-block", className)}>
        <button type="button" disabled className={field} aria-label={ariaLabel}>
          {shown}
        </button>
      </div>
    );
  }

  return (
    <Menu
      className={className}
      matchWidth
      align={align}
      trigger={
        <button type="button" className={field} aria-label={ariaLabel}>
          {shown}
        </button>
      }
    >
      {(close) => (
        <OptionList
          options={options}
          value={value}
          searchable={searchable ?? options.length > 10}
          onPick={(v) => {
            close();
            if (v !== value) onChange(v);
          }}
        />
      )}
    </Menu>
  );
}

function OptionList({
  options,
  value,
  searchable,
  onPick,
}: {
  options: SelectOption[];
  value: string;
  searchable: boolean;
  onPick: (v: string) => void;
}) {
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? options.filter((o) => o.label.toLowerCase().includes(t)) : options;
  }, [options, q]);

  // Open on the current choice (focused + scrolled into view), like a native select.
  useEffect(() => {
    const el =
      listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      listRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, []);

  // Type-ahead: a letter jumps to the next option starting with it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const k = e.key.toLowerCase();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
    const hit = order.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(k));
    if (hit) {
      e.preventDefault();
      hit.focus();
      hit.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div ref={listRef} role="none" onKeyDown={onKeyDown}>
      {searchable && (
        <div className="px-2 pt-1 pb-1.5 border-b border-line mb-1">
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 h-8 transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
            <Search size={13} className="text-subtle shrink-0" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) {
                  e.preventDefault();
                  onPick(shown[0].value);
                }
              }}
              placeholder="Search"
              aria-label="Search options"
              // 16px on phones so focusing it doesn't zoom the page on iOS.
              className="flex-1 min-w-0 bg-transparent outline-none text-lg sm:text-sm text-ink placeholder:text-subtle"
            />
          </div>
        </div>
      )}
      {shown.length === 0 && <div className="px-3 py-2 text-sm text-subtle">No matches</div>}
      {shown.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={on}
            onClick={() => onPick(o.value)}
            className={cn(
              "w-full flex items-center gap-2 px-3 py-1.5 [@media(pointer:coarse)]:py-2.5 text-left text-sm transition-colors duration-100",
              "hover:bg-inset focus-visible:bg-inset outline-none",
              on ? "text-ink font-medium" : "text-ink",
            )}
          >
            {o.icon && <span className="shrink-0 inline-flex">{o.icon}</span>}
            <span className="flex-1 min-w-0 truncate">{o.label}</span>
            <Check size={14} className={cn("shrink-0 text-accent", !on && "invisible")} aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
