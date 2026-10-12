// -----------------------------------------------------------------------------
// The app updates itself. Nobody has to press refresh (the installed app has
// no refresh button): every minute, and whenever the app comes back to the
// screen or online, it reads <base>/version.json. A different build id means
// a new version is live, and the app reloads into it as soon as that can't
// lose anything: at once while it's in the background, otherwise when nobody
// is typing and no dialog is open. Unsent changes are safe either way (they
// wait in the outbox, offline/outbox.ts).
// -----------------------------------------------------------------------------

const CHECK_MS = 60_000;
/** The same new version is reloaded into at most once per this long (CDN lag). */
const RETRY_MS = 10 * 60_000;
const MARK = "iklipse-reloaded-for";

let waiting: string | null = null;

function busy(): boolean {
  const el = document.activeElement as HTMLElement | null;
  const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  const dialog = !!document.querySelector('[role="dialog"], [role="alertdialog"]');
  return typing || dialog;
}

function reloadedRecently(id: string): boolean {
  try {
    const m = JSON.parse(sessionStorage.getItem(MARK) ?? "null") as { id: string; at: number } | null;
    return !!m && m.id === id && Date.now() - m.at < RETRY_MS;
  } catch {
    return false;
  }
}

async function apply() {
  if (!waiting || reloadedRecently(waiting)) return;
  if (!document.hidden && busy()) return;
  try {
    sessionStorage.setItem(MARK, JSON.stringify({ id: waiting, at: Date.now() }));
  } catch {
    /* storage blocked: reload anyway */
  }
  // Fetch the new service worker too (it serves the page network first).
  await navigator.serviceWorker
    ?.getRegistration()
    .then((r) => r?.update())
    .catch(() => undefined);
  location.reload();
}

async function check() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return;
    const { id } = (await res.json()) as { id?: string };
    if (id && id !== __BUILD_ID__) waiting = id;
  } catch {
    return;
  }
  void apply();
}

export function startAutoUpdate() {
  if (!import.meta.env.PROD) return;
  window.setInterval(() => void check(), CHECK_MS);
  document.addEventListener("visibilitychange", () => void (document.hidden ? apply() : check()));
  window.addEventListener("online", () => void check());
  window.addEventListener("focus", () => void check());
  // A new version found while typing: try again once the field is left (the
  // minute's check retries after a dialog closes).
  document.addEventListener("focusout", () => window.setTimeout(() => void apply(), 1500));
  void check();
}
