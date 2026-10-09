import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

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

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

// Fades running right now (a quick double toggle starts a second one).
let fading = 0;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitial);
  const current = useRef(theme);
  current.current = theme;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage blocked — theme still applies for this session */
    }
  }, [theme]);

  // A user switch cross-fades the whole screen as one picture, like the voice
  // agent site (1.2s, ease-in-out; index.css .theme-vt). The new theme and
  // icon are in place before the browser takes the "after" picture.
  const setTheme = useCallback((next: Theme) => {
    if (next === current.current) return;
    const apply = () => {
      document.documentElement.setAttribute("data-theme", next);
      current.current = next;
      flushSync(() => setThemeState(next));
    };
    const doc = document as ViewTransitionDoc;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || still) return apply();
    const root = document.documentElement;
    fading++;
    root.classList.add("theme-vt");
    doc
      .startViewTransition(apply)
      .finished.catch(() => undefined)
      .finally(() => {
        if (--fading === 0) root.classList.remove("theme-vt");
      });
  }, []);
  const toggle = useCallback(() => setTheme(current.current === "dark" ? "light" : "dark"), [setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
