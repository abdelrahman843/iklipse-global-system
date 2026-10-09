import { Component, type ReactNode, type RefObject } from "react";

// -----------------------------------------------------------------------------
// Exit animations for things that unmount the moment they close (modals,
// menus). Just before React removes the element, a frozen, non-interactive
// copy of it is left in the page to play the exit animation (`[data-exiting]`
// in index.css) and then removed. React has already moved on, so nothing in
// the copy can re-render, read stale data or take a click.
// -----------------------------------------------------------------------------

const EXIT_MS = 170;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export function ghostOut(node: HTMLElement | null | undefined): HTMLElement | null {
  if (!node || !node.isConnected || reducedMotion()) return null;
  const copy = node.cloneNode(true) as HTMLElement;

  // Pair the original and copy element by element (same structure right after
  // cloning) to carry over what cloning drops: scroll offsets and typed values.
  const from = [node, ...Array.from(node.querySelectorAll<HTMLElement>("*"))];
  const to = [copy, ...Array.from(copy.querySelectorAll<HTMLElement>("*"))];
  const scrolled: [HTMLElement, number, number][] = [];
  from.forEach((el, i) => {
    const c = to[i];
    if (!c) return;
    if (el.scrollTop || el.scrollLeft) scrolled.push([c, el.scrollTop, el.scrollLeft]);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      (c as HTMLInputElement).value = el.value;
    }
  });

  // Players would restart and fetch again: an empty box keeps the layout.
  copy.querySelectorAll<HTMLElement>("iframe, video, audio, object, embed").forEach((el) => {
    const box = document.createElement("div");
    box.className = el.getAttribute("class") ?? "";
    box.style.cssText = el.style.cssText;
    el.replaceWith(box);
  });
  copy.removeAttribute("id");
  copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("data-exiting", "");
  copy.inert = true;
  copy.style.pointerEvents = "none";

  node.after(copy);
  for (const [c, top, left] of scrolled) {
    c.scrollTop = top;
    c.scrollLeft = left;
  }
  window.setTimeout(() => copy.remove(), EXIT_MS);
  return copy;
}

interface Props {
  /** Whether the element is currently shown. */
  show: boolean;
  /** The element to animate out (the overlay / popover root). */
  target: RefObject<HTMLElement>;
  children: ReactNode;
}

/** Plays the exit animation of `target` when `show` turns false or this unmounts. */
export class ExitGhost extends Component<Props> {
  private ghost: HTMLElement | null = null;

  // Runs before React touches the DOM, while the element is still on screen.
  getSnapshotBeforeUpdate(prev: Props) {
    if (prev.show && !this.props.show) this.ghost = ghostOut(this.props.target.current);
    return null;
  }

  componentDidUpdate() {}

  // StrictMode (dev) unmounts and remounts once on mount: drop that ghost.
  componentDidMount() {
    this.ghost?.remove();
    this.ghost = null;
  }

  componentWillUnmount() {
    if (this.props.show) this.ghost = ghostOut(this.props.target.current);
  }

  render() {
    return this.props.children;
  }
}
