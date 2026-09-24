import type { FocusEvent, MouseEvent } from "react";

// Inline composers (comments, description, add card/list/checklist…) never
// save on their own: when focus leaves them they close and keep the text as a
// draft (see drafts.ts). Only their Save / Add button or Enter writes.
//
// Focus moving to another control inside the same [data-composer] box (its own
// Save / Cancel buttons) is NOT "leaving" — the composer stays open.
export function leftComposer(e: FocusEvent<HTMLElement>): boolean {
  const box = e.currentTarget.closest("[data-composer]");
  const to = e.relatedTarget as Node | null;
  return !(box && to && box.contains(to));
}

// Put on a composer's buttons: keeps focus in the input on press, so the
// composer doesn't close (blur) before the button's own click runs. Also
// covers Safari, which never focuses buttons and so reports no relatedTarget.
export const keepFocus = (e: MouseEvent) => e.preventDefault();
