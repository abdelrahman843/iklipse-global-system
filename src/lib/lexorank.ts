// Minimal fractional/lexicographic ranking. Compare-only characters '0'..'z'.
// This is a client-side hint; the authoritative position is computed server-side
// by the `move_card` / `reorder_list` RPCs. See supabase/migrations for the server logic.

const MIN = 32; // ' '
const MAX = 126; // '~'

function midChar(a: number, b: number) {
  return Math.floor((a + b) / 2);
}

/** Return a string strictly between `prev` and `next`. */
export function between(prev: string | null, next: string | null): string {
  const a = prev ?? "";
  const b = next ?? "";
  let i = 0;
  let out = "";
  while (true) {
    const ac = i < a.length ? a.charCodeAt(i) : MIN;
    const bc = i < b.length ? b.charCodeAt(i) : MAX + 1;
    if (bc - ac > 1) {
      out += String.fromCharCode(midChar(ac, bc));
      return out;
    }
    out += String.fromCharCode(ac);
    i += 1;
  }
}

/** Convenience — first, last, between existing neighbours. */
export const first = () => between(null, null);
export const before = (x: string) => between(null, x);
export const after = (x: string) => between(x, null);
