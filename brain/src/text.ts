// The words the brain sends on WhatsApp: in parts that fit, no long dashes,
// and the short line while it works. Always in English.

/** "On it.": once, when a run goes on past ~20 seconds. */
export const progressLine = (_request: string) => "On it.";

/** No em or en dashes, ever. */
export const noDashes = (t: string) => t.replace(/\s*[—–]\s*/g, ", ");

/** A long answer in parts of at most max characters: at a blank line, else a line, else a space. */
export function parts(text: string, max = 3500): string[] {
  const out: string[] = [];
  let rest = noDashes(text).trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 3) cut = window.lastIndexOf("\n");
    if (cut < max / 3) cut = window.lastIndexOf(" ");
    if (cut < max / 3) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Text that goes inside the prompt as data: it can't close or open the tags around it. */
export const asData = (t: string) => t.replace(/</g, "‹").replace(/>/g, "›");
