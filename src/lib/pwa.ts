import { useSyncExternalStore } from "react";

// -----------------------------------------------------------------------------
// Installing the app on a phone / computer (home-screen icon that opens the
// system full screen, like an app). Chrome / Edge / Android hand over an
// install prompt (`beforeinstallprompt`); it is caught here at startup, before
// React mounts, so it is never missed. iPhone / iPad Safari has no prompt: the
// person uses Share > Add to Home Screen, so the UI shows those steps instead.
// -----------------------------------------------------------------------------

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installed = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** Opened from the home screen (already running as the installed app). */
export const isStandalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). */
export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we show our own button instead of the browser's mini bar
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    emit();
  });
}

export type InstallMode = "prompt" | "ios" | null;

function mode(): InstallMode {
  if (installed || isStandalone()) return null;
  if (deferred) return "prompt";
  if (isIOS()) return "ios";
  return null;
}

/** How this device can install the app right now (null: it can't, or already did). */
export function useInstallMode(): InstallMode {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    mode,
    () => null,
  );
}

/** Shows the browser's install dialog. Resolves true when the person accepts. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  await e.prompt();
  const { outcome } = await e.userChoice;
  deferred = null;
  emit();
  return outcome === "accepted";
}
