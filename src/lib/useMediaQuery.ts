import { useEffect, useState } from "react";

// Live-matching media query. Re-renders when the viewport crosses the query,
// unlike reading window.innerWidth during render.
export function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

export const useIsNarrow = () => useMediaQuery("(max-width: 639px)");
