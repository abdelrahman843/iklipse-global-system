import { lazy, type ComponentType } from "react";

// -----------------------------------------------------------------------------
// Pages loaded on first visit. Each deploy renames those files, so a tab that
// was open before a new version went live asks for files that are gone and
// the page fails to load. Then reload once (the new version comes with its
// own file names); a second failure in a row is a real error and is shown.
// -----------------------------------------------------------------------------

const KEY = "iklipse-chunk-reload";

function reloadedJustNow(): boolean {
  try {
    return Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 30_000;
  } catch {
    return true;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await load();
    } catch (e) {
      if (reloadedJustNow()) throw e;
      try {
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        throw e;
      }
      location.reload();
      // Nothing to show while the page reloads.
      return new Promise<{ default: T }>(() => undefined);
    }
  });
}
