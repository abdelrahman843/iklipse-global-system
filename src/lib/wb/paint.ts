import { cssColor } from "./types";

// -----------------------------------------------------------------------------
// Canvas 2D can't read CSS variables, so the theme colours ("ink", "surface",
// rgb(var(--c-ink)) from textOn) are resolved to plain rgb() strings here.
// One palette per draw: it reads the variables once and caches them.
// -----------------------------------------------------------------------------

const FALLBACK: Record<string, string> = {
  "--c-bg": "234, 237, 241",
  "--c-surface": "255, 255, 255",
  "--c-inset": "242, 244, 247",
  "--c-border": "201, 208, 218",
  "--c-rule": "179, 188, 201",
  "--c-ink": "11, 18, 32",
  "--c-muted": "51, 65, 85",
  "--c-subtle": "100, 116, 139",
  "--c-accent": "228, 43, 12",
  "--c-success": "6, 95, 70",
  "--c-danger": "228, 43, 12",
  "--c-shadow": "15, 23, 42",
};

export interface Palette {
  /** Stored colour token ("ink", "#f5cd47", "none"...) as a canvas colour, null when transparent. */
  token: (c: string | null | undefined, fallback?: string) => string | null;
  /** Any CSS colour string, with var(--x) resolved. */
  css: (c: string) => string;
  /** A theme variable (e.g. "--c-ink") as rgb() / rgba(). */
  theme: (name: string, alpha?: number) => string;
}

export function createPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const cache = new Map<string, string>();
  const channels = (name: string) => {
    let v = cache.get(name);
    if (v == null) {
      const parts = cs.getPropertyValue(name).trim().split(/[\s,/]+/).filter(Boolean).slice(0, 3);
      v = parts.length === 3 ? parts.join(", ") : (FALLBACK[name] ?? "128, 128, 128");
      cache.set(name, v);
    }
    return v;
  };
  const css = (c: string) => c.replace(/var\((--[\w-]+)\)/g, (_m, n: string) => channels(n));
  return {
    css,
    token: (c, fallback) => {
      const v = cssColor(c, fallback ?? "transparent");
      return v === "transparent" ? null : css(v);
    },
    theme: (name, alpha = 1) => (alpha < 1 ? `rgba(${channels(name)}, ${alpha})` : `rgb(${channels(name)})`),
  };
}
