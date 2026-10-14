import { useId, type ReactNode } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { SLIDE } from "@/lib/motion";

// -----------------------------------------------------------------------------
// Center's tab switch (its Services page: WhatsApp / Google Contacts): a pill
// holding the tabs, the open one filled in ink. Equal shares of the row on a
// phone so short and long labels read as one control; from sm up each tab
// takes its natural width. Each tab can say how many things it holds.
// -----------------------------------------------------------------------------

export interface PillTab<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** A number after the label (hidden when 0 or undefined). */
  count?: number;
}

export function PillTabs<T extends string>({
  value,
  tabs,
  onChange,
  className,
  label,
  scroll,
}: {
  value: T;
  tabs: PillTab<T>[];
  onChange: (v: T) => void;
  className?: string;
  /** Accessible name of the tab list. */
  label?: string;
  /** Many tabs: on a phone they keep their width and the row scrolls sideways. */
  scroll?: boolean;
}) {
  const pill = useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "gap-1 rounded-full border border-border bg-surface p-1 shadow-card sm:flex sm:w-fit",
        scroll ? "flex max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "grid",
        className,
      )}
      style={scroll ? undefined : { gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
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
              "relative flex items-center justify-center gap-2 rounded-full px-3 py-2 text-[13px] font-semibold transition-colors duration-150 sm:px-4",
              scroll ? "shrink-0" : "min-w-0",
              on ? "text-bg" : "text-muted hover:bg-inset hover:text-ink",
            )}
          >
            {on && <motion.span layoutId={pill} className="absolute inset-0 rounded-full bg-ink" transition={SLIDE} />}
            {t.icon && <span className="relative shrink-0 [&>svg]:h-4 [&>svg]:w-4">{t.icon}</span>}
            <span className="relative truncate">{t.label}</span>
            {!!t.count && (
              <span
                className={cn(
                  "relative shrink-0 min-w-[1.25rem] rounded-full px-1.5 text-[11px] leading-5 tabular-nums",
                  on ? "bg-bg/15 text-bg" : "bg-inset text-subtle",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
