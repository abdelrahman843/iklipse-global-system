// The brand deck's type, loaded only where a brief is shown: Prompt (light
// body), Inter Tight (stands in for Uncut Sans in the headings) and
// Instrument Serif italic (the big words on the cover and closing page).
const HREF =
  "https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Instrument+Serif:ital@0;1&family=Prompt:wght@200;300;400&display=swap";

export function loadBriefFonts() {
  if (document.querySelector(`link[data-brief-fonts]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = HREF;
  link.dataset.briefFonts = "1";
  document.head.appendChild(link);
}
