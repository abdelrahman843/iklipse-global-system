import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/cn";

// -----------------------------------------------------------------------------
// BackButton — goes back to wherever the person came from inside the app (a
// board, My work, notifications...). Opened straight from a link or a reload
// there's no in-app page behind, so it goes to `fallback` instead of leaving
// the app. `onClick` replaces both (e.g. switching a board view back).
// -----------------------------------------------------------------------------

/** True when the browser history has an in-app page before this one. */
const hasInAppHistory = () => ((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0;

export function BackButton({
  fallback = "/",
  label = "Back",
  onClick,
  className,
}: {
  fallback?: string;
  label?: string;
  onClick?: () => void;
  className?: string;
}) {
  const nav = useNavigate();
  return (
    <button
      type="button"
      onClick={() => {
        if (onClick) onClick();
        else if (hasInAppHistory()) nav(-1);
        else nav(fallback);
      }}
      aria-label={label}
      title={`${label} (Alt+←)`}
      className={cn(
        "group/back h-10 w-10 sm:h-8 sm:w-8 shrink-0 grid place-items-center rounded-md text-muted hover:text-ink hover:bg-inset",
        className,
      )}
    >
      <ArrowLeft size={18} className="transition-transform duration-150 group-hover/back:-translate-x-0.5" />
    </button>
  );
}
