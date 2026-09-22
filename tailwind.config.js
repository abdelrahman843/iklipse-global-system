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
        // Contrast ramp — paper (white) sits on a warmer, deeper vellum so
        // elevated surfaces read as elevated instead of blending. Borders and
        // muted text got a nudge darker for readability at scale.
        // --------------------------------------------------------------------
        bg: "#eaedf1",         // deeper vellum — real recess under paper
        surface: "#ffffff",    // paper — card / column / modal
        inset: "#f2f4f7",      // recessed field on white surface
        border: "#c9d0da",     // frost — meaningful hairlines
        line: "#e2e6ec",       // soft internal splits inside a surface
        rule: "#b3bcc9",       // stronger — button / input outline
        ink: "#0b1220",        // near-black display / headings
        muted: "#334155",      // slate-700 — body copy (was too light)
        subtle: "#64748b",     // slate-500 — placeholder / metadata
        smoke: "#475569",      // slate-600 — tertiary
        accent: {
          DEFAULT: "#e42b0c",  // vermillion — filled primary action
          hover: "#c62309",
          soft: "#fdece8",
          ring: "#e42b0c",
        },
        pebble: "#c9d0da",
        success: "#065f46",    // deep emerald — dues completed / positive
        warn: "#b45309",       // burnt amber — soon-due warning
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
        // Real elevation so paper stands off vellum. `card` is the resting
        // state, `pop` is elevated (hover / floating panel), `raise` is a
        // dedicated hover-lift for grid tiles.
        card: "0 1px 2px rgba(15, 23, 42, 0.06), 0 1px 3px rgba(15, 23, 42, 0.04)",
        pop:  "0 4px 10px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.06)",
        raise:"0 10px 20px rgba(15, 23, 42, 0.10), 0 4px 8px rgba(15, 23, 42, 0.06)",
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
