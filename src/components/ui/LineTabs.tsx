import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { SLIDE } from "@/lib/motion";

// -----------------------------------------------------------------------------
// The page tabs under a page title (Users page style): plain labels on a line,
// the open one underlined in the accent. Many tabs scroll sideways on a phone.
// `bare` leaves the line to the parent, when filters share the row.
// -----------------------------------------------------------------------------

export interface LineTab<T extends string> {
  value: T;
  label: string;
  /** Shorter label for phones. */
  short?: string;
  icon?: ReactNode;
  /** A number after the label (hidden when 0 or undefined). */
  count?: number;
}

export function LineTabs<T extends string>({
  value,
  tabs,
  onChange,
  className,
  label,
  bare,
}: {
  value: T;
  tabs: LineTab<T>[];
  onChange: (v: T) => void;
  className?: string;
  /** Accessible name of the tab list. */
  label?: string;
  bare?: boolean;
}) {
  const line = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex gap-1 max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        !bare && "border-b border-border",
        className,
      )}
    >
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => !on && onChange(t.value)}
            className={cn(
              "relative shrink-0 inline-flex items-center gap-1.5 h-10 sm:h-9 px-3 text-sm font-medium whitespace-nowrap transition-colors",
              on ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {t.icon && <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{t.icon}</span>}
            {t.short ? (
              <>
                <span className="hidden sm:inline">{t.label}</span>
                <span className="sm:hidden">{t.short}</span>
              </>
            ) : (
              t.label
            )}
            {!!t.count && <span className="text-xs tabular-nums text-subtle">{t.count}</span>}
            {on && <motion.span layoutId={line} className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" transition={SLIDE} />}
          </button>
        );
      })}
    </div>
  );
}
