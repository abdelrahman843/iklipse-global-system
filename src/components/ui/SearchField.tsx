import { forwardRef, useEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

// -----------------------------------------------------------------------------
// SearchField — the app's one search box. Recessed at rest, lifts to a paper
// surface with a soft accent glow on focus; the icon picks up the accent.
// A clear button fades in once there's text, Esc clears (and blurs when
// already empty), an optional "/" hotkey focuses it from anywhere, and an
// optional spinner / trailing slot sits on the right.
// -----------------------------------------------------------------------------

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "size"> {
  value: string;
  onChange: (value: string) => void;
  /** Focus from anywhere with "/" (only where no other "/" shortcut exists). */
  hotkey?: boolean;
  loading?: boolean;
  /** Extra content on the right, before the clear button (e.g. "3/12"). */
  trailing?: ReactNode;
  size?: "md" | "lg";
  /** Classes for the outer box (width, margins). */
  className?: string;
}

const isTyping = (el: Element | null) =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

export const SearchField = forwardRef<HTMLInputElement, Props>(function SearchField(
  { value, onChange, hotkey, loading, trailing, size = "md", className, onKeyDown, onFocus, onBlur, placeholder = "Search…", ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTyping(document.activeElement)) return;
      // A dialog on top owns the keyboard.
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-exiting] *)')) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  return (
    <div
      className={cn(
        // Same box as every text field (Input): height, border, radius, focus ring.
        // min-h keeps that height when a page stacks it in a column with flex-1
        // (phones), which would otherwise squash it to the text's height.
        "group/search relative flex items-center gap-2 h-11 min-h-11 sm:h-9 sm:min-h-9 rounded-md border border-border bg-surface px-3 cursor-text",
        "transition-[border-color,box-shadow] duration-150",
        "focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring",
        className,
      )}
      onMouseDown={(e) => {
        // Clicking the padding / icon focuses the field too.
        if (e.target !== inputRef.current) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <Search
        size={15}
        aria-hidden
        className="shrink-0 text-subtle transition-[color,transform] duration-200 group-focus-within/search:text-accent group-focus-within/search:scale-110"
      />
      {/* 16px on phones so iOS doesn't zoom in on focus. */}
      <input
        {...rest}
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          if (value) onChange("");
          else inputRef.current?.blur();
        }}
        className={cn(
          "flex-1 min-w-0 h-full bg-transparent outline-none text-ink placeholder:text-subtle text-lg sm:text-base",
          "[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden",
        )}
      />
      {loading && <Spinner size={13} className="text-subtle shrink-0" />}
      {trailing}
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear (Esc)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="-mr-1.5 h-8 w-8 sm:h-6 sm:w-6 shrink-0 grid place-items-center rounded-md text-subtle hover:bg-inset hover:text-ink animate-scale-in"
        >
          <X size={13} />
        </button>
      ) : (
        hotkey && (
          <kbd className="hidden sm:grid group-focus-within/search:!hidden shrink-0 h-5 min-w-5 px-1 place-items-center rounded border border-border bg-surface text-[11px] font-medium text-subtle animate-fade-in">
            /
          </kbd>
        )
      )}
    </div>
  );
});
