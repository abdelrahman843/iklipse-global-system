/** @type {import('tailwindcss').Config} */
// -----------------------------------------------------------------------------
// Orderful adaptation — industrial command deck.
// One accent only (vermillion #e42b0c) reserved for filled action surfaces.
// Achromatic slate ramp on vellum canvas. Universal 8px radius. Inter type.
// Semantic Tailwind names are preserved so callers keep writing `bg-accent`,
// `text-ink`, `border-border`, etc.
// -----------------------------------------------------------------------------
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // --------------------------------------------------------------------
        // Semantic tokens now resolve to CSS variables (RGB channel triples in
        // src/index.css) so the whole system themes centrally. Dark is the
        // default; :root[data-theme="light"] overrides. The `rgb(... / <alpha>)`
        // form keeps every `bg-ink/40`-style opacity utility working.
        // --------------------------------------------------------------------
        bg: "rgb(var(--c-bg) / <alpha-value>)",
        column: "rgb(var(--c-column) / <alpha-value>)",
        surface: "rgb(var(--c-surface) / <alpha-value>)",
        inset: "rgb(var(--c-inset) / <alpha-value>)",
        border: "rgb(var(--c-border) / <alpha-value>)",
        line: "rgb(var(--c-line) / <alpha-value>)",
        rule: "rgb(var(--c-rule) / <alpha-value>)",
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        subtle: "rgb(var(--c-subtle) / <alpha-value>)",
        smoke: "rgb(var(--c-smoke) / <alpha-value>)",
        accent: {
          DEFAULT: "rgb(var(--c-accent) / <alpha-value>)",
          hover: "rgb(var(--c-accent-hover) / <alpha-value>)",
          soft: "rgb(var(--c-accent-soft) / <alpha-value>)",
          ring: "rgb(var(--c-accent-ring) / <alpha-value>)",
        },
        pebble: "rgb(var(--c-pebble) / <alpha-value>)",
        success: "rgb(var(--c-success) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
        danger: "rgb(var(--c-danger) / <alpha-value>)",
      },
      fontFamily: {
        // Inter as the Telegraf substitute — single family across every context.
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      borderRadius: {
        // Universal 8px radius across the system.
        sm: "8px",
        md: "8px",
        lg: "8px",
        xl: "8px",
        full: "9999px",
      },
      boxShadow: {
        // Real elevation so paper stands off vellum. `card` is the resting
        // state, `pop` is elevated (hover / floating panel), `raise` is a
        // dedicated hover-lift for grid tiles.
        card: "0 1px 2px rgb(var(--c-shadow) / 0.06), 0 1px 3px rgb(var(--c-shadow) / 0.04)",
        pop:  "0 4px 10px rgb(var(--c-shadow) / 0.08), 0 2px 4px rgb(var(--c-shadow) / 0.06)",
        raise:"0 10px 20px rgb(var(--c-shadow) / 0.10), 0 4px 8px rgb(var(--c-shadow) / 0.06)",
      },
      fontSize: {
        xs: ["11px", { lineHeight: "1.4" }],
        sm: ["12px", { lineHeight: "1.4" }],
        base: ["14px", { lineHeight: "1.43" }],
        md: ["14px", { lineHeight: "1.43" }],
        lg: ["16px", { lineHeight: "1.4" }],
        xl: ["20px", { lineHeight: "1.3" }],
        "2xl": ["28px", { lineHeight: "1.2" }],
        "3xl": ["36px", { lineHeight: "1.15" }],
      },
      letterSpacing: {
        eyebrow: "0.3px",
        display: "-0.025em",
      },
      spacing: {
        "112": "112px",
        "128": "128px",
        "240": "240px",
      },
      maxWidth: {
        page: "1200px",
      },
      // -----------------------------------------------------------------------
      // Motion — restrained. Nothing bigger than 12px of travel, nothing
      // longer than 240ms. The system should feel snappy, not theatrical.
      // -----------------------------------------------------------------------
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "fade-out": {
          "0%": { opacity: "1" },
          "100%": { opacity: "0" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "translateY(4px) scale(0.98)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slide-down": {
          "0%": { opacity: "0", transform: "translateY(-6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "toast-in": {
          "0%": { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        "toast-out": {
          "0%": { opacity: "1", transform: "translateX(0)" },
          "100%": { opacity: "0", transform: "translateX(12px)" },
        },
        "page-fade": {
          "0%": { opacity: "0", transform: "translateY(3px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 140ms ease-out",
        "fade-out": "fade-out 140ms ease-in",
        "scale-in": "scale-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up": "slide-up 180ms ease-out",
        "slide-down": "slide-down 180ms ease-out",
        "toast-in": "toast-in 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        "toast-out": "toast-out 160ms ease-in forwards",
        "page-fade": "page-fade 180ms ease-out",
      },
      transitionTimingFunction: {
        pop: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
