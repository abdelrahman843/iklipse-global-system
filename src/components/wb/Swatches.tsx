import { Check, Ban } from "lucide-react";
import { cn } from "@/lib/cn";
import { ALL_COLORS, COLOR_NAMES, cssColor, textOn, LIGHT_COLORS, DEEP_COLORS } from "@/lib/wb/types";

/** Colour grid used by the toolbars (system palette only). */
export function Swatches({
  value,
  onChange,
  colors = ALL_COLORS,
  allowNone,
  columns = 6,
  size = 26,
}: {
  value: string | null | undefined;
  onChange: (c: string) => void;
  colors?: readonly string[];
  allowNone?: boolean;
  columns?: number;
  size?: number;
}) {
  const list = allowNone ? ["none", ...colors] : colors;
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns}, ${size}px)` }}>
      {list.map((c) => {
        const on = value === c;
        return (
          <button
            key={c}
            type="button"
            title={COLOR_NAMES[c] ?? c}
            aria-label={COLOR_NAMES[c] ?? c}
            aria-pressed={on}
            onClick={() => onChange(c)}
            className={cn(
              "relative rounded-full ring-1 ring-border grid place-items-center hover:scale-110 transition-transform",
              on && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
            )}
            style={{ width: size, height: size, background: c === "none" ? "transparent" : cssColor(c) }}
          >
            {c === "none" ? <Ban size={14} className="text-subtle" /> : on && <Check size={13} style={{ color: textOn(c) }} />}
          </button>
        );
      })}
    </div>
  );
}

/** Sticky-note colours: light row then deep row. */
export const STICKY_COLORS = [...LIGHT_COLORS, ...DEEP_COLORS, "surface"];
