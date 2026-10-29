import { setMeasure } from "./text";
import type { DesignDoc } from "./types";

// -----------------------------------------------------------------------------
// Web fonts for design documents. Text layers name a family; the families the
// document uses are loaded from Google Fonts or Fontshare (for the ones we
// know), then text is measured again so wrapping and hug sizes use the real
// glyphs. Unknown families fall back to whatever the browser has.
// -----------------------------------------------------------------------------

const GOOGLE: Record<string, string> = {
  Inter: "Inter:wght@100..900",
  Roboto: "Roboto:ital,wght@0,100..900;1,100..900",
  "Open Sans": "Open+Sans:ital,wght@0,300..800;1,300..800",
  Montserrat: "Montserrat:ital,wght@0,100..900;1,100..900",
  Poppins: "Poppins:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700",
  Lato: "Lato:ital,wght@0,100;0,300;0,400;0,700;0,900;1,400;1,700",
  Cairo: "Cairo:wght@200..1000",
  "Playfair Display": "Playfair+Display:ital,wght@0,400..900;1,400..900",
  Outfit: "Outfit:wght@100..900",
  "Plus Jakarta Sans": "Plus+Jakarta+Sans:ital,wght@0,200..800;1,200..800",
  "DM Sans": "DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000",
  "Space Grotesk": "Space+Grotesk:wght@300..700",
  Tajawal: "Tajawal:wght@200;300;400;500;700;800;900",
  "IBM Plex Sans Arabic": "IBM+Plex+Sans+Arabic:wght@100;200;300;400;500;600;700",
  "Material Symbols Outlined": "Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200",
};

const FONTSHARE: Record<string, string> = {
  Excon: "excon@1,2,500,700,900",
  Satoshi: "satoshi@1,2,300,400,500,700,900",
  "General Sans": "general-sans@1,2,200,300,400,500,600,700",
  Clash: "clash-display@1,2,200,300,400,500,600,700",
};

/** Families offered in the font picker (loadable ones first). */
export const WEB_FONTS = [...Object.keys(FONTSHARE), ...Object.keys(GOOGLE).filter((f) => f !== "Material Symbols Outlined")];

const loaded = new Set<string>();

function link(href: string) {
  if (typeof document === "undefined" || document.querySelector(`link[data-design-font="${href}"]`)) return;
  const el = document.createElement("link");
  el.rel = "stylesheet";
  el.href = href;
  el.dataset.designFont = href;
  document.head.appendChild(el);
}

export function familiesIn(doc: DesignDoc): string[] {
  const out = new Set<string>();
  for (const n of Object.values(doc.nodes)) if (n.text?.fontFamily) out.add(n.text.fontFamily);
  for (const s of doc.data.textStyles) out.add(s.fontFamily);
  return [...out];
}

/**
 * Loads the families a document uses. Resolves once they're ready (or after
 * a few seconds), and calls `onReady` so text can be measured again.
 */
export async function ensureFonts(families: string[], onReady?: () => void): Promise<void> {
  const fresh = families.filter((f) => !loaded.has(f) && (GOOGLE[f] || FONTSHARE[f]));
  if (!fresh.length || typeof document === "undefined") return;
  for (const f of fresh) loaded.add(f);
  const g = fresh.filter((f) => GOOGLE[f]);
  const s = fresh.filter((f) => FONTSHARE[f]);
  if (g.length) link(`https://fonts.googleapis.com/css2?${g.map((f) => `family=${GOOGLE[f]}`).join("&")}&display=block`);
  if (s.length) link(`https://api.fontshare.com/v2/css?${s.map((f) => `f[]=${FONTSHARE[f]}`).join("&")}&display=block`);
  // Ask for the faces so the browser fetches them now, not on first paint.
  const weights = [400, 700];
  const wait = Promise.allSettled(fresh.flatMap((f) => weights.map((w) => document.fonts.load(`${w} 16px "${f}"`, "aA"))));
  await Promise.race([wait, new Promise((r) => setTimeout(r, 6000))]);
  await document.fonts.ready;
  // Widths change with the real glyphs: drop cached measurements.
  setMeasure(null);
  onReady?.();
}
