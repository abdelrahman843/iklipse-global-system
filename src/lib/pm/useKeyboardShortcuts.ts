import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Global keyboard shortcuts. Text inputs are treated as focus-blocking unless
 * the shortcut is meant to work inside them.
 */
export function useGlobalShortcuts() {
  const nav = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      switch (e.key) {
        case "?":
          e.preventDefault();
          setHelpOpen(true);
          break;
        case "/":
          e.preventDefault();
          nav("/pm/search");
          break;
        case "b":
          nav("/pm/boards");
          break;
        case "m":
          if (e.shiftKey) nav("/pm/my-cards");
          break;
        case "n":
          if (e.shiftKey) nav("/pm/notifications");
          break;
        case "Escape":
          setHelpOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  return useMemo(() => ({ helpOpen, closeHelp: () => setHelpOpen(false) }), [helpOpen]);
}
