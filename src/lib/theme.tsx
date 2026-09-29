import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "theme";

interface ThemeCtx {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function readInitial(): Theme {
  // The inline script in index.html has already set data-theme before paint;
  // trust that so the provider and the DOM never disagree on first render.
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage blocked — fall through to default */
  }
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitial);
  const first = useRef(true);

  useEffect(() => {
    const root = document.documentElement;
    // Cross-fade colours on a user switch (not on first paint). The class is
    // only on for the fade so it never slows normal hovers; see index.css.
    let t: number | undefined;
    if (!first.current && root.getAttribute("data-theme") !== theme) {
      root.classList.add("theme-switching");
      t = window.setTimeout(() => root.classList.remove("theme-switching"), 400);
    }
    first.current = false;
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage blocked — theme still applies for this session */
    }
    return () => window.clearTimeout(t);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(() => setThemeState((t) => (t === "dark" ? "light" : "dark")), []);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
