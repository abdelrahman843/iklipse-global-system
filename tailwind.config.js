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
        bg: "#f5f5f5",         // vellum — page background
        surface: "#ffffff",    // paper — card surface (also inset field)
        inset: "#f5f5f5",      // recessed fields — same vellum
        border: "#e5e7eb",     // frost — hairlines
        line: "#e5e7eb",       // internal splits
        rule: "#d4d4d4",       // cloud — button/input borders
        ink: "#101828",        // slate-900 — display / headings
        muted: "#4a5565",      // slate-600 — body copy, eyebrow
        subtle: "#99a1af",     // mist — muted labels, placeholder
        smoke: "#676767",      // steel — tertiary/warning tone
        accent: {
          DEFAULT: "#e42b0c",  // vermillion — filled primary action, active state
          hover: "#c62309",    // slightly darker for hover
          soft: "#fdece8",     // softest vermillion tint — active surfaces only
          ring: "#e42b0c",     // focus outline reuses the accent
        },
        pebble: "#d4d4d4",
        success: "#101828",    // Orderful discipline: no second saturated colour
        warn: "#676767",
        danger: "#e42b0c",
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
        card: "rgba(0, 0, 0, 0.10) 0 1px 3px 0, rgba(0, 0, 0, 0.10) 0 1px 2px -1px",
        pop: "rgba(0, 0, 0, 0.10) 0 1px 3px 0, rgba(0, 0, 0, 0.10) 0 1px 2px -1px",
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
