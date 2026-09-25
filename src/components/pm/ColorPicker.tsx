import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Menu } from "@/components/ui/Menu";

// -----------------------------------------------------------------------------
// Shared color palette + picker for card covers and list accents. Values are the
// hex strings stored in card.cover_color / list.color. These are rich/deep tones
// (Trello "bold" style) so a full-fill card or list reads with white text.
// -----------------------------------------------------------------------------

export const BOARD_COLORS: { name: string; value: string }[] = [
  { name: "Green", value: "#1f845a" },
  { name: "Yellow", value: "#946f00" },
  { name: "Orange", value: "#a54800" },
  { name: "Red", value: "#ae2e24" },
  { name: "Purple", value: "#5e4db2" },
  { name: "Blue", value: "#0055cc" },
  { name: "Sky", value: "#206a83" },
  { name: "Lime", value: "#4c6b1f" },
  { name: "Pink", value: "#943d73" },
  { name: "Slate", value: "#44546f" },
];

// Pick a legible foreground for a given background: white on dark colors, deep
// navy on light ones. Keeps both the rich palette above and any older/pastel
// stored colors readable.
export function readableText(hex: string): string {
  const c = hex.replace("#", "");
  const h = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return "#ffffff";
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.62 ? "#172b4d" : "#ffffff";
}

// A translucent veil matching the foreground — used for hairlines, count chips
// and hover fills drawn on top of a colored surface.
export function overlay(fg: string, alpha = 0.15): string {
  return fg === "#ffffff" ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
}

interface Props {
  value: string | null;
  onChange: (color: string | null) => void;
  trigger: ReactNode;
  align?: "left" | "right";
}

// A grid of swatches inside a portal menu. Reused wherever something takes a
// color (card cover, list accent). Picking a swatch or "No color" closes it.
export function ColorPickerMenu({ value, onChange, trigger, align = "left" }: Props) {
  return (
    <Menu align={align} trigger={trigger}>
      {(close) => (
        <div className="w-56 max-w-[calc(100vw-2rem)] p-2">
          <div className="grid grid-cols-5 gap-1.5">
            {BOARD_COLORS.map((c) => {
              const on = value === c.value;
              return (
                <button
                  key={c.value}
                  type="button"
                  title={c.name}
                  aria-label={c.name}
                  onClick={() => {
                    onChange(c.value);
                    close();
                  }}
                  className="relative h-8 rounded-md ring-1 ring-border transition-transform hover:scale-105"
                  style={{ background: c.value }}
                >
                  {on && (
                    <Check size={16} className="absolute inset-0 m-auto" style={{ color: readableText(c.value) }} />
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              close();
            }}
            className="mt-2 w-full rounded-md border border-border px-2 py-1.5 text-sm text-muted hover:bg-inset hover:text-ink transition-colors"
          >
            No color
          </button>
        </div>
      )}
    </Menu>
  );
}
