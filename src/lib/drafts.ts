import { useCallback, useEffect, useReducer, useState } from "react";

// ============================================================================
// Drafts (Trello-style). Typing into a composer never writes to the server on
// its own: the text is kept as a local draft (per user's browser) until the
// person presses Save / Enter. Clicking away or closing the card keeps the
// draft; Cancel / Discard throws it away.
// ============================================================================

const PREFIX = "draft:";

export function readDraft(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function writeDraft(key: string, value: string) {
  try {
    if (value.replace(/[\s\\]/g, "") === "") localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable — draft lives in memory only */
  }
  window.dispatchEvent(new CustomEvent("draft-change", { detail: key }));
}

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("draft-change", { detail: key }));
}

/**
 * Text state backed by a stored draft.
 *   value     current text (draft if one exists, else `saved`)
 *   hasDraft  a draft exists that differs from the saved value
 *   set       update text + draft
 *   discard   drop the draft and go back to `saved`
 *   commit    drop the draft after a successful save (keeps `value`)
 */
export function useDraft(key: string, saved = "") {
  const [value, setValue] = useState(() => readDraft(key) ?? saved);

  // New key (another card/list) → load its draft.
  useEffect(() => {
    setValue(readDraft(key) ?? saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Saved value changed on the server and we have no draft → follow it.
  useEffect(() => {
    if (readDraft(key) === null) setValue(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const set = useCallback(
    (v: string) => {
      setValue(v);
      if (v === saved) clearDraft(key);
      else writeDraft(key, v);
    },
    [key, saved],
  );

  const discard = useCallback(() => {
    clearDraft(key);
    setValue(saved);
  }, [key, saved]);

  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const commit = useCallback(() => {
    clearDraft(key);
    rerender();
  }, [key]);

  const stored = readDraft(key);
  const hasDraft = stored !== null && stored !== saved;

  return { value, set, discard, commit, hasDraft };
}

/** Re-renders when any draft changes (for "has draft" badges elsewhere). */
export function useHasDraft(key: string): boolean {
  const [has, setHas] = useState(() => readDraft(key) !== null);
  useEffect(() => {
    const sync = () => setHas(readDraft(key) !== null);
    sync();
    const onChange = (e: Event) => (e as CustomEvent<string>).detail === key && sync();
    window.addEventListener("draft-change", onChange);
    return () => window.removeEventListener("draft-change", onChange);
  }, [key]);
  return has;
}
