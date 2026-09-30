import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Slim bar shown while the browser is offline. Boards render from the saved
 * cache and TanStack pauses mutations until the connection is back, so say so
 * instead of letting edits look like they failed silently. Phones: a strip on
 * top of the tab bar. Desktop: bottom-right, clear of the board's centered
 * view switcher. Toasts still stack above it.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  // The live region stays mounted so screen readers announce the change.
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed z-[90] inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:inset-x-auto md:right-4 md:bottom-4 md:max-w-md pointer-events-none"
    >
      {offline && (
        <div className="pointer-events-auto border-t border-warn bg-surface overflow-hidden md:rounded-md md:border md:shadow-pop animate-slide-up">
          <div className="flex items-center gap-2 bg-warn/15 px-3 py-1.5 text-xs sm:text-sm text-ink">
            <WifiOff size={14} className="shrink-0 text-warn" aria-hidden />
            <span>You're offline. Showing your last loaded data; changes are paused.</span>
          </div>
        </div>
      )}
    </div>
  );
}
