import type { FocusEvent, MouseEvent } from "react";

// Inline composers (comments, description, add card/list/checklist…) autosave
// when focus leaves them, so typed text is never lost by clicking elsewhere.
//
// Focus moving to another control inside the same [data-composer] box (its own
// Save / Cancel buttons) is NOT "leaving" — those buttons run their own action.
export function leftComposer(e: FocusEvent<HTMLElement>): boolean {
  const box = e.currentTarget.closest("[data-composer]");
  const to = e.relatedTarget as Node | null;
  return !(box && to && box.contains(to));
}

// Put on a composer's buttons: keeps focus in the input on press, so no blur
// (and no autosave) fires ahead of the button's own click. Also covers Safari,
// which never focuses buttons and so reports no relatedTarget.
export const keepFocus = (e: MouseEvent) => e.preventDefault();
